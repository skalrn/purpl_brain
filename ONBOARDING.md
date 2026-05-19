# purpl-brain Onboarding Guide

**What this is:** A shared working memory for human-agent software teams. It ingests signals from GitHub, Slack, Jira, meetings, and AI agent sessions — extracts decisions, builds a knowledge graph, and serves grounded, cited answers to anyone who asks, including AI agents mid-session.

**What you'll get from this doc:** a working local setup, a mental model of how the system works, and enough context to navigate the codebase confidently.

---

## Monorepo layout

```
purpl_brain/
  apps/
    api/          ← Fastify API server: all ingestion, extraction, query, auth
    mcp/          ← MCP server: 4 tools that expose the brain to AI agents
    web/          ← Next.js chat UI
    cdk/          ← AWS CDK infra (Phase 3 M6 — not needed for local dev)
  packages/
    types/        ← Shared TypeScript types across apps
  docs/
    technical/    ← Architecture, specs, ADRs
    product/      ← Vision, PRD, personas, roadmap
  docker-compose.yml       ← Local dev infra (Redis, Neo4j, Qdrant)
  docker-compose.prod.yml  ← Production distribution image
  setup.sh                 ← Interactive setup for new deployments
```

---

## How to set up locally (5 minutes)

### Prerequisites
- Docker Desktop running
- Node.js 20+
- An Anthropic API key

### Step 1 — Run setup

```bash
bash setup.sh
```

This prompts for your Anthropic API key and a project name, generates `apps/api/.env` and `apps/mcp/.env`, builds the MCP server, and starts the infrastructure containers.

### Step 2 — Start the API

```bash
npm run dev -w apps/api
```

This starts the Fastify server on `:3001` and all four background workers (normalizer, extractor, brain-writer, drift-detector).

### Step 3 — (Optional) Start the web UI

```bash
npm run dev -w apps/web
```

Opens on `:3000`. Requires GitHub OAuth — set `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` in `apps/api/.env` first.

### Step 4 — Seed historical data

Connect a real repo's history before querying:

```bash
# GitHub PRs and issues (last 90 days)
npx tsx apps/api/src/scripts/seed-github.ts --repo owner/repo --project your_project_id

# Local markdown docs with git attribution
npx tsx apps/api/src/scripts/seed-local-docs.ts --dir /path/to/docs --project your_project_id

# Slack export (if you have one)
npx tsx apps/api/src/scripts/seed-slack.ts --file export.json --project your_project_id
```

### Step 5 — Connect Claude Code (MCP)

Add this block to `~/.claude/settings.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/purpl_brain/apps/mcp/dist/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3001",
        "BRAIN_API_KEY": "<your-api-key-from-setup>",
        "BRAIN_AGENT_ID": "claude-code"
      }
    }
  }
}
```

The API key was printed at the end of `setup.sh`. Restart Claude Code. You should see four new tools: `brain_query`, `brain_log_decision`, `brain_analyze_impact`, `brain_log_signal`.

---

## Mental model: how data flows

Every piece of knowledge enters via one of two paths and ends up in the same graph.

### Path 1 — Inbound signals (GitHub, Slack, Jira, meetings)

```
Webhook or seed script
  → POST /webhooks/{source}  or  POST /brain/ingest/*
  → events:raw  (Redis Stream)
  → normalizer worker  — converts to canonical Event schema
  → events:normalized
  → extractor worker   — rule filter, then LLM if decision candidate
  → events:extracted
  → brain-writer       — writes Event/Decision nodes to Neo4j + chunks to Qdrant
  → drift-detector     — checks new Decision against existing ones for contradictions
```

### Path 2 — Agent write-back

```
Agent session ends
  → POST /brain/agent-log  (or brain_log_decision MCP tool)
  → same pipeline from events:raw onward
  → agent decisions land in the graph with full attribution
```

### Query path

```
Natural language question
  → embed immediately (parallel with intent parse)
  → Haiku classifies intent → mode, filters, entity refs
  → Qdrant vector search (top-10 chunks)
  → Neo4j graph expansion (1-hop neighbors)
  → rank + trim to 6K token budget
  → Sonnet generates answer with inline citations
  → citation validator checks every [N] ref
  → stream answer to UI or return to agent
```

---

## The four workers

All workers live in `apps/api/src/workers/`. They run as background processes inside the API server on startup.

