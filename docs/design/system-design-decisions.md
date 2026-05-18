# System Design Decisions

## Executive Summary

Software teams have an institutional memory problem. Pull requests reference Slack threads that reference Jira tickets that reference a decision made in a standup three months ago. Engineers joining mid-project reconstruct context from commit messages and stale wikis. AI agents introduced to automate parts of the workflow have no memory at all — each invocation starts from zero.

Purpl Brain is a shared working memory for human-agent software teams. It ingests signals from every surface a team uses (GitHub, Slack, Jira, meetings, documents, AI agent sessions), maintains a continuously updated knowledge graph, and serves context to humans and agents via a natural language query interface with citations grounded to source URLs and timestamps.

The core product bet: if every signal — commit, message, ticket update, meeting decision, and agent action — flows into a single queryable brain, then context becomes a first-class resource rather than tribal knowledge. The secondary bet: AI agents must be first-class actors in this system, both reading context and writing back their own decision trails, or the brain becomes irrelevant as automation increases.

---

## Phase-by-Phase Business Decisions

### Phase 1 — GitHub Only (Complete)

The decision to start with GitHub-only ingestion was deliberate. GitHub is the highest-signal, lowest-noise source for software teams. Every commit, PR, and review comment has structure, timestamps, and actor attribution. It gave us a chance to prove the ingestion pipeline, brain store, and query layer end-to-end before dealing with the messier formats of Slack and Jira.

The exit criterion was strict: a natural language query about a PR must return a correctly cited answer grounded to an actual commit or PR event. This forced the full pipeline to be wired before moving on.

### Phase 2 — Multi-Source Expansion (Complete)

Adding Slack, Jira, and drift detection in one phase was a deliberate bundling decision. These three are interdependent from a product perspective: a drift alert is only useful if it can surface the Jira ticket that created the commitment and the Slack thread where the team agreed to it. Building all three together meant the first cross-source query was possible at the end of Phase 2 rather than Phase 3.

The MCP server was added in Phase 2 rather than Phase 3 because of a strategic realization: agent clients (Cursor, Claude, Copilot) are already in use at our target customers. Shipping the MCP interface early means those agents can read from the brain immediately, which validates the query layer under real agent traffic before we invested in agent write-back.

### Phase 3 — Agent Write-Back and Identity (Complete)

Agent write-back (`POST /brain/agent-log`) was the proof point for the "AI agents as first-class actors" bet. The design decision here was to route agent logs through the same ingestion pipeline as human signals — not a separate path. This means agent decisions are queryable with the same interface, appear in the same graph, and can trigger the same drift detection as human decisions. The alternative (a separate agent log store) would have created a second brain that humans and agents couldn't query together.

Identity resolution was the prerequisite for @mention autocomplete and for the cross-source query "what has Alice worked on" to return results from GitHub, Slack, and Jira. It was deferred to Phase 3 because it required knowing all source schemas first.

### Phase 4 — Document Brain and Cross-Product Graph (In Progress)

The Phase 4 scope decision — document ingestion plus cross-product graph — came from the ICP (ideal customer profile) analysis. AI-forward startups and platform engineering teams at mid-size companies both have a specific pain: design decisions live in Notion docs and Confluence pages that are invisible to the query layer. A query like "what does the auth service ADR say about token expiry?" should return an answer regardless of whether the information came from a GitHub PR comment, a Jira ticket, or a Notion page.

The exit criterion for Phase 4: "A specialist queries: show me all auth-related decisions across my projects, including anything in design docs or meeting notes." This is a cross-product, cross-source, cross-format query that requires every Phase 4 milestone to be complete.

---

## Technical Decisions and Trade-offs

### Hybrid Brain Store: Qdrant + Neo4j

The most consequential architectural decision was the choice of brain store. A relational database was eliminated early — the query "what decisions led to this PR breaking production" is a graph traversal, and expressing it in SQL requires recursive CTEs that are painful to write and optimize.

The choice came down to three options:

1. **Vector DB only (Qdrant)**: Fast semantic retrieval, no relational structure. Cannot answer "which PR blocked which deployment" without storing graph structure as metadata.
2. **Graph DB only (Neo4j)**: Rich traversal, but graph search for semantic similarity requires separate indexing. Every semantic query would be a full-text scan.
3. **Hybrid (Qdrant + Neo4j)**: Vector DB for semantic retrieval, graph DB for causal/relational reasoning. More operational complexity, but both query types become natural.

