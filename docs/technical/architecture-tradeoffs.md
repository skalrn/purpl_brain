# Architecture Tradeoffs

Every significant design decision in purpl-brain, with rationale and the alternatives that were considered and rejected.

---

## 1. Redis Streams vs SQS / Kafka / RabbitMQ

**Decision:** Redis Streams with consumer groups as the event pipeline (RAW → NORMALIZED → EXTRACTED).

**Why:** Redis was already required for rate limiting and idempotency tracking (`processed:event_ids`). Streams add ordered, durable, replayable event delivery with consumer group semantics — exactly what a multi-stage pipeline needs. Consumer groups handle worker restarts cleanly: pending messages are redelivered on recovery via `XAUTOCLAIM`, not lost.

**SQS:** Adds AWS dependency. No ordering guarantee within a standard queue (FIFO queues exist but add latency and cost). Visibility timeout model is harder to reason about than explicit `XACK`. Right choice for teams already AWS-native who want managed durability and dead-letter queues out of the box.

**Kafka:** Correct for 10M+ events/day and multi-consumer fan-out at scale. Massive operational overhead for a system that currently processes hundreds of events per day. Break-even is roughly 5+ pipeline stages or 100k+ events/day.

**RabbitMQ:** Strong at routing and fanout patterns. Weak at replay — messages are gone once consumed without explicit dead-letter configuration. Redis Streams replay is built-in via stream history.

**Known weakness:** If Redis goes down and the persistence snapshot (AOF/RDB) is stale, in-flight events are lost. Mitigated in production by enabling Redis persistence and by the fact that source events (GitHub webhooks, Slack events) can be re-fetched. Not mitigated in local dev — acceptable tradeoff.

---

## 2. MCP stdio transport locally vs HTTP

**Decision:** Stdio transport for local Claude Code, HTTP transport for remote/deployed brain.

**Why stdio:** Claude Code spawns the MCP server as a child process and communicates over stdin/stdout. No port binding, no auth header, no CORS. The process lifecycle is tied to the Claude Code session — server starts when Claude starts, dies when it ends. Zero configuration friction for local dev.

**HTTP:** Required for remote deployments (cloud brain, multiple users). Needs a running server, a reachable URL, and an auth token. Right for production. Unnecessary complexity for localhost dev where a port and a `Bearer` header would add friction with no security benefit.

**SSE (Server-Sent Events):** The MCP spec supports SSE as a third transport — streaming HTTP useful for long-running tool calls that push incremental results. None of the four brain tools (`brain_query`, `brain_log_decision`, `brain_analyze_impact`, `brain_log_signal`) need streaming output. SSE adds a persistent connection and reconnect logic for no benefit here.

**Known weakness:** Stdio does not multiplex. One Claude Code window = one MCP server process. Two windows share nothing at the transport level. HTTP gives you one server both windows talk to, enabling cross-session state sharing. For a single developer this is irrelevant; for a pair-programming setup it becomes a real gap.

---

## 3. Qdrant + Neo4j hybrid vs single store

**Decision:** Qdrant for semantic retrieval ("what decisions are related to this change?"), Neo4j for provenance chains ("what was decided, when was it overridden, by whom, and why?").

**Why two stores:** These questions are structurally different. Semantic similarity is a vector problem. Temporal override history with actor attribution is a graph problem. Neither store answers both well.

**Postgres + pgvector:** pgvector handles semantic search adequately at small scale. The temporal override chain — "Decision A was superseded by Decision B which was itself challenged by Signal C" — is a graph, not a relational join. Representing it in Postgres requires a self-referential adjacency table and recursive CTEs: correct but awkward to query and brittle to extend. Neo4j makes directed temporal edges a first-class pattern.

**Qdrant only:** No concept of directed edges between nodes. "Decision A overrides Decision B" with timestamps and actor attribution is not naturally representable in a vector store. You'd embed graph logic in application code — which is exactly what a graph database exists to avoid.

**Weaviate / Pinecone:** Vector-only. Same problem as Qdrant-only. Weaviate has graph-adjacent features but they are not mature for the override/provenance pattern this system needs.

