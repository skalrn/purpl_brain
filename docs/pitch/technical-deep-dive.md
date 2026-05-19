# Purpl Brain — Technical Deep Dive

**Audience:** Senior engineers, CTOs, principal architects  
**Status:** Phase 3 in progress (M1–M4 complete, M5–M6 in progress)  
**Last updated:** 2026-05-18

---

## What This System Does

Purpl Brain is a shared working memory for human-agent software teams. It ingests signals from GitHub, Slack, Jira, meetings, local docs, and AI agent sessions. It extracts structured decisions using LLMs, stores them in a hybrid vector + graph store, detects when new signals contradict existing decisions, and answers natural language queries with grounded citations.

The core architectural insight: AI agents are first-class actors that both read from and write to the brain. Agent decision trails are ingested alongside human-generated signals — not as logs, but as structured decision nodes with the same schema as human decisions.

---

## Full Pipeline

```
Signal sources → webhook/seed → Redis Streams (events:raw)
  → normalizer worker → Redis Streams (events:normalized)
  → extractor worker → Redis Streams (events:extracted)
  → brain-writer worker → Neo4j + Qdrant
  → drift-detector worker → DriftAlert nodes in Neo4j

Agent session → POST /brain/agent-log → bypass normalizer + extractor → events:extracted
  (agent logs are pre-structured — LLM extraction of agent output would introduce
   hallucination risk and waste tokens on content the agent already knows)

Query → POST /brain/query → embed query → Qdrant ANN search (has_decisions=true filter)
  → expand context via Neo4j graph traversal → LLM answer with citations
```

Three independent worker processes (normalizer, extractor, brain-writer) consume from Redis Streams consumer groups. Each stage can fail and restart without affecting the others. A worker crash mid-processing results in message redelivery via Redis XAUTOCLAIM — no message loss.

---

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | Node.js 20, TypeScript, ESM | Strong async I/O primitives; type-safe across pipeline |
| API | Fastify 4 | Schema-based request validation; lower overhead than Express |
| Queue | Redis Streams | Single dependency, consumer groups, exactly-once per group |
| Vector DB | Qdrant (self-hosted) | HNSW-tunable ANN, payload filtering, snapshot/restore |
| Graph DB | Neo4j 5 Community + APOC | Cypher, native graph traversal, constraint enforcement |
| LLM | Claude Haiku (extraction/query) | Fast, cheap, strong JSON extraction |
| Embeddings | text-embedding-3-small @ 768 dims | OpenAI path; nomic-embed-text:v1.5 (Ollama local path) |
| MCP | @modelcontextprotocol/sdk | stdio (local), HTTP Streamable (remote/AWS) |
| Frontend | Next.js 15 standalone | SSE streaming responses |
| Deploy | Docker Compose → Docker images → GHCR | Local/beta; AWS ECS target (Phase 3 M6) |

---

## ADR-001: Hybrid Brain Store (Qdrant + Neo4j)

### The question every architect asks: why two databases?

The decision record is clear: neither database alone can serve both retrieval modes the query layer requires.

**Vector-only (Qdrant/Pinecone/Weaviate alone) fails at:**
- Causal/relational queries: "Which decisions made by Alice affected tickets assigned to Bob?" — there is no cosine similarity operation that traverses an ownership relationship across two entity types.
- Temporal reasoning: "What changed between the May sprint and June sprint?" — vector search returns semantic neighbors, not time-ordered events.
- Relationship modeling: storing graph structure as payload (e.g., `{"author_id": "alice", "referenced_tickets": [...]}`) and querying via filters is not graph traversal — it is filtered lookup with quadratic complexity on multi-hop joins.

**Graph-only (Neo4j alone) fails at:**
- Semantic retrieval: "What decisions relate to caching?" requires embedding-based search, not exact keyword match or Cypher MATCH. A full-text index (Lucene-backed in Neo4j) is a partial solution but requires exact or fuzzy string matches — it does not understand that "memoization" and "caching" are semantically related.
- Operational cost: adding a full-text index for semantic search brings the same operational cost as adding Qdrant, without the ANN performance, payload filtering, or snapshot tooling Qdrant provides.

