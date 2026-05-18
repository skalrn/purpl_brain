# Phase 3 Implementation Plan — Agent Memory Loop

**Status:** 🔄 In progress (M1–M4 complete)  
**Started:** 2026-05-17  
**Branch:** `pivot/agent-memory`  
**Exit criterion:** A developer installs the MCP server via `setup.sh`, runs two Claude Code sessions on the same repo, and the second session correctly recalls a decision made in the first — cited, sourced, and without the developer doing anything manually.

---

## What Changed from Phase 2

Phase 2 proved multi-source synthesis and drift detection. The brain could answer questions grounded in GitHub, Slack, Jira, and meetings. But the entry point was wrong: first-time users had to set up a GitHub webhook before they got any value. Most developers won't do that.

Phase 3 reorients the product around the agent memory loop as the first-value moment. The MCP server is the entry point. GitHub/Slack/Jira ingestion becomes enrichment, not the prerequisite.

---

## Scope

**In:**
- MCP server with 4 tools (brain_query, brain_log_decision, brain_analyze_impact, brain_log_signal)
- Agent write-back route (`POST /brain/agent-log`)
- Frictionless onboarding (`setup.sh` → `docker compose up` → MCP config)
- GitHub OAuth login + Person identity resolution by email (M5)
- AWS CDK packaging + Marketplace metered billing (M6)

**Out:**
- Live meeting transcription (no Zoom/Meet SDK)
- Enterprise SSO
- Cross-product graph (deprioritized from original Phase 4)
- Automatic agent instrumentation (agents must call `brain_log_decision` explicitly)

---

## Milestones

### M1 — MCP Server ✅ Complete

**Goal:** Any MCP-compatible agent (Claude Code, Cursor) can query and write to the brain without touching the REST API directly.

**Delivered:**
- `apps/mcp` package — `@modelcontextprotocol/sdk` TypeScript implementation
- Tools: `brain_query`, `brain_log_decision`, `brain_analyze_impact`, `brain_log_signal`
- Resource: `brain://project/{project_id}` — snapshot of recent decisions + open drift alerts
- Transports: stdio (local) + StreamableHTTP (remote, session-aware)
- Config examples: `claude-code-config.example.json`, `cursor-config.example.json`

**Exit:** `brain_query` returns a cited answer from inside a Claude Code session.

---

### M2 — Agent Write-Back ✅ Complete

**Goal:** Agent decisions logged via MCP are ingested as first-class brain events, queryable alongside GitHub/Slack/Jira.

**Delivered:**
- `POST /brain/agent-log` REST route — validates ADR-004 schema
- Agent events ingested through the same normalize → extract → brain-write pipeline
- Decision nodes with `source: "agent"`, `event_id: agent_<session_id>`
- Drift detection runs on agent events (skips github source, processes agent events)

**Exit:** Agent logs a decision via `brain_log_decision`, then `brain_query` returns it with citation.

---

### M3 — MCP Eval + Docs ✅ Complete

**Goal:** All 4 MCP tools verified against live API; CLAUDE.md updated for new contributors.

**Delivered:**
- `eval-mcp.ts` — 7 tests covering all tools + drift-alerts resource (T1–T7)
- `CLAUDE.md` rewritten: accurate phase status, MCP tool table, local stdio + remote HTTP setup steps

**Exit:** 7/7 MCP smoke tests pass against a running brain.

---

### M4 — Beta Setup Polish ✅ Complete

**Goal:** A new user goes from `git clone` to first `brain_query` in under 10 minutes without guidance.

**Delivered:**
- `docker-compose.yml`: healthchecks on Redis, Qdrant, Neo4j, API; `depends_on: condition: service_healthy`; web UI service added
- `apps/web/Dockerfile`: Next.js standalone build
- `setup.sh`: API health poll after `docker compose up --build`; auto-runs `migrate:constraints`
- `apps/api/package.json`: `migrate:constraints` script added
- `README.md`: GitHub seed script documented as no-public-URL fallback; web UI in compose