**Known weakness:** Two databases means two failure modes, two backup strategies, two query surfaces. In a single-developer system this is manageable. In a multi-team deployment the operational surface is real. The break-even question: when does the graph query value justify that cost? The answer is the moment "show me the decision history for this component" or "what overrode what" becomes a product requirement — which is the core value proposition here.

---

## 4. Webhook-first ingestion vs polling

**Decision:** Webhooks as the primary ingestion path; polling (seed scripts) as backfill for historical data.

**Why:** Webhooks are real-time and push-based. A PR merged at 2pm triggers extraction at 2pm, not at the next poll interval. For drift detection to be useful *before* a change merges, ingestion latency matters. A 15-minute polling window is exactly when a conflicting decision can slip through undetected.

**Polling-first:** Simpler to implement — no public endpoint required. Works fine for retrospective analysis. Fails for the proactive use case: you want the brain current before the agent session that touches a given area, not hours later.

**EventBridge + SQS:** For AWS-native orgs, routing GitHub webhooks through EventBridge and SQS is more reliable (automatic retries, dead-letter queue, no custom deduplication needed). Worth it at org scale; over-engineered for a self-hosted brain.

**Known weakness:** Webhooks require a publicly reachable endpoint. Local dev doesn't have one by default. Mitigated by the seed scripts (historical backfill) and tools like ngrok or Cloudflare Tunnel for live webhook testing.

---

## 5. Agents write directly; humans go through the extraction pipeline

**Decision:** Agent decisions are written directly to Neo4j and Qdrant via `brain_log_decision` (structured JSON). Human signals (PRs, Slack threads, meeting transcripts) go through RAW → NORMALIZED → EXTRACTED.

**Why the distinction:** The extraction pipeline exists to find decisions in unstructured human text. Agents produce structured output because they are instructed to — running an agent-written decision record through LLM extraction would be noise-on-noise: asking a model to extract decisions from a JSON object that already *is* a decision record.

**Uniform pipeline for all sources:** Simpler architecture, single write path. The cost: you'd lose the structured fields agents provide (alternatives_considered, confidence, rationale as a separate field) by flattening everything into raw text before re-extracting it. Fidelity loss is not worth the architectural simplicity.

**Known weakness:** The agent's structured write is only as good as the agent's judgment about what constitutes a decision worth logging. An implicit decision in a human PR comment ("let's not do X because Y") may be caught by the extractor; an agent might not surface it unless explicitly prompted. This is why CLAUDE.md protocol and the Stop hook both exist — the instruction shapes in-session behavior, the hook enforces the boundary.

---

## 6. Stop hook + CLAUDE.md instructions — why both

**Decision:** CLAUDE.md instructs agents to log decisions at the moment they are made. The Stop hook checks at session close and blocks exit if nothing was logged in the last two hours.

**CLAUDE.md only:** Instructions are aspirational. Under context pressure (long sessions, complex tasks, context compaction), the agent deprioritizes logging. Without the hook, a meaningful fraction of sessions end without any decision logs even when CLAUDE.md is active.

**Hook only:** The Stop hook fires at session close. A decision made three hours into a four-hour session that gets compacted before the close is unrecoverable — the hook fires, the session logs something to pass the check, but the specific mid-session decisions are already gone. The instruction shapes in-session behavior; the hook catches the close.

**Known weakness:** The hook checks for *any* decision logged in the last two hours. A session that logged one trivial decision and missed four significant ones passes the check. The hook enforces presence, not quality or completeness. Enforcing quality would require an LLM call inside the hook to assess the logged decisions — which is slow and introduces a flaky hard gate. Acceptable tradeoff: presence enforcement is better than nothing; quality depends on CLAUDE.md instruction discipline.

---

## 7. Two-stage drift detection (Qdrant → LLM)

**Decision:** Stage A — Qdrant semantic similarity retrieves top-k candidate past decisions. Stage C — LLM confirms whether a real conflict exists. `DriftAlert` is written only when the LLM confirms.