**The combination:**
1. Qdrant handles semantic "find related" — embed query → ANN search → top-K document chunks
2. Neo4j handles "expand context, follow relationships" — take the event_ids from Qdrant results → graph traversal to retrieve full Event + Decision + Person + Ticket subgraph
3. LLM receives rich structured context with citations attached to graph nodes, not to floating chunks

This is RAG + graph traversal, not pure RAG.

### Why not Postgres + pgvector?

This is the most common pushback. Honest answer: pgvector is a reasonable choice if you prioritize operational simplicity and are comfortable with its limitations.

Where pgvector falls short for this use case:
- **ANN performance:** pgvector uses IVFFlat by default, which requires a training step and produces lower recall than HNSW at the same latency. Qdrant ships HNSW natively with exposed tuning parameters (`m`, `ef_construction`, `ef`). At 10,000+ vectors this matters; at 1,000 it probably does not.
- **Payload filtering:** Qdrant supports pre-filtering on arbitrary payload fields during ANN search — the `has_decisions=true` filter is applied inside the ANN index, not as a post-filter. Postgres applies the WHERE clause after the ANN scan, which degrades recall on filtered queries when the filter is selective.
- **Graph queries:** Postgres recursive CTEs approximate graph traversal but are not native graph queries. For multi-hop relationship queries (DriftAlert → challenges → Decision → extracted_from → Event → authored_by → Person), Cypher on Neo4j is both more expressive and faster.
- **Operational isolation:** Qdrant and Neo4j are independently snapshotted and restored. A Postgres migration that touches both relational and vector data simultaneously raises rollback complexity.

pgvector is the right call for teams that already operate Postgres and have shallow graph requirements. For a system whose primary value is multi-hop relational reasoning across decisions, pgvector does not eliminate Neo4j — it only replaces Qdrant, at the cost of ANN tuning and filter-inside-index support.

### Why not Weaviate?

Weaviate has hybrid search (keyword + vector) built in and is a reasonable alternative. Three reasons it was not chosen:
1. Graph capabilities are weaker than Neo4j. Weaviate cross-references are property-level links, not first-class edges with typed relationships and Cypher-expressible traversal.
2. Self-hosted Weaviate is heavier operationally than Qdrant for teams running on a single host.
3. Neo4j + APOC provides temporal reasoning (date filters, path-finding with time constraints) that Weaviate does not.

---

## ADR-003: Event-Driven Ingestion (Redis Streams)

### Three-stage pipeline design

Each stage is isolated because the failure modes are different:

| Stage | Worker | Operation | Failure mode |
|---|---|---|---|
| RAW → NORMALIZED | normalizer | Schema normalization of heterogeneous webhooks | Deterministic — no external calls. Fails fast on malformed input. |
| NORMALIZED → EXTRACTED | extractor | LLM extraction of decisions, entities | Non-deterministic, rate-limited. Should not block normalizer. |
| EXTRACTED → BRAIN | brain-writer | Neo4j MERGE + Qdrant upsert | DB write failures should not block extraction queue. |

Separating stages means an LLM API rate limit does not cause webhook drops. The normalizer continues consuming and writing to `events:normalized`. The extractor processes at its own rate (honoring API rate limits). On restart, Redis consumer group XAUTOCLAIM redelivers unacknowledged messages with no data loss.

### Why Redis Streams over Kafka?

Kafka is the operationally correct answer for systems at 100,000+ events/day that need multi-consumer fan-out, schema registry, and cross-datacenter replication.

For self-hosted deployments targeting < 10,000 events/day per team:
- Kafka requires Zookeeper (or KRaft), a schema registry, dedicated topic configuration, and ongoing ops. Redis Streams adds no new dependency — Redis is already present for session storage.
- Redis Streams consumer groups provide the same semantics needed: delivery guarantees per consumer group, XACK for message acknowledgment, XAUTOCLAIM for crash recovery.
- Operational simplicity is a product constraint, not an engineering shortcut. The BYOC deployment model (self-hosted Docker Compose) means every additional service is a customer support burden.

At the scale target where Kafka's advantages become relevant, the architecture graduates to a managed queue (AWS SQS or MSK), not a self-hosted Kafka cluster.

---

## ADR-002: MCP Server Interface

### Why MCP instead of REST for agents?

The question usually frames this as: "agents can call REST — why add an abstraction?"