**Exit:** `bash setup.sh` completes successfully and the API answers queries at `:3001`.

---

### M5 — GitHub OAuth + Seat Identity (Not started)

**Goal:** Engineers log in with GitHub; the brain resolves identities across sources using email as the canonical key.

**Scope:**
- GitHub OAuth login (Fastify `@fastify/oauth2`) — maps GitHub username + email → Person node
- Email as primary key on Person nodes; `aliases[]` list stores per-source IDs
- Fuzzy merge: when two sources share the same email, merge Person nodes (MERGE in Neo4j)
- Jira Users API call on ingest: resolve account ID → email
- Seat = API key issued at OAuth login (one per engineer, not per username)
- Per-seat billing anchor: count distinct active Person nodes with activity in last 30 days

**Deferred to Phase 4:** Full OAuth per source (Slack, Jira), meeting transcript speaker mapping, billing disputes.

**Coverage:** ~70% of team members (GitHub/Slack/Jira via email; meetings via fuzzy name match).

**Exit:** Two GitHub accounts and one Jira account belonging to the same engineer are merged into a single Person node and queries show the unified view.

---

### M6 — AWS Packaging (Not started)

**Goal:** The brain can be deployed to a customer's AWS account from the Marketplace in under 30 minutes.

**Scope:**
- AWS CDK stack: ElastiCache (Redis), ECS Fargate (API + all 4 workers), Neo4j AuraDB, Qdrant on ECS
- HTTP+SSE transport on MCP server — required for remote brain connection (stdio only works locally)
- AWS Marketplace metered billing: usage units reported to Metering API (bypasses enterprise procurement)
- Parameterised stack: API keys, webhook secrets, which sources to enable
- BYOC model: data never leaves customer VPC; MCP server runs locally as a thin proxy

**Exit:** A fresh AWS account can deploy the brain CDK stack and connect a Claude Code session to it via the HTTP MCP endpoint.

---

## Architecture Changes vs Phase 2

| Component | Phase 2 | Phase 3 addition |
|---|---|---|
| Workers | normalizer, extractor, brain-writer, drift-detector | All refactored to `StreamWorker` base class; Qdrant retry two-list crash-safe pattern |
| Actor schema | `type: "human" \| "agent"` | Added `"collective"` for multi-author documents |
| CanonicalEvent | No document fields | `document_title`, `document_path`, `document_type`, `document_contributors[]` |
| Neo4j | No constraints | `CREATE CONSTRAINT IF NOT EXISTS` on all primary keys + indexes on Person source identifiers |
| Brain store (Qdrant) | Skips events with no decisions | Documents (`doc_` prefix) always indexed regardless of decision extraction |
| Ingestion sources | GitHub, Slack, Jira, meetings | Documents via `seed:local-docs` with git-history attribution |
| Interface | REST + Web UI | MCP server (4 tools + 1 resource) |
| Rate limiting | None | 60 req/min global, keyed by Bearer token or IP |
| Docker Compose | No healthchecks | Healthchecks + `condition: service_healthy` + web UI service |

---

## New Environment Variables (M5)

```bash
# GitHub OAuth
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_OAUTH_CALLBACK_URL=http://localhost:3001/auth/github/callback

# Jira identity resolution
JIRA_BASE_URL=https://myorg.atlassian.net
JIRA_USER=me@example.com
JIRA_API_TOKEN=...
```

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| HTTP+SSE MCP transport adds latency vs stdio | Medium | Benchmark before M6; cache session state in Redis |
| Neo4j AuraDB free tier limits for beta users | Medium | Document AuraDB tier requirements; allow self-hosted Neo4j as alternative |
| AWS Marketplace approval process takes weeks | High | Start submission early; MVP CDK stack without Marketplace first |
| Person node fuzzy merge creates incorrect merges | Low | Require email match (not just name); log merge decisions as auditable events |