The hybrid approach won. The query engine uses Qdrant for the initial semantic retrieval (top-k relevant chunks), then expands through Neo4j to pull in causally related nodes (e.g., the decisions that led to the PR, the Slack thread that preceded the Jira ticket). Both databases are written to atomically in the brain-writer worker.

### Kuzu to Neo4j Migration

The original architecture specified Kuzu, an embedded graph database with zero operational overhead (runs in-process, stores to disk). Kuzu was appealing for development — no Docker container, no connection management. It was dropped for three reasons:

1. **Persistence across restarts**: Kuzu's storage model caused data loss in the containerized deployment environment during early testing.
2. **Cypher compatibility**: Kuzu implements a subset of Cypher. APOC procedures needed for temporal queries (specifically `apoc.date.parse` and `apoc.path.expand`) are not available.
3. **Community and debugging**: Neo4j has a mature browser UI, a large community, and extensive documentation for the Cypher queries we needed. Debugging graph traversals in Kuzu required writing custom inspection code.

The migration cost was one day of work — the Cypher queries were mostly compatible, and the Neo4j driver API is stable.

### Redis Streams over Kafka or RabbitMQ

The ingestion pipeline is event-driven: webhooks fire and forget to Redis Streams, workers consume and acknowledge. The stream queue options were Kafka, RabbitMQ, and Redis Streams.

**Kafka** was eliminated because it is operationally heavy (ZooKeeper or KRaft, broker management, topic partitioning) for a system that, at Phase 1-4 scale, processes at most hundreds of events per day. The producer throughput guarantees Kafka provides are irrelevant at this scale.

**RabbitMQ** was eliminated because it lacks stream replay. If a worker crashes mid-processing, RabbitMQ's default queue behavior means the message is requeued, but you cannot replay a historical window for re-extraction after a schema change. Redis Streams consumer groups provide acknowledgment semantics (unacknowledged messages are redeliverable) and the stream itself is an append-only log that can be replayed from any offset.

**Redis Streams** won because Redis was already in the stack for session management and query result caching. Adding a second infrastructure component for message queuing when Redis already provides what we need is an unnecessary operational burden.

### Query Result Caching Architecture

The caching decision was made during Phase 4 when query latency became observable under light load. The options were:

1. **No caching**: Every query hits Qdrant + Neo4j + LLM. Median latency ~3-5 seconds. Unacceptable for interactive chat.
2. **In-memory cache (Node.js Map)**: Zero infrastructure, but evicted on restart. Not shared across API instances.
3. **Redis (allkeys-lru, 512MB cap, 15-min TTL)**: Shared across instances, survives restarts, configurable eviction, already in stack.
4. **Memcached**: No persistence, no pub/sub, no sorted sets. Redis already deployed — switching buys nothing.

Redis won. The cache key is SHA-256 of the normalized query string. Query results are serialized as JSON. The embedding cache (separate key namespace) uses a 1-hour TTL because embeddings are deterministic — the same text always produces the same vector, so there is no staleness risk and the longer TTL significantly reduces Ollama/Anthropic API calls during repeated processing of the same documents.

### @Mention Autocomplete: Filter vs. Expansion

The @mention autocomplete design had two candidate approaches:

1. **Cosmetic expansion**: @alice.chen is expanded to the full display name before the query. The query runs as if the user had typed "alice chen" — relying on semantic similarity to find relevant chunks.
2. **Person-scoped filter**: @alice.chen is resolved to a `person_id` UUID. The Qdrant query adds a `must` filter on `actor_person_id`. Only chunks authored by or explicitly mentioning Alice are returned.

The cosmetic expansion approach fails when Alice has written under multiple names across sources (alice.chen on GitHub, Alice C. in Slack, alice@company.com in Jira). Semantic similarity on "alice chen" returns chunks that mention Alice but not necessarily ones she authored.

The person-scoped filter approach requires UUID identity to be solid — if two Person nodes exist for the same human, the filter misses half her contributions. This is why the UUID identity fix was treated as a hard prerequisite for @mention. With `resolveOrCreateActorPerson` correctly merging by GitHub login, email alias, and display key, the person-scoped filter approach is reliable. Disambiguation (when two people share a first name) uses project-scoped lookup first, then shows email domain in the autocomplete dropdown.