The answer is operational, not technical. MCP is an emerging standard for agent tool interfaces, published by Anthropic and adopted by Claude Code, Cursor, Windsurf, and other agent runtimes. A bespoke REST SDK requires maintaining a separate integration with every agent runtime — auth handling, error formatting, schema documentation — for each one.

MCP gives zero-friction integration:

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["/path/to/purpl_brain/apps/mcp/dist/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3001",
        "BRAIN_API_KEY": "your-api-key"
      }
    }
  }
}
```

The four exposed tools:

| Tool | Description |
|---|---|
| `brain_query(query, project_id)` | Semantic + graph query → cited answer |
| `brain_log_decision(project_id, session_id, decisions[], ...)` | Write agent decisions into the brain |
| `brain_analyze_impact(change_description, project_id)` | Risk assessment before a change |
| `brain_log_signal(text, project_id, source)` | Report a finding that may contradict existing decisions |

**Transport:** stdio (local, no network dependency, works behind corporate firewalls). HTTP Streamable transport for remote/cloud-hosted deployments (Phase 3 M6).

**Bug found and fixed during Phase 3 M1:** The StreamableHTTP transport assigns a session ID during `handleRequest()`, not before it. The original code called `sessions.set()` before `handleRequest()`, so the session ID was set to an empty string on every request — every `notifications/initialized` message returned "Server not initialized." Fixed by registering the session after `handleRequest()` resolves.

---

## ADR-004: Agent Decision Trails

### Why agent logs bypass the LLM extractor

The normalizer and extractor exist to convert unstructured human-generated content (PR descriptions, Slack messages, Jira comments) into structured decision objects. Agent sessions already produce structured `ExtractionResult` objects — they know their own decisions.

Running agent output through the LLM extractor:
- Wastes tokens extracting content the agent already structured
- Introduces hallucination risk (the LLM could misrepresent an agent's stated rationale)
- Adds 1–3 seconds of latency per agent log write

Agent logs write directly to `events:extracted` with a fixed schema:

```json
{
  "schema_version": "1.0",
  "session_id": "uuid",
  "agent_id": "claude-code",
  "project_id": "my_project",
  "timestamp_start": "2026-05-18T10:00:00Z",
  "timestamp_end": "2026-05-18T10:45:00Z",
  "decisions": [
    {
      "id": "d1",
      "description": "Use Fastify over Express for lower overhead",
      "rationale": "Fastify schema-based validation removes a class of runtime errors"
    }
  ],
  "work_completed": "Set up API layer with schema validation"
}
```

Decision nodes written from agent logs receive `status: "confirmed"` and are indexed in Qdrant with `has_decisions: true` — identical treatment to human-authored decisions.

---

## Drift Detection

### Two-stage pipeline: why not one?

**Stage A (Qdrant, fast):** Cosine similarity search against chunks with `has_decisions=true`. Threshold: 0.55. Returns top-K candidates that may semantically overlap with the new signal.

**Stage C (LLM, expensive):** For each Stage A candidate: "Does this new signal actually contradict this decision? Yes/no with reasoning." Creates a `DriftAlert` node only on LLM confirmation.

Why two stages rather than LLM-only or Qdrant-only:

- **Qdrant-only:** 0.55 cosine threshold produces high false positive rate. Semantic overlap does not imply contradiction — two decisions about "database indexing" are not necessarily in conflict.
- **LLM-only:** Processing every new event against every decision: 242 existing vectors × N events/day × 1 LLM call = cost and latency that scales with corpus size. Not practical.
- **Two stages:** Stage A filters to ~3 candidates per event. Stage C makes ~3 LLM calls per event regardless of corpus size. Cost is bounded.

**Threshold rationale:** 0.55 was calibrated against the eval:drift-fp suite. Below 0.55, semantic overlap is too weak for contradictions to occur in practice. With Stage A + Stage C: < 8% false positive rate in eval. Threshold is configurable via `DRIFT_SEMANTIC_THRESHOLD` — teams with lower tolerance for false positives can raise it to 0.65+ at the cost of reduced recall.

---

## Query Layer

Full pipeline for a single `POST /brain/query` request:

1. **Intent parsing** — classify as `general`, `project`, `person`, or `impact` (Haiku, ~100ms)
2. **Embed** — text-embedding-3-small or nomic-embed-text, 768-dim (~200ms)
3. **Qdrant ANN search** — top-6 chunks, `has_decisions=true` filter, `project_id` filter (~300ms)
4. **Neo4j graph expansion** — fetch full Event + Decision + Person + Ticket subgraph by event_id (~200ms)
5. **Build context block** — structured JSON with citations (source_url, actor, timestamp), truncated to 6000-token budget
6. **LLM answer** — system prompt cached via `cache_control: {"type": "ephemeral"}` (~6000ms)
7. **Response** — `{answer, citations[], latency_ms, citation_warning}`

**Context budget:** 6000 tokens. Chunks ranked by relevance score, truncated to budget. Prevents runaway costs on large corpora.

**Citation contract:** Every answer must be grounded in the provided context. If the LLM cannot find supporting evidence, it says so explicitly — no hallucination. `citation_warning: true` is set on low-confidence responses.

**Latency breakdown:**
- Anthropic Haiku path: ~7s average, ~12s p95. LLM call dominates.
- Ollama (gemma2:9b local): ~60–90s p95. Acceptable for offline/batch; not suitable for interactive use.

---

## LLM Cost Controls

Prompt caching is not optional — it is enforced as a code constraint.

**Rules:**
- System prompt is always a list of blocks with `cache_control: {"type": "ephemeral"}` on the last block — never a plain string (a plain string cannot be cached)
- No timestamps, UUIDs, or per-request IDs in the system prompt — they invalidate the cache on every request
- Tool definitions are sorted deterministically by name — random ordering invalidates the cache
- Session-scoped context (retrieved docs, graph snapshots) gets a second `cache_control` breakpoint at the end of the first user message

**Measured impact** (50 queries/day baseline):
- Without caching: ~$0.03/day
- With caching: ~$0.006/day (80% reduction on input tokens)

For extraction pipelines with bursty-then-idle patterns, TTL is set to 1 hour (`{"type": "ephemeral", "ttl": "1h"}`). For interactive query sessions, default 5-minute TTL applies.

Verification: `response.usage.cache_read_input_tokens` must be non-zero on repeated calls with identical prefixes. If it is zero, there is a silent cache invalidator — the codebase treats this as a bug, not a cost nuance.

---

## Data Model (Neo4j)

### Nodes

| Node | Key properties |
|---|---|
| `Event` | `event_id`, `source`, `source_url`, `actor`, `timestamp`, `raw_content` |
| `Decision` | `decision_id`, `description`, `rationale`, `status`, `source_signals[]` |
| `Person` | `person_id`, `name`, `email`, `handle` |
| `Ticket` | `ticket_ref`, `title`, `status` |
| `DriftAlert` | `alert_id`, `severity`, `reasoning`, `timestamp` |
| `FollowUpTask` | `task_id`, `description`, `assigned_to`, `due_date` |

### Relationships

```
(Event)-[:AUTHORED_BY]->(Person)
(Decision)-[:EXTRACTED_FROM]->(Event)
(Event)-[:REFERENCES]->(Ticket)
(DriftAlert)-[:CHALLENGES]->(Decision)
(DriftAlert)-[:TRIGGERED_BY]->(Event)
```

Constraints enforce uniqueness on `event_id`, `decision_id`, `alert_id`, `person_id`, `ticket_ref`. The brain-writer uses `MERGE` not `CREATE` — idempotent on replay.

### Example query this schema enables

"Show all decisions challenged by drift alerts, authored by Alice, referencing any infrastructure ticket":

```cypher
MATCH (p:Person {name: "Alice"})<-[:AUTHORED_BY]-(e:Event)<-[:EXTRACTED_FROM]-(d:Decision)
      <-[:CHALLENGES]-(a:DriftAlert),
      (e)-[:REFERENCES]->(t:Ticket)
