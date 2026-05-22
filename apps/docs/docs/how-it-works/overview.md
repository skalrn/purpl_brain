---
sidebar_position: 1
---

# Signal Flow Overview

## End-to-end pipeline

A GitHub PR is merged. Within seconds, a webhook fires. Within five minutes, the decisions extracted from that PR are queryable via the brain. Here is every step in between.

```
┌─────────────────────────────────────────────────────────────────┐
│                         INGESTION LAYER                         │
│  GitHub  │  Slack  │  Jira/Linear  │  Meetings  │  AI Agents   │
│  webhook │ webhook │    webhook    │    API     │  write-back   │
└────────────────────────────┬────────────────────────────────────┘
                             │ events
                             ▼
                    events:raw (Redis Stream)
                             │
                             ▼
                    Normalizer Worker
                    (canonical event schema)
                             │
                             ▼
                    events:normalized (Redis Stream)
                             │
                             ▼
                    Extractor Worker
                    (rule-based Pass 1 + LLM Pass 2)
                    (link-following for embedded PR URLs)
                             │
                             ▼
                    events:extracted (Redis Stream)
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
            Brain Writer        Drift Detector
            (Neo4j + Qdrant)    (Stage A: Qdrant similarity)
                                (Stage C: LLM confirmation)
                                (writes DriftAlert nodes)
                                         │
                                         ▼
                                events:drift (Redis Stream)
                                         │
                                         ▼
                                Alert surface (UI + agents)
```

## The three Redis Streams

All inter-worker communication happens through three Redis Streams:

**`events:raw`** — raw webhook payloads, exactly as received from the source system. The normalizer reads from here.

**`events:normalized`** — canonical `CanonicalEvent` objects, source-agnostic. Every event from every source looks the same after normalization. The extractor reads from here.

**`events:extracted`** — `ExtractionResult` objects, containing the decisions, ticket refs, person mentions, and concept tags extracted from the normalized event. The brain writer and drift detector both read from here.

Each stream uses Redis consumer groups, so multiple workers can consume in parallel without duplicate processing. The `StreamWorker` base class handles consumer group management, SIGTERM-safe shutdown, and dead-letter queueing for events that fail repeatedly.

## The four workers

**Normalizer** reads from `events:raw`, maps source-specific event formats to the canonical schema, and writes to `events:normalized`. This is where GitHub's `pull_request.closed` event becomes either `pr_merged` or `pr_closed` depending on the `merged` flag.

**Extractor** reads from `events:normalized`, runs Pass 1 (regex-based entity extraction) and conditionally Pass 2 (LLM decision extraction on decision candidates). It also follows embedded GitHub PR URLs: if a document contains a URL like `https://github.com/owner/repo/pull/123`, the extractor fetches that PR's body and comment thread and enqueues it as a new raw event. This is how the 91% recall gap for linked PR discussions was closed.

**Brain Writer** reads from `events:extracted` and writes to two stores: Neo4j (graph nodes and edges) and Qdrant (vector embeddings for semantic search). Graph writes happen first — Neo4j is the source of truth. Vector writes follow; failures go to a retry queue with a maximum of 3 attempts.

**Drift Detector** reads from `events:extracted` and runs two-stage drift detection against existing confirmed decisions. Stage A uses cosine similarity via Qdrant with a threshold of 0.72. Stage C uses an LLM call to confirm candidates that pass Stage A. Confirmed drift alerts are written as `DriftAlert` nodes to Neo4j and published to `events:drift`.

## The brain store

Two stores, always in sync:

**Qdrant** holds vector embeddings for all ingested content. Each embedded chunk carries metadata linking it back to the graph node it came from (`graph_node_id`, `project_id`, `source`, `source_url`, `actor`, `timestamp`). Qdrant serves the semantic similarity queries.

**Neo4j** holds the knowledge graph. Nodes: `Event`, `Decision`, `Ticket`, `DriftAlert`, `FollowUpTask`, `Person`. Edges: `AUTHORED_BY`, `EXTRACTED_FROM`, `REFERENCES`, `CHALLENGES`, `INFORMS`, `ADDRESSES`. Neo4j serves the causal and relational queries — impact analysis, agent session lookup, temporal versioning.

## The query path

When an agent calls `brain_query`, or a human types a question into the chat UI, the query layer:

1. Embeds the raw query immediately (no LLM, parallel with intent parsing)
2. Parses query intent with Claude Haiku to determine mode and filters
3. Runs vector search in Qdrant (filter by `project_id`, top-K=10)
4. Expands candidates via Neo4j graph traversal (decision chain, author activity, ticket linkage)
5. Trims to 6,000-token context budget (exact entity matches kept, graph-expanded neighbors dropped first)
6. Generates a grounded answer with Claude Sonnet, with inline citation instructions
7. Validates that every citation `[N]` refers to a chunk actually in the context

Target latency: 2.8-4.3s for standard queries, meeting the p95 < 5s target.