| Worker | Reads from | Writes to | What it does |
|---|---|---|---|
| `normalizer` | `events:raw` | `events:normalized` | Converts source-specific webhook payloads to canonical Event schema |
| `extractor` | `events:normalized` | `events:extracted` | Pass 1: rule-based entity extraction. Pass 2: LLM extraction only if decision markers found |
| `brain-writer` | `events:extracted` | Neo4j + Qdrant | Creates/updates graph nodes and vector embeddings |
| `drift-detector` | `events:extracted` | Neo4j DriftAlert nodes | Compares new Decisions against existing ones for contradictions |

Each worker extends `StreamWorker` (`apps/api/src/lib/stream-worker.ts`) — handles consumer groups, SIGTERM-safe shutdown, and retry on processing failure.

---

## The brain store: two databases, one purpose

**Neo4j** stores the knowledge graph. Node types: `Event`, `Decision`, `Person`, `Ticket`, `DriftAlert`, `Project`. Key edge types: `EXTRACTED_FROM`, `AUTHORED_BY`, `REFERENCES`, `CHALLENGES`, `MEMBER_OF`. Used for: impact analysis, drift alert linking, identity resolution, project membership auth.

**Qdrant** stores vector embeddings of text chunks. Used for: semantic similarity search in the query layer.

They are kept in sync by `brain-writer`. If Qdrant is temporarily unavailable, writes queue into a retry stream — Neo4j is always written first and is the authoritative store.

All Neo4j queries use parameterised Cypher. Never interpolate user input into a Cypher string.

---

## The five query modes

The intent parser (`apps/api/src/lib/intent-parser.ts`) classifies every query into one of:

| Mode | What it does | When triggered |
|---|---|---|
| `project` | Vector search + 1-hop graph expansion, grounded answer | Default; most queries |
| `temporal` | Graph-only: nodes with `valid_from` in the requested range, grouped into a changelog | "what changed this week", "last 5 days" |
| `expertise` | Per-project brief summaries assembled across namespaces | Cross-project specialist queries |
| `agent-resume` | Graph-only: prior agent session decisions + drift since session ended | Agent resuming a task |
| `impact` | BFS graph traversal from a starting node, depth 3 | Impact analysis requests |

---

## The extraction pipeline: two passes

**Pass 1 — rule-based (every event, no LLM):** extracts ticket refs (`[A-Z]+-\d+`), `@mentions`, dates, technology keywords, and flags the event as a decision candidate if any decision marker phrase matches (e.g., "we decided", "going with", "agreed to"). If not a candidate, the event is stored with entity refs only — no LLM call.

**Pass 2 — LLM (decision candidates only, ~35% of events):** Claude Haiku reads the full content and extracts structured decisions: description, rationale, confidence, decision maker, scope, reversibility, and a mandatory `quoted_text` from the source. Extraction schema is in `apps/api/src/workers/extractor.ts`.

Confidence scoring: linguistic markers (0.4 weight) + social confirmation (0.3) + source authority (0.2) + rationale presence (0.1). Score ≥ 0.7 → `high` (full weight in query). 0.4–0.69 → `medium` (deprioritised). < 0.4 → `low` (not surfaced unless explicitly queried).

---

## LLM cost control rules

Every Anthropic SDK call must follow the two-breakpoint caching pattern. These rules are enforced by `CLAUDE.md` — do not deviate from them.

1. System prompt must be a list of blocks with `cache_control: {"type": "ephemeral"}` on the last block — never a plain string.
2. No timestamps, UUIDs, or per-request IDs in the system prompt. Put them in a user message at the end.
3. Tool definitions must be sorted by name. Never vary the tool set per request.
4. Session-scoped context (retrieved docs, graph snapshots) gets a second `cache_control` breakpoint at the end of the first user message.
5. Verify caching works: `response.usage.cache_read_input_tokens` must be non-zero on repeated calls. If it's zero, find the silent invalidator (common cause: a non-deterministic value in the stable prefix).

See `docs/technical/llm-cost-controls.md` for the full pattern with code examples.

---

## Auth and security model

`requireApiKey` (`apps/api/src/lib/auth-middleware.ts`) validates the `x-api-key` header against SHA-256-hashed keys stored in Neo4j. It attaches the authenticated `Person` to `req.actor`.

`requireProjectMember` checks that the authenticated person has a `MEMBER_OF` edge to the requested `project_id` in Neo4j. This is the per-project isolation boundary. It is applied to all query and drift-alert routes.

`MEMBER_OF` edges are created on GitHub OAuth login (`apps/api/src/routes/auth.ts`). The target project is `DEFAULT_PROJECT_ID` from env (default: `"default"`).

`DEV_API_KEY` in `.env` bypasses Neo4j lookup for local dev. It must not be used in any hosted deployment.