WHERE t.title CONTAINS "infra"
RETURN d.description, a.severity, t.ticket_ref, e.timestamp
ORDER BY e.timestamp DESC
```

This query is not expressible as a vector similarity search or a SQL join without denormalized columns and quadratic lookup complexity.

---

## Eval Results

| Eval | Result | Notes |
|---|---|---|
| `eval:integration` | 33/33 PASS | Full pipeline: ingestion → extraction → graph integrity → query → citations → cross-source → project isolation → drift detection → scope isolation |
| Backstage recall | 91% (11/12) | Cold ingestion of 13 public Spotify Backstage ADRs. 1 failure: question about a decision mentioned only in a comment deep in a linked PR — retrieval coverage gap, not hallucination |
| `eval:mcp` | 8/8 PASS | All 4 MCP tools + resource verified against REST API equivalents |
| `eval:drift-fp` | < 8% false positive rate | Stage A + Stage C pipeline |

---

## Production Readiness

### What is production-ready today

- Docker-native healthchecks on all services
- Redis Streams consumer groups with XACK — no message loss on worker crash
- Neo4j constraints prevent duplicate nodes on event replay
- Idempotent brain-writer (`MERGE` not `CREATE` on Event nodes)
- Fastify rate limiting (60 req/min default, configurable)
- Snapshot/restore: full brain state archived as `.tar.gz` (Neo4j Cypher dump + Qdrant snapshot)
- JS obfuscation on release builds (RC4-encrypted string arrays, hex identifier renaming) for distributed binaries
- Release images built via GitHub Actions on `release-*` branches only

### Honest limitations

| Limitation | Current state | Planned fix |
|---|---|---|
| Auth | API key only | GitHub OAuth — Phase 3 M5 |
| Horizontal scaling | Single brain-writer instance | Distributed lock (Redis SETNX) before scaling |
| Drift detection SLA | Async, no guaranteed delivery time | Alerting + monitoring (Phase 4) |
| Qdrant hosting | Self-hosted only | AWS ECS — Phase 3 M6 |
| Ollama latency | 60–90s p95 | Not suitable for interactive use; Ollama path is for offline/local only |

---

## Scalability Path

**Current:** Single Docker Compose on one host. Handles 1,000+ events/day with zero performance concern.

**Scale path:**

1. **Extractor workers:** Redis consumer groups handle multiple consumers natively. Add more extractor containers — no code change required.
2. **Neo4j:** Add read replicas. Route read queries (graph expansion during query) to follower. Writes remain on leader.
3. **Qdrant:** Supports distributed mode natively. Add nodes, redistribute collections.
4. **Brain-writer:** Currently single-instance to avoid concurrent MERGE conflicts on the same event_id. Scale path: Redis SETNX distributed lock per event_id before Neo4j write. Adds ~5ms per write.
5. **Managed queue:** At > 10,000 events/day, migrate Redis Streams → AWS SQS or MSK. Consumer group interface maps directly.

---

## Security

- API key authentication on all endpoints (`x-api-key` header, validated in Fastify preHandler)
- Neo4j and Qdrant bound to Docker internal network — not exposed on host ports unless explicitly port-mapped
- Session secret for future cookie-based auth (OAuth integration)
- JS obfuscation on distributed release builds — RC4-encrypted string arrays, hex identifier renaming — prevents casual inspection of binaries
- No secrets in version control — all credentials via environment variables or `.env` (gitignored)

---

## Frequently Challenged Decisions

**"Why not a single DB with both vector and graph capabilities? Amazon Neptune Analytics has both."**

Neptune Analytics added vector search in 2024. It is a reasonable future migration target for teams already on AWS. Today, its vector search capabilities are less mature than Qdrant's (no HNSW tuning exposure, no payload filtering inside ANN), and it does not support self-hosted deployment — which is a Phase 3 product requirement for BYOC customers.

**"Why not just use a knowledge graph with full-text search?"**

Full-text search (Lucene-backed in Neo4j, Elasticsearch) does not understand semantic proximity. "What decisions relate to rate limiting?" will not return decisions about "throttling" or "backpressure" without explicit synonym configuration. Embedding-based retrieval handles this naturally — it is the correct tool for semantic search.

**"Why Haiku and not GPT-4o-mini for extraction?"**

GPT-4o-mini is a valid alternative at similar cost. Haiku was chosen because the codebase uses Anthropic's prompt caching API, which requires Anthropic models. Switching to OpenAI would require redesigning the caching layer around OpenAI's Realtime API or accepting higher per-request costs. Haiku's JSON extraction quality is sufficient for the extraction tasks in eval.

**"91% recall — what is the plan for the 9%?"**

The 1 failure in the Backstage eval was not a hallucination — it was a retrieval gap. The ground-truth decision was mentioned only in a comment inside a linked PR, not in the ADR text itself. The fix is expanding the ingestion scope: index PR review comments, not just PR descriptions and bodies. This is a known Phase 4 retrieval coverage improvement, not a fundamental architectural limitation.
