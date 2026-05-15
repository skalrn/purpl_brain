# System Architecture — Project Brain

**Status:** Draft  
**Version:** 0.1  
**Last Updated:** 2026-05-15  

---

## 1. System Overview

Project Brain is an event-driven knowledge system that ingests signals from multiple sources, maintains a continuously updated knowledge graph, and serves context to human users and AI agents via a unified query interface.

```
┌─────────────────────────────────────────────────────────────────┐
│                         INGESTION LAYER                         │
│  GitHub  │  Slack  │  Jira/Linear  │  Meetings  │  AI Agents   │
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
  "source": "github | slack | jira | linear | meeting | agent",
  "source_id": "original ID in the source system",
  "project_id": "project namespace in the brain",
  "actor": { "type": "human | agent", "id": "...", "name": "..." },
  "timestamp": "ISO 8601",
  "event_type": "pr_opened | pr_merged | comment | decision | ticket_update | agent_log | ...",
  "raw_content": "...",
  "url": "deep link back to source"
}
```

**Ingestion strategies by source:**

| Source | Primary | Fallback |
|---|---|---|
| GitHub | Webhooks (push, PR, issue, review events) | GitHub API polling (15-min interval) |
| Slack | Events API (message, reaction, pin events) | Slack API polling |
| Jira | Webhooks (issue created/updated/transitioned) | Jira API polling |
| Linear | Webhooks | Linear API polling |
| Meetings | Otter.ai / Fireflies webhook on transcript ready | Manual upload |
| AI Agents | `POST /brain/agent-log` write-back API | — |

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
- Technology choice: see [ADR-001](adrs/001-hybrid-brain-store.md)

**Graph Database**
- Nodes: Events, Decisions, Tickets, PRs, Agents, People, Concepts
- Edge types: `references`, `implements`, `contradicts`, `resolves`, `authored_by`, `affects`, `supersedes`
- Used for: impact analysis (graph traversal from a changed node), cross-product linking, causal chain reconstruction
- Technology choice: see [ADR-001](adrs/001-hybrid-brain-store.md)

**Temporal Index**
- Every node and edge carries a `valid_from` / `valid_to` timestamp
- Enables point-in-time queries: "what was the plan as of last Monday"
- Updates create new node versions rather than mutating existing ones

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

| Mode | Filter | Graph expansion |
|---|---|---|
| Project-scoped | Single project namespace | Within-project only |
| Temporal | Date range on `valid_from` | Within-project, time-bounded |
| Expertise-scoped | Domain tag across namespaces | Cross-project, domain-filtered |
| Agent resume | task_id or codebase filter | Prior agent sessions only |
| Impact analysis | Starting node (event, ticket, PR) | Full downstream traversal |

---

### 2.5 Anomaly Engine

Runs asynchronously after every ingestion event. Two modes:

**Proactive (continuous):**
- After each brain update, evaluates: does any new node have a `contradicts` edge to an existing node?
- Checks: are two concurrent tickets modifying the same codebase module (detected via shared file paths in PR diffs)?
- Checks: does a new Jira epic reference a technology that was explicitly rejected in a prior ADR or design decision?
- Generates an anomaly record with: affected nodes, contradiction description, severity, recommended action

**Reactive (on-demand):**
- `POST /brain/impact-analysis` with a source event ID
- Traverses the graph from that node: find all downstream `affects` and `implements` edges
- Returns: list of affected tickets, decisions, agents, people, with citation of the dependency path

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

**MCP Server** *(Phase 4)*
- Exposes the brain as an MCP resource: `brain://project/{id}/context`
- Exposes impact analysis as an MCP tool: `brain_impact_analysis(event_id)`
- Makes the brain natively queryable by Claude, Cursor, and any MCP-compatible agent without the chat UI

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
| API server | Python (FastAPI) | Async, good ecosystem for ML tooling |
| Vector store | Qdrant (self-hosted) or Pinecone | See ADR-001 |
| Graph database | Neo4j (Community) or Kuzu | See ADR-001 |
| Embedding model | `text-embedding-3-large` (OpenAI) or `voyage-3` (Anthropic) | Evaluated in Phase 1 |
| LLM (query + extraction) | Claude (via Anthropic API) | See ADR-002 |
| Event queue | Redis Streams (Phase 1) → Kafka (if scale requires) | Lightweight for POC |
| Auth | OAuth 2.0 (per-source) + JWT (internal API) | |
| Chat UI | Next.js (minimal) | Not a focus in Phase 1 |
| MCP server | Python MCP SDK | Phase 4 |
