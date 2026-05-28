# purpl-brain

**A shared decision log for human-agent software teams.**

I built this to find out whether the idea would actually hold up: a single graph where both humans and AI agents write what they decided and why, so neither has to re-derive what the other already figured out.

The system works end-to-end for one developer plus AI agents. The open question is whether the structured decision trail holds value when a second human joins the graph. If that problem resonates with your team, I'd like to hear from you.

---

## The problem

Your agents are starting cold on a codebase your team has been building for years.

They don't know the cache layer was bypassed for that one endpoint because it was returning stale data under load. They don't know the retry interval was set to 90 seconds after a staging failure nobody fully documented. They don't know the API field was renamed mid-sprint because a mobile client was already using the old name. Every session, they rediscover or — worse — contradict decisions your team already made.

The deeper problem: humans and agents decide things in different places. A developer makes a choice in a Slack thread. An agent makes a choice in a coding session. Neither system knows what the other decided. CLAUDE.md files cap out at a few hundred lines and go stale. Session history captures noise, not signal.

---

## What it does differently

**Decision extraction, not session capture.** purpl-brain reads GitHub PRs, Slack threads, meeting transcripts, and ADRs and extracts concluded decisions — the choices your team settled, with rationale and attribution. A developer debugging for three hours is not a decision. Choosing `jose` over `jsonwebtoken` because of Edge compatibility is. Signal, not noise.

**The decisions that matter aren't in your ADRs.** ADRs are for decisions significant enough to warrant a formal record. Most decisions aren't, and shouldn't be — the bar exists for good reason. Those decisions live in a Slack thread that ended without a summary, a PR comment that closed without a follow-up, or an agent session nobody wrote up because it felt like an implementation detail. They are still the decisions that determine how the codebase behaves. purpl-brain ingests those sources and puts agent decisions in the same graph — so a new session can query across all of them, not just the decisions that cleared the ADR bar.

**Why, not just what.** "Team uses Redis" is a fact. "Chose Redis over Postgres because TTL-native eviction matched the access pattern and Postgres would have required a background job" is reasoning. The next agent can apply reasoning to a new decision. It cannot apply a fact. purpl-brain stores the rationale alongside the choice, and requires it at write time.

**Drift detection.** When work in progress contradicts a decision made months ago, the system surfaces it before the code ships. Two-stage detection: semantic similarity flags candidates, LLM confirmation eliminates false positives.

**Full provenance.** Every answer includes source URL, actor, and timestamp. Not "the team decided X" — "@alice closed this in favor of X on 2025-11-14, in PR #312."

---

## Validation state

Validated end-to-end for one developer plus AI agents:

- Write-back, schema validation, and retry loop
- Cross-session retrieval with citations: a decision logged by one agent session is correctly recalled by a later session with no shared context
- Multi-source ingestion: agent sessions, meeting transcripts, and local documents in the same graph
- Drift detection: tested with contradictory inputs, surfaces alerts with correct context

Not yet validated: multiple developers writing to the same graph. Whether the structured decision trail holds value when a second human joins is the open question this project is designed to answer.

**Known limitations:**

- **Impact analysis risk tiers are LLM-only.** `brain_analyze_impact` asks an LLM to classify risk as `critical`, `high`, `medium`, or `low` against a natural-language rubric. The same change described differently can produce different tiers. Decision metadata (confidence level, downstream reference count, open drift alerts, age) is not used to enforce a minimum tier. Treat the result as a first signal requiring review, not a gate.
- **Drift detection skips GitHub-sourced decisions** to reduce false positives from PR noise. Decisions extracted from GitHub PRs are not candidates for drift matching.
- **Source coverage is partial.** Agent sessions and local documents are tested. GitHub webhook ingestion is implemented but not yet run through a full validation pass. Slack ingestion is implemented and includes thread context — when a message in a monitored channel is identified as a decision, the prior thread replies are fetched and prepended so the extractor sees the full discussion, not just the conclusion.
- **The Stop hook catches sessions that close cleanly.** If a session crashes or is force-killed, the hook doesn't fire. Decisions from interrupted sessions are not recovered by this mechanism.
- **Mid-session compaction is an open problem.** A decision made three hours into a long session and then compacted before close is lost even with a working Stop hook. The hook solves the boundary case; the mid-session case is still open.
- **Logged decision quality depends on timing.** A decision logged at the moment it's made, when context is richest, is more complete than one reconstructed from a hook prompt at session close.

---

## Real numbers

Measured against the builder's own eval suite and manually labeled test cases — not independently verified.

### Agentic value-add ([`eval:agent-value`](apps/api/src/scripts/eval/eval-agent-value.ts))

A/B comparison: same model, same 3 tasks, same LLM judge — only difference is whether brain context (~400 tokens via `POST /brain/query`) was injected before dispatch. Run locally with Ollama (`llama3.1:8b` agent, `qwen2.5:7b` judge), no cloud API required.