The MCP HTTP transport (`MCP_TRANSPORT=http`) requires `MCP_AUTH_TOKEN` to be set and binds to `127.0.0.1` by default. Never expose it directly to a public network.

---

## The MCP server

Four tools exposed to any connected agent:

| Tool | When to call it |
|---|---|
| `brain_query` | Query the brain for decisions, architecture context, team knowledge |
| `brain_log_decision` | Write this session's decisions back into the brain at session end |
| `brain_analyze_impact` | Before a significant change, check which decisions it may affect |
| `brain_log_signal` | Report an unexpected finding that may contradict existing decisions |

One resource: `brain://project/{id}` — returns a snapshot of recent decisions and open drift alerts for a project.

The MCP server (`apps/mcp/src/index.ts`) proxies all tool calls to the brain REST API. It shares no business logic with the API — it is a thin adapter. Stdio transport is the default for local use; `MCP_TRANSPORT=http` enables remote access.

---

## Eval scripts

All evals are in `apps/api/src/scripts/eval-*.ts`. Run with `npx tsx`:

```bash
# Verify extraction quality
npx tsx apps/api/src/scripts/eval-extraction.ts

# Verify query recall and citation faithfulness
npx tsx apps/api/src/scripts/eval-query.ts

# Verify cross-session agent memory
npx tsx apps/api/src/scripts/eval-cross-session.ts

# Verify all 4 MCP tools
npx tsx apps/api/src/scripts/eval-mcp.ts

# Full pipeline integration check (33 assertions)
npx tsx apps/api/src/scripts/eval-integration.ts
```

All evals must pass before merging changes to the extraction or query pipeline. Eval status as of 2026-05-19: all Phase 1 (M7) and Phase 2 (M6) evals PASS. See `docs/product/roadmap.md` for exit criteria per phase.

---

## Resetting the pipeline

If you change extraction logic or the LLM prompt, you can replay all historical events through the updated code without re-fetching from source APIs:

```bash
npx tsx apps/api/src/scripts/reset-pipeline.ts --project your_project_id
# then restart the API — workers will replay from events:raw
```

This wipes derived state (Neo4j nodes, Qdrant chunks) for the project and replays the full `events:raw` Redis Stream. The raw events are preserved.

---

## Key env vars

| Var | Where | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `apps/api/.env` | LLM extraction and query |
| `NEO4J_PASSWORD` | `apps/api/.env` | Graph DB auth |
| `SESSION_SECRET` | `apps/api/.env` | Fastify session signing (must be set; no default) |
| `DEFAULT_PROJECT_ID` | `apps/api/.env` | Project MEMBER_OF granted on OAuth login |
| `CORS_ALLOWED_ORIGINS` | `apps/api/.env` | Comma-separated allowed origins for SSE stream |
| `DEV_API_KEY` | `apps/api/.env` | Dev-only bypass; never set in hosted deployments |
| `GITHUB_CLIENT_ID` / `SECRET` | `apps/api/.env` | GitHub OAuth for web UI login |
| `BRAIN_API_KEY` | `apps/mcp/.env` | MCP server auth against brain API |
| `MCP_AUTH_TOKEN` | `apps/mcp/.env` | Required when running `MCP_TRANSPORT=http` |

---

## Phase status

- **Phase 1** ✓ — GitHub ingestion → knowledge graph → natural language query with citations
- **Phase 2** ✓ — Slack, Jira, meetings, agent logs, drift detection, temporal diff, streaming
- **Phase 3** in progress — MCP server (M1 ✓), agent write-back (M2 ✓), MCP eval (M3 ✓), beta polish (M4), identity resolution (M5), AWS packaging (M6)

The active branch is `pivot/agent-memory`. All work merges to `main` after phase exit criteria are met (see `docs/product/roadmap.md`).

---

## Where to read next

| If you want to understand… | Read |
|---|---|
| Full system design | `docs/technical/architecture.md` |
| Extraction logic in depth | `docs/technical/entity-extraction.md` |
| Query pipeline in depth | `docs/technical/query-layer.md` |
| Why hybrid vector + graph | `docs/technical/adrs/001-hybrid-brain-store.md` |
| Why MCP over custom SDK | `docs/technical/adrs/002-mcp-server-interface.md` |
| Why webhooks over polling | `docs/technical/adrs/003-event-driven-ingestion.md` |
| Why agents write to the brain | `docs/technical/adrs/004-agent-decision-trails.md` |
| LLM cost controls (caching rules) | `docs/technical/llm-cost-controls.md` |
| Every implementation decision explained | `docs/technical-deep-dive.md` |
| Open security findings | Memory: `project_open_todos.md` (SEC-C1 through SEC-M8) |