**Why two stages:** Semantic similarity alone has a high false-positive rate for drift. "We chose Redis" and "We chose Postgres" have similar embeddings (both are database decisions) but are not necessarily in conflict — "Redis for caching, Postgres for primary storage" is fine; "Redis instead of Postgres for primary storage" is a conflict. The LLM has the context to distinguish these.

**LLM-only (no Qdrant pre-filter):** Running every new decision against every past decision via LLM is O(n) LLM calls per ingested event. At 1,000 decisions in the graph, that is 1,000 calls per new decision. Qdrant narrows it to 5–10 candidates before the LLM sees any of them.

**Rule-based conflict detection:** Fast and cheap. Cannot handle paraphrase, indirect contradiction, or domain-specific conflict reasoning. Would require a manually maintained ontology of conflict patterns. Not viable for general-purpose decision memory.

**Known weakness:** Stage A (Qdrant) can miss conflicts that are conceptually related but phrased differently — "don't use async" vs "all handlers must be synchronous" may not have high embedding similarity depending on the surrounding context. The embedding model quality is the ceiling for Stage A recall.

---

## 8. Decision as the unit of memory

**Decision:** The stored unit is a structured decision record: choice + rationale + alternatives considered + confidence + actor + timestamp. Not a document, not a session transcript.

**Session transcripts:** High recall, low precision. Every word the agent said is in there. Retrieval is expensive and noisy. Signal-to-noise degrades with session length. You'd need extraction on retrieval (not just on ingestion), which doubles LLM costs.

**Documents (ADRs, runbooks):** Correct for decisions significant enough to warrant formal treatment. The gap this system fills is exactly the decisions that did not make it into a document — the ones that clear the implementation threshold but not the ADR threshold. Storing documents doesn't solve the informal decision gap.

**Known weakness:** The decision schema has opinions baked in. Decisions that don't fit the `description + rationale + alternatives_considered + confidence` shape — emergent constraints discovered mid-session, implicit rejections, discovered dependencies — get forced into the schema with some fidelity loss. The `brain_log_signal` tool exists as a safety valve for things that don't cleanly fit the decision shape.

---

## 9. project_id as tenant isolation

**Decision:** All nodes in Neo4j and all points in Qdrant carry a `project_id` field. Every query, write, and drift check is scoped by project_id at the service layer.

**Separate collections/databases per project:** Schema overhead and operational complexity scale with the number of projects. A separate Qdrant collection per project means separate index tuning, separate backup configs, separate connection strings. project_id as a filter is simpler and sufficient for the current scale.

**Row-level security in Postgres:** Mature, well-understood. Would require migrating off Qdrant and Neo4j — losing the vector and graph capabilities that justify the hybrid architecture in the first place.

**Known weakness:** A bug in any query that omits the project_id filter bleeds data across projects. This has happened in practice (Stop hook logging decisions to the wrong project_id when it fired from a different repository). Mitigated by enforcing project_id as a required parameter at the service method level, never as an optional filter. Any query that doesn't take a project_id parameter is a code smell.

---

## 10. LLM extraction vs rule-based extraction

**Decision:** Use an LLM (qwen2.5:7b locally, Claude API in production) to extract decisions from raw event text.

**Why:** Decision language is not patterned. "Let's go with X" and "We decided against Y because Z" and "I'm closing this in favor of the simpler approach" are all decision signals. No regex or keyword list captures the full surface. The LLM understands context and intent.

**Rule-based / keyword extraction:** Fast and cheap. Works for explicit decision language ("DECISION:", "ADR:"). Fails for implicit decisions, soft rejections, and emergent constraints — which are the majority of the signal this system exists to capture.

**Fine-tuned classifier:** Better precision than a general LLM, cheaper per call. Requires a labeled training dataset. The labeled dataset problem is harder than the extraction problem — you'd need to define what counts as a decision across diverse source types before you can train on it. General LLM extraction bootstraps this without labeled data.

**Known weakness:** LLM extraction introduces latency (30–60s per event on Ollama) and a non-deterministic quality floor. Two extractions of the same PR can produce different decision counts depending on model temperature and context. Mitigated by prompt design (structured JSON output, fallback retry on parse failure) but not eliminated.
