# System Architecture — Project Brain

**Status:** Current  
**Version:** 0.3  
**Last Updated:** 2026-05-18  

---

## 1. System Overview

Project Brain is an event-driven knowledge system that ingests signals from multiple sources, maintains a continuously updated knowledge graph, and serves context to human users and AI agents via a unified query interface.

```
┌─────────────────────────────────────────────────────────────────┐
│                         INGESTION LAYER                         │
│  GitHub  │  Slack  │     Jira      │  Meetings  │  AI Agents   │
│  webhook │ webhook │    webhook    │    API     │  write-back   │
└────────────────────────────┬────────────────────────────────────┘
                             │ events
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       PROCESSING PIPELINE                        │
│   Parser → Entity Extractor → Chunker → Embedder → Linker       │
└────────────────────────────┬────────────────────────────────────┘
                             │ structured + embedded signals
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                         BRAIN STORE                              │
│   Vector Store (semantic retrieval)                              │
│   Graph DB (causal + relational reasoning)                       │
│   Temporal Index (plan versioning over time)                     │
└────────────────┬────────────────────────┬───────────────────────┘
                 │                        │
                 ▼                        ▼
┌───────────────────────┐    ┌───────────────────────────────────┐
│    QUERY LAYER        │    │       ANOMALY ENGINE               │
│  RAG + graph traversal│    │  Contradiction detector            │
│  Citation builder     │    │  Plan drift monitor                │
│  Multi-mode retrieval │    │  Impact analysis                   │
└──────────┬────────────┘    └──────────────┬────────────────────┘
           │                                │
           ▼                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                      INTERFACE LAYER                             │
│   Chat UI (web)  │  REST API  │  MCP Server  │  Webhooks/alerts │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Component Detail

### 2.1 Ingestion Layer

Responsible for receiving signals from all source systems and normalizing them into a canonical event format before passing to the processing pipeline.

**Canonical event schema:**
```json
{
  "event_id": "uuid",
  "source": "github | slack | jira | meeting | agent | document",
  "source_id": "original ID in the source system",
  "project_id": "project namespace in the brain",
  "actor": { "type": "human | agent | collective", "id": "...", "name": "..." },
  "timestamp": "ISO 8601",
  "event_type": "pr_opened | pr_merged | comment | decision | ticket_update | agent_log | ...",
  "raw_content": "...",
  "url": "deep link back to source"
}
```

**Ingestion strategies by source:**

| Source | Primary | Fallback |
|---|---|---|
| GitHub | Webhooks (push, PR, issue, review events) | `seed:github` CLI (fetches last N PRs/issues) |
| Slack | Socket Mode (Bolt SDK) | `seed:slack` CLI |
| Jira | Webhooks (issue created/updated/transitioned) | `seed:jira` CLI |
| Linear | Not yet implemented — connector planned | — |
| Meetings | `POST /brain/ingest/transcript` (VTT/SRT/text) | — |
| Documents | `seed:local-docs` CLI (git-history attribution) | `POST /brain/ingest/crawl-docs` (GitHub API) |
| AI Agents | `POST /brain/agent-log` write-back API; also via `brain_log_decision` MCP tool | — |

Ingestion is idempotent: `event_id` is the deduplication key. Re-delivery of the same event is a no-op.

---

### 2.2 Processing Pipeline

Transforms raw events into structured knowledge suitable for the brain store.

**Stages:**

1. **Parser** — Extracts structured fields from raw content. Converts meeting transcripts to speaker-attributed segments. Parses PR diffs to identify changed files and modules.

2. **Entity Extractor** — Identifies named entities: people, decisions, technologies, tickets, codebases, deadlines, action items. Uses an LLM extraction step (Claude) with a constrained output schema.

3. **Chunker** — Splits content into semantically coherent chunks suitable for embedding. Chunk boundaries respect entity boundaries — a decision is never split across chunks.

4. **Embedder** — Generates vector embeddings for each chunk using a text embedding model. Embeddings are stored alongside the chunk in the vector store.

5. **Linker** — Creates graph edges between the new node and existing nodes:
   - PR → mentions Issue #N → creates PR-references-Issue edge
   - Slack message → mentions PR #N → creates Slack-references-PR edge
   - Agent log → task_id matches Jira ticket → creates AgentLog-implements-Ticket edge
   - Contradiction detector: new decision conflicts with existing decision → creates contradicts edge, flags for anomaly engine

---

### 2.3 Brain Store

The persistent knowledge state. Hybrid architecture: a vector store for semantic retrieval and a graph database for relational and causal reasoning.

**Vector Store**
- Stores: embedded chunks with metadata (source, timestamp, project_id, actor, url)
- Used for: semantic similarity search, natural language query grounding


**Graph Database (Neo4j)**
- Nodes: Event, Decision, Ticket, DriftAlert, FollowUpTask, Person
- Edge types: `AUTHORED_BY`, `EXTRACTED_FROM`, `REFERENCES`, `CHALLENGES`, `INFORMS`, `ADDRESSES`
- Used for: impact analysis (INFORMS traversal from Decision → Ticket), drift alert linking, person identity resolution


**Temporal Filtering**
- Every node carries a `valid_from` timestamp recording when it was ingested or last updated
- Enables time-bounded queries: filter decisions and events by ingestion date range
- Note: full bitemporal versioning (node snapshots, point-in-time graph state) is not yet implemented — nodes are mutated in place; `valid_from` is used for ordering and range filtering only

---

### 2.4 Query Layer

Serves natural language queries from humans and agents. Combines vector similarity search with graph traversal.

**Query flow:**
1. Parse query intent and extract query parameters (project scope, time range, domain/expertise filter)
2. Embed query for vector similarity search → top-K candidate chunks
3. Expand candidates via graph traversal → pull in related decisions, linked tickets, causal context
4. Assemble context window from candidates
5. Generate grounded answer via LLM (Claude) with explicit citation of each source chunk
6. Return: answer + citations (source type, URL, timestamp, actor)

**Query modes:**

| Mode | Status | Filter | Graph expansion |
|---|---|---|---|
| Project-scoped | **Implemented** | Single project namespace | Within-project only |
| Temporal | **Implemented** | Date range on `valid_from` | Within-project, time-bounded |
| Impact analysis | **Implemented** | Change description (semantic) | Full downstream traversal |
| Expertise-scoped | Not yet implemented — degrades to project-scoped | Domain tag across namespaces | Cross-project, domain-filtered |
| Agent resume | Not yet implemented — degrades to project-scoped | task_id or codebase filter | Prior agent sessions only |

---

### 2.5 Anomaly Engine

Runs asynchronously after every ingestion event. Two modes:

See [drift-workflow.md](drift-workflow.md) for the full end-to-end sequence with sequence diagrams and configuration reference.

**Proactive (continuous) — drift-detector worker:**
- Runs on every event that reaches the `events:extracted` stream (Slack, meeting, Jira, agent sources — GitHub and document sources are skipped to reduce false positives)
- Stage A: embeds the incoming event text and searches Qdrant for confirmed decisions with cosine similarity ≥ 0.55
- Stage C: LLM confirmation pass — classifies each candidate as `conflicts`, `confirms`, or neither
- Confirmed conflicts write a `DriftAlert` node with a `CHALLENGES` edge to the affected `Decision`; a webhook fires to `DRIFT_WEBHOOK_URL` if configured

**Reactive (on-demand) — impact analysis:**
- `POST /brain/query` with `mode: "impact"` and `change_description`
- Embeds the change description, retrieves semantically relevant decisions from Qdrant, expands via Neo4j graph traversal
- LLM assigns risk tier (critical / high / medium / low) per decision; deterministic floor ensures open drift alerts are never rated below `high`
- Returns: overall risk, per-decision assessments with citations, linked Jira ticket status

---

### 2.6 Interface Layer

**Web Chat UI**
- Minimal chat interface for Phase 1
- Supports all query modes via natural language
- Displays citations as expandable source cards
- Anomaly alerts surfaced as notification banners

**REST API**
- `POST /brain/query` — natural language query
- `POST /brain/agent-log` — agent write-back
- `POST /brain/impact-analysis` — reactive impact analysis
- `GET /brain/anomalies` — current open anomalies for a project
- Auth: JWT bearer token

**MCP Server** *(Phase 3, complete)*
- Package: `apps/mcp` — stdio transport (local) and HTTP+SSE (remote)
- Tools: `brain_query`, `brain_log_decision`, `brain_analyze_impact`, `brain_log_signal`
- Resource: `brain://project/{id}` — project snapshot (recent decisions + open drift alerts)
- Makes the brain natively queryable by Claude Code, Cursor, and any MCP-compatible agent

