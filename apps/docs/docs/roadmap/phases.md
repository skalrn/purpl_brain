---
sidebar_position: 1
---

# Phases

Each phase proves a discrete thesis before the next begins. A phase is complete when its exit criterion is met with real data from a real (or realistic) project.

## Phase 1 — Context on Demand (complete)

**Thesis:** Context-on-demand works.

**Exit criterion:** A developer returning after a 2-week absence queries the brain about a real repo and correctly understands current PR state, key decisions made, and open questions — all cited to specific GitHub sources.

**What was built:**
- GitHub webhook listener and ingestion pipeline
- Two-pass entity extraction (rule-based Pass 1 + LLM Pass 2)
- Hybrid brain store (Qdrant + Neo4j dual-write)
- Natural language query layer with RAG + graph expansion
- Citation validator (0 fabricated citations on eval)
- Temporal diff query ("what changed in the last N days")
- Minimal chat UI with streaming responses

**Eval results:** Extraction precision 92.3%, recall 80.0%. Query accuracy 83.3% (15/18). Zero fabricated citations. p95 latency < 2s on Claude API.

## Phase 2 — Multi-Source Synthesis + Drift Detection (complete)

**Thesis:** Multi-source synthesis and drift detection work.

**Exit criterion:** A single query synthesizes decisions from 2+ sources with both cited; at least one proactive drift alert fires on a real contradiction.

**What was built:**
- Slack, Jira, Linear, meeting transcript, and document ingestion
- Link-following for embedded GitHub PR URLs (fixed 91% recall gap)
- Drift detector (two-stage: cosine similarity + LLM confirmation)
- DriftAlert node schema and resolution flow
- Impact analysis (BFS graph traversal from any starting node)
- Streaming LLM responses via SSE
- Agent write-back API (`POST /brain/agent-log`)

## Phase 3 — Agent Memory Loop (in progress)

**Thesis:** The agent memory loop works end-to-end.

**Exit criterion:** A developer installs the MCP server via `setup.sh`, runs two Claude Code sessions on the same repo, and the second session correctly recalls a decision made in the first — cited, sourced, without the developer doing anything manually.

**Milestones:**

| Milestone | Status |
|---|---|
| M1: MCP server (brain_query, brain_log_decision, brain_analyze_impact, brain_log_signal; stdio + HTTP) | Complete |
| M2: Agent write-back pipeline (POST /brain/agent-log through the same pipeline as human signals) | Complete |
| M3: MCP eval + CLAUDE.md setup instructions | Complete |
| M4: Beta setup polish (single docker compose up, setup.sh wizard, healthchecks, web UI in compose) | Complete |
| M5: GitHub OAuth + seat identity (email as Person primary key, per-source alias merge) | Not started |
| M6: AWS packaging (CDK/CloudFormation, ECS Fargate, HTTP+SSE MCP transport, Marketplace) | Not started |

M5 gate: before M5 starts, the write API contract must be finalized — specifically the server-side schema validation on `POST /brain/agent-log`. This is a breaking constraint on every agent client and must be stable before seat identity and billing are added.

## Phase 4 — Commercial Distribution

**Thesis:** Commercial distribution works.

**Exit criterion:** A customer installs the brain in their own AWS account from the Marketplace listing without any manual assistance from the team.

**What this involves:**
- AWS CDK/CloudFormation packaging
- ECS Fargate deployment (stateless API workers, EFS for Qdrant persistence)
- AWS Marketplace metered billing integration
- HTTP+SSE MCP transport for remote cloud deployments
- GitHub OAuth for seat identity
- Per-project access control (not just per-team)

Phase 4 does not start until Phase 3 exit criterion is met. BYOC (Bring Your Own Cloud) and identity resolution are the two major architectural additions in Phase 4.