### UUID Identity Fix

Before the fix, Person nodes were being created by two separate code paths with different merge keys:

- `brain-writer.ts` merged on `{id: github_login}` for GitHub events
- `auth.ts` merged on `{email: email}` for OAuth logins

The result was shadow duplicates: one Person node for each GitHub login, one for each OAuth email. The same engineer could have two or three Person nodes with no edges between them. Cross-source queries for "what has Alice worked on" would miss anything authored under her alternate node.

The fix introduced `resolveOrCreateActorPerson` in `neo4j.ts` with three strategies by source:

- **GitHub**: merge on `github_login` property (stable, unique per GitHub account)
- **Slack/Jira**: check alias table first, then fall back to email, then create stub
- **Meetings/Agents**: create a stub node keyed on `display_key` (normalized display name)

`actor_person_id` (the UUID of the resolved Person node) is now stored in every Qdrant payload, and every `AUTHORED_BY` edge in Neo4j uses the canonical `person_id`. This makes person-scoped queries consistent across sources.

### Two-Pass Entity Extraction

LLM calls are the most expensive operation in the pipeline. Running GPT-4 or Claude on every raw event would make the system economically unviable at scale. The two-pass extraction architecture keeps costs manageable:

- **Pass 1 (rule-based)**: Regex patterns and keyword lists scan the normalized event. Events with decision-candidate signals (phrases like "decided to", "we will", "agreed on", "going with X over Y") are flagged. This pass runs in microseconds.
- **Pass 2 (LLM)**: Only flagged events are sent to the LLM for structured entity extraction. The LLM extracts decision nodes, rationale, alternatives considered, and actor attribution.

In practice, roughly 10-15% of events pass the rule-based filter, reducing LLM calls by ~85%. The LLM call itself uses prompt caching — the system prompt (extraction schema, instructions) is cached with a 1-hour TTL. Only the event text is injected per call.

### Event-Driven Ingestion with Webhook-First Design

The ingestion API returns 200 immediately and enqueues the event to Redis Streams. Processing (normalization, extraction, brain write) happens asynchronously. This decouples receipt latency (must be fast — GitHub has a 10-second webhook timeout) from processing latency (can be seconds to minutes depending on LLM queue depth).

The trade-off is that a query immediately after an event may not yet see that event reflected in the brain. This is an acceptable consistency model for the use case — nobody queries the brain within seconds of a commit being pushed. The latency SLA is "brain reflects reality within 60 seconds of a webhook delivery."

### LLM Prompt Caching

Every Anthropic SDK call in the codebase applies prompt caching. The pattern enforced is:

- System prompt is a list of blocks, not a plain string. The last block carries `cache_control: {type: "ephemeral"}`.
- Dynamic context (retrieved docs, graph snapshots) is injected as a user message, not interpolated into the system prompt. This keeps the system prompt prefix stable across calls.
- Tool definitions are sorted deterministically by name. Adding or removing tools per-request would break the cache prefix.
- For session-scoped context, a second `cache_control` breakpoint is added at the end of the context block in the first user message.

Caching is verified by checking `response.usage.cache_read_input_tokens > 0` on repeated calls. If it is zero, there is a silent cache invalidator — usually a timestamp or UUID that was accidentally interpolated into the system prompt.

---

## Summary of Key Trade-offs

| Decision | What we chose | What we rejected | Why |
|---|---|---|---|
| Brain store | Qdrant + Neo4j | Relational DB, vector-only | Graph traversal for causal queries; semantic retrieval for NL queries |
| Graph DB | Neo4j | Kuzu | Persistence, APOC, Cypher completeness |
| Message queue | Redis Streams | Kafka, RabbitMQ | Already in stack, stream replay, acknowledgment semantics |
| Query cache | Redis | In-memory, Memcached | Shared across instances, already in stack |
| @mention | Person-scoped filter | Cosmetic expansion | Handles multi-identity correctly |
| Extraction | Two-pass hybrid | LLM-only | Cost control; rule-based pre-filter reduces LLM calls ~85% |
| Ingestion | Webhook-first async | Synchronous | Decouples receipt latency from processing latency |
| Prompt caching | System prompt blocks + 1hr TTL for pipelines | Plain string system prompt | Cache hit rate; prevents per-call invalidation |