---

## 3. Data Flow: End-to-End Example

**Scenario:** A developer merges a PR that changes the auth module. An anomaly is detected and a specialist is alerted.

```
1. GitHub webhook fires → PR merged event received by ingestion layer
2. Parser extracts: PR title, description, review comments, changed files (auth/token.py)
3. Entity extractor identifies: decision ("use short-lived JWTs"), changed module (auth)
4. Linker: PR → implements Jira PROJ-412; changed file auth/token.py → affects all tickets
          referencing the auth module; decision "short-lived JWTs" → contradicts prior
          decision "long-lived session tokens" from design meeting (March 2026)
5. Contradiction edge created → anomaly engine triggered
6. Anomaly engine: generates alert "Merged PR #234 introduces short-lived JWTs, 
          contradicting design decision from 2026-03-15 meeting (long-lived session tokens).
          Affects: PROJ-412, PROJ-389, PROJ-401."
7. Alert surfaced in chat UI; optional Slack notification to project channel
8. Priya (specialist) queries: "What changed in auth this week and what does it conflict with?"
          → grounded answer with citation to PR #234, March meeting transcript, 3 affected tickets
```

---

## 4. Technology Stack (Proposed)

See ADRs for rationale on key decisions.

| Layer | Technology | Notes |
|---|---|---|
| API server | Node.js (Fastify) | TypeScript; monorepo with `apps/api` |
| Vector store | Qdrant (self-hosted) | |
| Graph database | Neo4j 5 Community | Uniqueness constraints on all primary keys |
| Embedding model | `nomic-embed-text:v1.5` (local, via Ollama) | See ADR-005; OpenAI embeddings evaluated and deferred |
| LLM (query + extraction) | Claude Haiku 4.5 (extraction/intent), Claude Sonnet 4.6 (query answers) | Prompt caching on all calls; see llm-cost-controls.md |
| Event queue | Redis 7 Streams (consumer groups, SIGTERM-safe workers) | `StreamWorker` base class in `apps/api/src/lib/stream-worker.ts` |
| Workers | normalizer → extractor → brain-writer → drift-detector | All use `StreamWorker`; crash-safe Qdrant retry queue |
| Auth | Bearer token (hashed at rest in Neo4j) | GitHub OAuth planned for Phase 3 M5 |
| Chat UI | Next.js (standalone Docker build) | `apps/web`; streaming LLM responses via SSE |
| MCP server | `@modelcontextprotocol/sdk` (TypeScript) | `apps/mcp`; stdio + StreamableHTTP transports |
