# Purpl Brain — FAQ & Rebuttal Guide

Anticipated questions from business and technical audiences, with direct answers. Organised by audience.

---

## Business Questions

---

### "Why won't Anthropic or Microsoft just build this?"

They might build something that looks similar, but they won't build this specifically — for structural reasons, not technical ones.

Anthropic cannot store your GitHub PRs, Jira tickets, and Slack messages in a central brain without creating serious antitrust and privacy exposure. Their business model is API access, not being your company's data custodian. Claude Projects pins files per user per project. It does not aggregate signals across your whole team, across tools, or across time.

Microsoft (GitHub Copilot) has the same problem plus a conflict of interest: their memory would naturally prioritise GitHub signals and would never integrate Jira, Slack, or a competitor's agent logs.

The BYOC (Bring Your Own Cloud) architecture is specifically designed around this gap. The brain runs in the customer's VPC. Anthropic/Microsoft see nothing. No provider has the incentive or the structural ability to build a cross-tool, cross-company, auditable brain. That is the moat.

---

### "How is this different from Glean?"

Glean is an enterprise search product. It indexes documents and returns keyword/semantic search results. It has no concept of:

- AI agents as write-back actors (Glean doesn't know what Claude Code decided last Tuesday)
- Drift detection (Glean doesn't flag when a new PR contradicts a past architecture decision)
- Causal reasoning (Glean can't answer "which decisions by Alice led to the tickets currently assigned to Bob?")
- Agent-native interface (Glean has no MCP tools — agents can't query it programmatically)

Glean is also $1,000+/month for a 10-person team. Purpl Brain targets the same market at $50-150/month with a BYOC option that Glean does not offer.

---

### "What happens if an AI agent logs wrong information into the brain?"

Two safeguards:

1. **The brain attributes everything to its source.** An agent log is tagged with `agent_id`, `session_id`, and `timestamp`. When queried, the citation shows "logged by claude-code on 2026-05-18". A human reviewer knows it came from an agent, not a human decision.

2. **Drift detection cuts both ways.** If an agent logs a decision that contradicts a human-established decision in a PR or Jira ticket, the brain flags it as a drift alert for human review. The agent doesn't silently overwrite human knowledge.

The brain is an audit log, not an authority. Everything is citable, attributable, and reviewable.

---

### "91% recall sounds good — what happened with the other 9%?"

One question out of twelve failed on the Backstage corpus. The missed answer was about a decision mentioned only in a comment thread inside a linked GitHub PR — not in the ADR text itself. The brain ingested the ADR but not the PR it referenced. This is a retrieval coverage gap, not a hallucination or a reasoning failure.

The fix shipped: the extractor now scans document content for embedded GitHub PR URLs and queues each linked PR for full ingestion — body and comment thread — before processing the document. A deduplication set prevents re-fetching on repeat runs. The `eval:link-following` eval verifies the mechanism end-to-end.

The 91% figure was measured before the fix. Re-running the Backstage eval with linked PR ingestion active is the next measurement milestone.

---

### "How does pricing work for the BYOC model?"

The customer deploys the brain into their own AWS account using a provided CloudFormation/CDK stack. They pay:

- AWS infrastructure costs directly (ElastiCache, ECS Fargate, storage) — estimated $50-150/month for a 10-person team
- A metered usage fee via AWS Marketplace (billed per active seat per month) — estimated $15-30/seat

No data leaves their account. The Anthropic API key is theirs. The brain is theirs. If they stop paying, they keep the data (it's in their VPC). This is the model enterprise buyers trust.

---

### "What's the risk if the project is abandoned?"

All the data is stored in the customer's own infrastructure (Qdrant and Neo4j). The snapshot/restore system allows the full brain state to be archived as a portable `.tar.gz` file. A customer can export their brain at any time and run it independently — the infrastructure (Redis, Neo4j, Qdrant) is all open-source with no proprietary lock-in.

---

### "What does 'AI agent as first-class actor' mean in practice?"

When Claude Code finishes a session where it made architectural choices, it calls `brain_log_decision` with a structured record of what it decided and why. That decision is stored in the brain with the same weight as a human decision logged from a PR or Jira ticket.

The next day, a different engineer opens Cursor on the same codebase. Before writing any code, Cursor calls `brain_query` and retrieves: "Last Tuesday, Claude Code chose Qdrant over Weaviate for vector storage because Qdrant supports payload-filtered ANN queries. See brain://agent/session-abc123."

The engineer didn't have to document it. The agent didn't have to be asked. The knowledge transferred automatically, with attribution.

---

## Technical Questions

---

### "Why not just use Postgres with pgvector?"

pgvector is a reasonable choice for simple semantic search. It becomes limiting when:

1. **Relationship traversal.** "Which decisions are connected to tickets assigned to Alice that were created after the last sprint?" is a multi-hop graph query. In Postgres, this is a self-join nightmare that degrades at scale. In Neo4j, it's a single Cypher MATCH.

2. **ANN performance at scale.** pgvector's HNSW implementation is functional but not tuned for high-throughput approximate nearest neighbour at 768+ dims. Qdrant uses a custom HNSW with configurable `ef`, `m`, and payload index co-location. At 10K+ vectors, the difference in query latency is meaningful.

3. **Payload filtering.** Qdrant's payload filters (`has_decisions=true`, `project_id=X`) run inside the ANN traversal — they don't post-filter. pgvector filters post-ANN, which means you retrieve more candidates than needed and discard them, wasting both time and the recall guarantee.

That said: for a team with < 5,000 vectors and no relational reasoning requirements, Postgres + pgvector is a perfectly valid choice. Purpl Brain's use case requires both.

---

### "Why Redis Streams instead of Kafka?"

Three reasons:

1. **Operational simplicity for self-hosted.** The target deployment is BYOC — a CloudFormation stack the customer runs in their own VPC. Kafka (even managed MSK) adds ~$100-200/month and significant operational surface. Redis is already needed for session storage. Streams is a zero-cost addition.

2. **Consumer groups.** Redis Streams consumer groups give exactly-once processing semantics per group — the same guarantee Kafka provides — without a separate schema registry or coordinator service.

3. **Volume fit.** At the target customer scale (< 10,000 events/day), Redis Streams has zero performance concern. Kafka becomes relevant at millions of events/day with strict ordering guarantees across partitions. That is not this problem.

If a customer has an existing Kafka cluster and wants to feed it into purpl-brain, the normalizer worker is the integration point — swap the XREAD call for a Kafka consumer. The downstream pipeline is source-agnostic.

---

### "Why not a single vector DB? Why add Neo4j?"

Vector DBs find semantically related content. They cannot answer:

- "What decisions has Alice made that are currently challenged by drift alerts?"
- "Which tickets are linked to the caching decisions made in the last sprint?"
- "Show me the causal chain from this Jira ticket to the Neo4j node that represents its architectural decision"

These are graph traversal queries. Storing relationship data as vector payload (a common workaround) turns every relational query into a full-scan filter — the operational equivalent of scanning a table without an index. Neo4j's Cypher executes these in milliseconds with proper indexing.

The two stores are complementary, not redundant: Qdrant finds the entry points (semantically relevant chunks), Neo4j expands from those entry points to the full context (events, people, tickets, related decisions).

---

### "How do you handle the Qdrant/Neo4j sync problem? What happens if one write succeeds and the other fails?"

The brain-writer worker writes to Qdrant first, then Neo4j. If the Neo4j write fails, the Qdrant vector exists without a corresponding graph node. On the next pipeline run (idempotent MERGE), Neo4j catches up. The Redis Stream message is only ACK'd after both writes succeed — if either fails, the message is retried.

This is eventually consistent, not strongly consistent. The window between Qdrant write and Neo4j write is typically < 100ms. In practice, query results during that window return the vector with partial context (no graph expansion), which degrades gracefully — you get the chunk text but not the full citation chain. This is acceptable for the use case.

For true strong consistency, the writes would need to be wrapped in a distributed transaction (2PC). This adds significant complexity for a failure window of < 100ms. Not worth it at current scale.

---

### "The p95 latency with Ollama is 73 seconds. That's unusable."

Correct — for interactive use. The 73s p95 was measured on a MacBook Pro M2 with `gemma2:9b` running locally with no GPU acceleration. It is not a suitable configuration for interactive queries.

The recommended path for interactive use is `LLM_PROVIDER=anthropic` with Claude Haiku, which gives ~7s average and ~12s p95. The Ollama path is intended for:

1. **Fully air-gapped environments** where no external API key is acceptable (e.g. certain defence or financial customers)
2. **Batch processing** where latency is not a constraint (overnight ingestion runs, bulk seeding)
3. **Cost-zero testing** where a developer wants to evaluate the system without an API key

For production interactive use, Anthropic (or any fast remote LLM provider) is required.

---

### "How does drift detection avoid false positives?"

Two-stage pipeline:

- **Stage A (Qdrant cosine, threshold 0.55):** Pre-filter. Only signals with cosine similarity > 0.55 against a decision-bearing chunk are passed to Stage C. Below 0.55, semantic overlap is weak enough that a contradiction is statistically unlikely.

- **Stage C (LLM binary classification):** For each Stage A candidate, the LLM is asked a direct yes/no question: "Does this new signal contradict this specific decision? Answer yes or no, then explain." A `DriftAlert` is only created on explicit LLM confirmation.

False positive rate in eval: < 8% (eval:drift-fp). This means 8 in 100 confirmed Stage C alerts turn out to be non-contradictions on manual review. The threshold is tunable via `DRIFT_SEMANTIC_THRESHOLD` env var. Lowering it reduces false positives but increases missed contradictions.

The `has_decisions=true` payload filter in Stage A is critical — without it, the cosine search runs against all vectors including PR descriptions, meeting transcripts, and Slack messages that have no decision content. That would produce an unacceptable false positive rate regardless of the threshold.

---

### "What's the data model in Neo4j? Can you show the schema?"

```
(Person {person_id, name, github_login, email})
(Event {event_id, project_id, source, source_url, raw_content, timestamp})
(Decision {decision_id, project_id, summary, rationale, confidence, status, valid_from, valid_to})
(Ticket {ref, jira_summary, jira_status, jira_assignee, jira_url})
(DriftAlert {alert_id, project_id, content, resolution, confirmed_by_llm, fingerprint})
(FollowUpTask {task_id, description, assigned_to, due_date})

(Event)-[:AUTHORED_BY]->(Person)
(Decision)-[:EXTRACTED_FROM]->(Event)
(Event)-[:REFERENCES]->(Ticket)
(DriftAlert)-[:CHALLENGES]->(Decision)
(DriftAlert)-[:TRIGGERED_BY]->(Event)
(FollowUpTask)-[:ASSIGNED_TO]->(Person)
(FollowUpTask)-[:RELATES_TO]->(Decision)
```

Unique constraints on `event_id`, `decision_id`, `alert_id`, `person_id`, `ticket_ref`. MERGE semantics in the brain-writer prevent duplicate nodes on replay.

---

### "How does the JS obfuscation hold up against a determined attacker with LLM assistance?"

Honestly: it doesn't, against a sufficiently motivated attacker with unlimited time and LLM access. The obfuscation is RC4-encrypted string arrays + hexadecimal identifier renaming — it makes the code unreadable to casual inspection and dramatically raises the effort required, but it is not cryptographic protection.

The security model for the closed-source beta is: legal (NDA) + friction (obfuscation) + speed (we ship faster than anyone can reverse-engineer). The real moat is not the code — it's the product decisions, the eval results, and the production experience. Someone who reverse-engineers the code still has to rebuild the pipeline tuning, the drift detection calibration, and the agent integration design from scratch.

---

### "Why does the MCP server use stdio for local and HTTP for remote? Why not always HTTP?"

**stdio** has zero infrastructure requirements. The MCP client (Claude Code) spawns the server as a child process. No ports, no firewall rules, no auth tokens in transit. This is the right default for local development.

**HTTP (Streamable HTTP transport)** is required when the brain is remote — running on AWS ECS in the customer's VPC while the agent runs on the developer's laptop. stdio cannot cross a network boundary. HTTP with session management via `Mcp-Session-Id` headers handles concurrent multi-agent sessions against a single remote brain instance.

The same `index.ts` handles both — `MCP_TRANSPORT=http` switches the startup path.

---

### "Why is the agent log route open (no auth) for beta?"

Deliberate decision documented in the code as a TODO. For beta:
- The brain runs locally (`localhost:3001`) — only accessible from the machine running it
- Reducing auth friction for beta testers increases the chance they actually use the write-back feature
- The API key auth that protects query and ingestion routes is still in place

Before the AWS BYOC deployment (Phase 3 M6), the agent-log route will require the same `x-api-key` auth as all other routes. It is a known, intentional, time-bounded compromise.