| Metric | Cold start | Brain-assisted | Delta |
|---|---|---|---|
| Decision alignment rate | 17% (1/6) | **100% (6/6)** | +5 decisions |
| Contradiction rate | 67% (4/6) | **0% (0/6)** | −4 contradictions |
| Explicit citation rate | 17% (1/6) | 33% (2/6) | +1 |

Without context the agent picked the wrong validation library (Joi instead of Zod), wrong rate limiting layer (handler-level instead of Fastify plugin), wrong error format (custom instead of RFC 7807), and wrong auth approach (server-side sessions instead of stateless JWT) — on 4 of 6 relevant decisions. With ~400 tokens of brain context injected, all 6 were correct and zero contradictions were introduced.

To reproduce: `npm run eval:agent-value -w apps/api` (requires Ollama running with `llama3.1:8b` and `qwen2.5:7b`).

### Pipeline and retrieval

| Eval | Result | What it measures |
|---|---|---|
| Cross-session recall | **5/5 (100%)** | Decisions logged by 3 different agents over 3 weeks, recalled correctly by a new session with no prior context |
| End-to-end answer recall | **95.5%** | 21/22 queries answered correctly or partially against honojs/hono public corpus (qwen2.5:7b + llama3.1:8b) |
| Pipeline correctness | **33/33 PASS** | Full pipeline: ingestion → extraction → graph integrity → query → drift detection |
| MCP tool correctness | **8/8 PASS** | All 4 MCP tools verified against REST API equivalents |
| Drift detection recall | **≥ 80%** | Known contradictions caught; < 8% false positive rate on benign content |
| Citation faithfulness | **0 fabricated** | Every cited source_url and quoted_text verified against source documents |
| Attribution accuracy | **5/5 (100%)** | actor.id, source type, and quote overlap correct across 5 agent_ids |
| Query latency p50 / p95 | **13.6s / 27.8s** | Ollama local (llama3.1:8b); ~2s on cloud API (Claude / Bedrock) |

---

## How it works

```
Signal sources: GitHub PRs · Slack · meetings · ADRs · agent sessions
  │
  ▼  normalizer (rule-based schema normalisation — no LLM)
  ▼  extractor (LLM: extract decisions, people, tickets, linked PR threads)
  │
  ├──▶  brain-writer ──▶  Neo4j (graph) + Qdrant (vectors)
  └──▶  drift-detector ──▶  DriftAlert nodes in Neo4j

Agent session (brain_log_decision)
  └──▶  bypass extractor ──▶  directly into the brain

Query (brain_query)
  └──▶  embed → Qdrant ANN search → Neo4j graph expand → LLM answer with citations
```

**Why two databases:** Qdrant finds semantically related chunks. Neo4j expands from those entry points to full causal context — who decided what, which tickets it affected, what drift it triggered. Neither alone answers both types of query.

---

## The four MCP tools

Add purpl-brain to Claude Code. Four tools become available in every session:

| Tool | When to call |
|------|-------------|
| `brain_query` | **Session start — every session.** Recall prior decisions, open drift alerts, and what prior agents already figured out. This is where the cross-session memory value is felt immediately. |
| `brain_log_decision` | **When a decision is made — mid-session, not just at close.** Log what you decided, what you rejected, and why. The rationale is what makes the next session's query useful. |
| `brain_log_signal` | When you find something unexpected — report a finding that may contradict an existing decision. |
| `brain_analyze_impact` | Before a significant architectural change — check which prior decisions your change affects. **Requires a critical mass of decisions in the brain to return useful results. On Ollama, expect 30–60s latency; Claude may proceed without waiting if the call is slow.** Most valuable after the first week of active use. |

Four tools, not fifty-three. The discipline is the product. If decisions are logged explicitly, they are precise, attributed, and queryable. If everything is captured automatically, you get a session dump — not a decision trail.

**The core loop that delivers value immediately:** log decisions in session one → start session two cold → run `brain_query` → Claude already knows what was decided and why, without you telling it. Everything else builds on top of that.

Add the CLAUDE.md snippet from `setup.sh` to your project repo and these calls happen automatically, not by model judgment.

---

## Quick start

