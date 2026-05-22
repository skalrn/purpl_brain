---
sidebar_position: 3
---

# The Brain Store

## Why two stores

The brain needs to serve two fundamentally different query patterns. Semantic queries — "find decisions related to authentication" — require vector similarity search across embedded content. Causal queries — "what does this PR change affect downstream?" — require graph traversal over typed edges.

No single database does both well at production scale. A pure vector store like Pinecone cannot traverse `CHALLENGES` or `AFFECTS` edges. A pure graph database can add a vector index (Neo4j has one), but the performance and flexibility of a dedicated vector store for high-throughput similarity queries is meaningfully better.

The solution is two stores kept in sync:

**Qdrant** handles semantic retrieval. Every ingested chunk gets embedded and written here. Each chunk payload carries `graph_node_id` linking it back to the Neo4j node it came from. Qdrant serves the semantic similarity stage of every query.

**Neo4j** handles the knowledge graph. Every decision, event, person, ticket, and drift alert is a node. The relationships between them — who authored what, what references what, which decision challenges which other decision — are typed edges. Neo4j serves graph expansion, impact analysis, temporal versioning, and agent session lookup.

## What gets stored in Neo4j

Node labels and their primary use:

| Node | Primary key | What it represents |
|---|---|---|
| `Event` | `event_id` | A raw ingested signal (PR, Slack message, agent log) |
| `Decision` | `decision_id` | An extracted concluded choice with rationale |
| `Ticket` | ticket ref | A Jira/Linear ticket |
| `PullRequest` | PR ref | A GitHub PR |
| `Person` | `person_id` | A human or agent actor |
| `DriftAlert` | `alert_id` | A detected contradiction |
| `FollowUpTask` | `task_id` | A task generated from a resolved drift alert |
| `Concept` | concept name | A technology, domain, or system concept |

Edge types:

- `AUTHORED_BY` — Event to Person
- `EXTRACTED_FROM` — Decision to Event (the event where the decision was found)
- `REFERENCES` — Event to Ticket, Event to PR, PR to Issue
- `CHALLENGES` — Decision to Decision (contradiction relationship)
- `IMPLEMENTS` — PR to Ticket
- `SUPERSEDES` — Decision to Decision (when a decision replaces a prior one)
- `AFFECTS` — Decision/Event to Concept/Codebase (what does this touch)
- `TAGGED_WITH` — Event/Decision to Concept
- `MEMBER_OF` — Person to Project

## The Decision node schema

The most important node type. Every field matters:

```
decision_id:             string    — unique, kebab-case slug
quoted_text:             string    — exact quote from the source that supports this decision
summary:                 string    — one-sentence description of what was decided
rationale:               string    — why (null if not stated — never inferred)
alternatives_considered: string[]  — what else was evaluated
confidence:              "high" | "medium" | "low"
decision_maker:          string    — who announced or made the decision
scope:                   string    — what this applies to (module, service, team)
reversible:              boolean   — false = final, true = tentative
valid_from:              string    — ISO 8601, when this decision became active
valid_to:                string    — ISO 8601, null if currently active
status:                  string    — "active" | "superseded" | "under_review"
```

The `alternatives_considered` field is what makes drift detection work for agent-sourced decisions. If an agent explicitly rejected "long-lived tokens" as an alternative, and a human later decides to use them, semantic similarity alone may miss this (the phrasing is different). The structured alternatives list makes it a deterministic lookup instead of a probabilistic one.

The `valid_from` / `valid_to` bi-temporal model allows point-in-time queries: "what was the decision on this topic as of last Tuesday?" The current decision is always the one with `valid_to IS NULL`.

## Temporal versioning

When a decision is superseded, the system does not overwrite the old node. Instead:

1. The old node gets `valid_to = now`
2. A new node is created with `valid_from = now`
3. A `SUPERSEDES` edge is created from the new node to the old one

This means every decision ever made is queryable. You can ask "show me the history of the caching decision" and get the full chain, with timestamps and rationales at each step.

## The write order

Graph writes happen before vector writes. Neo4j is the source of truth. If the Neo4j write succeeds and the Qdrant write fails, the event goes into a retry queue (`retry:qdrant_writes`) with a maximum of 3 attempts. A background retry job re-embeds and re-writes failed chunks.

The reverse case — Qdrant write succeeds but Neo4j write fails — is not possible because Neo4j is written first. If the Neo4j write fails, the worker does not proceed to Qdrant, and the event remains in the Redis Stream for retry.

The crash-safe pattern for the Qdrant retry queue uses two keys: `retry:qdrant_writes` (items waiting to be retried) and `retry:qdrant_processing` (items currently being retried). On startup, any items in `retry:qdrant_processing` are moved back to `retry:qdrant_writes` — they were being processed when the worker crashed and need to retry.

## Uniqueness constraints

Every primary key in Neo4j has a uniqueness constraint. This prevents duplicate nodes when the same event is processed twice (which can happen if a worker crashes after writing to the graph but before acknowledging the stream message).

Key constraints enforced:
- `Event.event_id`
- `Decision.decision_id`
- `Person.person_id`
- `DriftAlert.alert_id`

Without these constraints, network retries or crash recovery can create duplicate nodes that cause incorrect query results.