**Prerequisites:** Docker Desktop, Node.js 20+, [Ollama](https://ollama.ai) with `nomic-embed-text:v1.5`, `qwen2.5:7b`, and `llama3.1:8b` pulled

```bash
git clone https://github.com/skalrn/purpl_brain
cd purpl_brain
bash setup.sh
```

`setup.sh` writes `.env`, builds the MCP server, starts all services via `docker compose`, and prints a ready-to-paste MCP config and CLAUDE.md snippet. Ollama runs on the host; the containers reach it via `host.docker.internal`.

### Pre-built images

No source build needed. Requires Docker and Ollama running on the host.

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME -p YOUR_GITHUB_PAT
cp .env.example .env
# Set LLM_PROVIDER=ollama (default) — no API keys required
docker compose -f docker-compose.prod.yml up -d
```

API: `http://localhost:3001/health`

---

## LLM provider options

| | Ollama path (default) | Anthropic path |
|---|---|---|
| LLM | qwen2.5:7b (extraction) + llama3.1:8b (query) | Claude Haiku |
| Embeddings | nomic-embed-text:v1.5 | nomic-embed-text:v1.5 (Ollama still required) |
| Avg query latency | ~14s (p50), ~28s (p95) | ~2s |
| External keys | None | Anthropic API key |
| Cost | Free | ~$5–15/month active team |
| Test status | **Tested** | **Not yet verified end-to-end** |

Both paths use Ollama for embeddings (`nomic-embed-text:v1.5` — always required). This keeps a single embedding space so you can switch LLM providers without re-indexing Qdrant.

The Anthropic path has not been run through a full integration test. If you try it and hit issues, please open an issue.

---

## Wiring the MCP server

Paste into `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["/absolute/path/to/purpl_brain/apps/mcp/dist/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3001",
        "BRAIN_API_KEY": "<your-key-from-setup.sh>",
        "BRAIN_AGENT_ID": "claude-code"
      }
    }
  }
}
```

**Make Claude call these automatically** by adding the CLAUDE.md snippet printed by `setup.sh` to your project repo. Without it, tool calls depend on model judgment and will be inconsistent.

**CLAUDE.md instructions are aspirational. Hooks are deterministic.** Under context pressure — long sessions, compaction events — agents make judgment calls about what counts as significant, and those calls degrade with less context. The Stop hook in `.claude/hooks/` solves this at the boundary: it checks the brain API for decisions logged in the last two hours, and if none are found, returns exit code 2 to block the session from closing. The agent reads the message, calls `brain_log_decision`, and the hook clears. CLAUDE.md shapes behavior during the session. The hook enforces the invariant at the boundary. Both layers are necessary.

> **Note:** The example hook scripts in `.claude/hooks/` use `skalrn_purpl_brain` as the project ID. If you copy them manually, change `PROJECT_ID` at the top of each script to match your own project. Running `setup.sh` does this automatically.

---

## Connect signal sources

### GitHub

```bash
# Backfill existing PRs and linked PR comment threads:
GITHUB_TOKEN=ghp_... npm run seed:github -w apps/api -- --repo org/repo --limit 50
```

For live ingestion: configure a GitHub webhook to `POST /webhooks/github`.

### Slack

```bash
# In .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL_IDS
npm run worker:slack -w apps/api
```

### ADRs and local docs

```bash
npm run seed:local-docs -w apps/api -- \
  --dir ./docs \
  --project my_project \
  --base-url https://github.com/org/repo/blob/main/docs
```

Attribution resolved from git history. Linked GitHub PR threads are automatically followed and ingested.

### Drift notifications

When a drift alert is confirmed, the drift-detector can POST to any HTTP endpoint — a Slack incoming webhook, a coordinator agent, a custom URL:

```bash
# In .env:
DRIFT_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Payload:

```json
{
  "alert_id": "...",
  "project_id": "...",
  "risk": "high",
  "challenged_decision_summary": "Use stateless JWT — no server-side token store",
  "challenging_content": "Decision: Store tokens in Redis with TTL 24h...",
  "reason": "Introduces server-side token persistence, contradicting the JWT-only decision.",
  "actor": "claude-code",
  "timestamp": "..."
}
```

Leave `DRIFT_WEBHOOK_URL` unset to disable. Only LLM-confirmed conflict alerts fire the webhook — confirmations do not.

### Meeting transcripts

```bash
curl -X POST http://localhost:3001/brain/ingest/transcript \
  -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"text": "...", "title": "Auth design review", "project_id": "my_project"}'
```

---

## Verify everything works

```bash
bash demo.sh verify    # checks all services, auth, query, CORS
```

End-to-end evals:

```bash
npm run eval:integration -w apps/api   # 33 checks, full pipeline
npm run eval:mcp -w apps/mcp           # 8 checks, all MCP tools
```

---

## Architecture and design documents

| Audience | Document |
|----------|----------|
| Architecture deep dive | [docs/technical/architecture.md](docs/technical/architecture.md) |
| Agent write-back design | [docs/technical/adrs/004-agent-decision-trails.md](docs/technical/adrs/004-agent-decision-trails.md) |
| Embedding model selection | [docs/technical/adrs/005-embedding-model.md](docs/technical/adrs/005-embedding-model.md) |
| Drift coordination flow (sequence diagrams) | [docs/technical/drift-flow.md](docs/technical/drift-flow.md) |
| LLM cost controls and prompt caching | [docs/technical/llm-cost-controls.md](docs/technical/llm-cost-controls.md) |
| Design tradeoffs | [docs/technical/architecture-tradeoffs.md](docs/technical/architecture-tradeoffs.md) |

---

## Running locally without Docker

```bash
docker compose up -d redis neo4j qdrant   # infra only
npm run dev -w apps/api                   # API on :3001
npm run worker:normalizer -w apps/api
npm run worker:extractor -w apps/api
npm run worker:brain-writer -w apps/api
npm run worker:drift -w apps/api
```

