# purpl-brain

**Institutional knowledge that doesn't retire when your engineers do.**

purpl-brain captures what your team decided, why, and tells your next agent before it repeats the mistake.

An agent starts a session and queries the brain — retrieving the decisions your team made three months ago, the rationale behind them, and any open contradictions — before writing a line of code. When the session ends, its own decisions are written back in. The next session — different agent, different engineer, different week — picks up with full context. The team does nothing between them.

---

## The problem

Your agents are starting cold on a codebase your team has been building for years.

They don't know you chose PostgreSQL over MongoDB because of your compliance requirement. They don't know you rejected the microservices rewrite six months ago. They don't know the JWT expiry was shortened after a security audit, not arbitrarily. Every session, they rediscover or — worse — contradict decisions your team already made.

CLAUDE.md files cap out at a few hundred lines and go stale. Session history captures noise, not signal. Decisions happen in Slack threads, Jira comments, design reviews, and PR discussions — none of which any agent has access to at session start.

---

## What purpl-brain does differently

**Decision extraction, not session capture.** purpl-brain reads your GitHub PRs, Slack threads, Jira tickets, meeting transcripts, and ADRs and extracts concluded decisions — the choices your team settled, with rationale and attribution. A developer debugging for three hours is not a decision. Choosing jose over jsonwebtoken because of Edge compatibility is. purpl-brain stores signal, not noise.

**Multi-source truth.** The real decision usually happened before the agent was involved — in a design review, a Slack debate, a PR comment thread. purpl-brain ingests where your team actually decides things. An agent session is just one more signal source, not the only one.

**Drift detection.** When work in progress contradicts a decision made months ago, purpl-brain surfaces it before the code ships — not in the post-mortem. Two-stage detection: semantic similarity flags candidates, LLM confirmation eliminates false positives.

**Full provenance.** Every answer includes source URL, actor, and timestamp. Not "the team decided X" — "@alice closed this in favor of X on 2025-11-14, referencing Jira ticket AUTH-312."

---

## Real numbers

| Eval | Result | What it measures |
|---|---|---|
| Cross-session recall | **5/5 (100%)** | Decisions logged by 3 different agents over 3 weeks, recalled correctly by a new session with no prior context |
| Decision extraction F1 | **85.7%** | Precision 92.3% / Recall 80.0% — against manually labeled ground truth on 30 real GitHub PRs |
| End-to-end answer recall | **91%** | Cold ingestion of Backstage (Spotify) public ADRs — 11/12 ground-truth questions answered correctly |
| Pipeline correctness | **33/33 PASS** | Full pipeline: ingestion → extraction → graph integrity → query → drift detection |
| MCP tool correctness | **8/8 PASS** | All 4 MCP tools verified against REST API equivalents |
| Drift detection recall | **≥ 80%** | Known contradictions caught; < 8% false positive rate on benign content |
| Citation faithfulness | **0 fabricated** | Every cited source_url and quoted_text verified against source documents |
| Query latency p50 / p95 | **4.7s / 9.8s** | Anthropic Claude Haiku, cross-session queries |

---

## How it works

```
Signal sources: GitHub PRs · Slack · Jira · meetings · ADRs · agent sessions
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

**Why two databases:** Qdrant finds semantically related chunks. Neo4j expands from those entry points to full causal context — who decided what, which tickets it affected, what drift it triggered. Neither alone answers both types of query. See [ADR-001](docs/technical/adrs/001-hybrid-brain-store.md).

---

## The four MCP tools

Add purpl-brain to Claude Code or Cursor. Four tools become available in every session:

| Tool | When to call |
|------|-------------|
| `brain_query` | Session start — recall prior decisions and open drift alerts before touching anything |
| `brain_log_decision` | Session end — log what you decided, what you rejected, and why |
| `brain_analyze_impact` | Before any architectural change — check which decisions your change affects |
| `brain_log_signal` | When you find something unexpected — report findings that may contradict existing decisions |

Four tools, not fifty-three. The discipline is the product. If decisions are logged explicitly, they are precise, attributed, and queryable. If everything is captured automatically, you get a session dump — not institutional knowledge.

Add the CLAUDE.md snippet from `setup.sh` to your project repo and these calls happen automatically, not by model judgment.

---

## Quick start

**Prerequisites:** Docker Desktop, Node.js 20+, Anthropic API key, OpenAI API key (embeddings)

```bash
git clone https://github.com/skalrn/purpl_brain
cd purpl_brain
bash setup.sh
```

`setup.sh` collects your keys, writes `.env`, builds the MCP server, starts all services via `docker compose`, and prints a ready-to-paste MCP config and CLAUDE.md snippet.

### Beta testers (pre-built images)

No source build needed. Requires Docker and a GitHub account with access to the GHCR images.

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME -p YOUR_GITHUB_PAT
cp .env.example .env
# Fill in ANTHROPIC_API_KEY + OPENAI_API_KEY (or set LLM_PROVIDER=ollama)
docker compose -f docker-compose.prod.yml up -d
```

Web UI: `http://localhost:3000` · API: `http://localhost:3001/health`

---

## LLM provider options

| | Anthropic path | Ollama path |
|---|---|---|
| LLM | Claude Haiku (extraction + query) | gemma3n:e2b + gemma2:9b |
| Embeddings | OpenAI text-embedding-3-small | nomic-embed-text:v1.5 |
| Avg query latency | ~7s | ~60–90s |
| External keys | Anthropic + OpenAI | None |
| Cost | ~$5–15/month active team | Free |

Both paths produce 768-dim vectors — the Qdrant collection is compatible between providers.

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

For Cursor: `apps/mcp/cursor-config.example.json`.

**Make Claude call these automatically** — add the CLAUDE.md snippet printed by `setup.sh` to your project repo. Without it, tool calls depend on model judgment and will be inconsistent.

Also available: `/analyze-impact` slash command. Copy `.claude/commands/analyze-impact.md` into your project's `.claude/commands/` directory for an explicit on-demand impact check before significant changes.

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

### Jira

```bash
# In .env: JIRA_BASE_URL, JIRA_WEBHOOK_SECRET
npm run seed:jira -w apps/api -- --project YOUR_PROJECT
```

### ADRs and local docs

```bash
npm run seed:local-docs -w apps/api -- \
  --dir ./docs \
  --project my_project \
  --base-url https://github.com/org/repo/blob/main/docs
```

Attribution resolved from git history. Linked GitHub PR threads are automatically followed and ingested.

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

## Snapshot and restore

```bash
bash brain-snapshot.sh my-project-v1.0          # creates brain_snapshot_my-project-v1.0.tar.gz
bash brain-snapshot.sh my-project-v1.0 --push   # also creates a GitHub release
bash brain-restore.sh brain_snapshot_my-project-v1.0.tar.gz
```

---

## Architecture and design documents

| Audience | Document |
|----------|----------|
| Business / investors | [docs/pitch/business-brief.md](docs/pitch/business-brief.md) |
| Senior engineers | [docs/pitch/technical-deep-dive.md](docs/pitch/technical-deep-dive.md) |
| Q&A / rebuttal prep | [docs/pitch/faq.md](docs/pitch/faq.md) |
| Full product vision | [docs/product/vision.md](docs/product/vision.md) |
| Architecture deep dive | [docs/technical/architecture.md](docs/technical/architecture.md) |
| Why Qdrant + Neo4j | [docs/technical/adrs/001-hybrid-brain-store.md](docs/technical/adrs/001-hybrid-brain-store.md) |
| Why MCP | [docs/technical/adrs/002-mcp-server-interface.md](docs/technical/adrs/002-mcp-server-interface.md) |
| Why Redis Streams | [docs/technical/adrs/003-event-driven-ingestion.md](docs/technical/adrs/003-event-driven-ingestion.md) |
| Agent write-back design | [docs/technical/adrs/004-agent-decision-trails.md](docs/technical/adrs/004-agent-decision-trails.md) |

---

## Running locally without Docker

```bash
docker compose up -d redis neo4j qdrant   # infra only
npm run dev -w apps/api                   # API on :3001
npm run worker:normalizer -w apps/api
npm run worker:extractor -w apps/api
npm run worker:brain-writer -w apps/api
npm run worker:drift -w apps/api
npm run dev -w apps/web                   # web UI on :3000
```

---

## Releasing

Push a branch prefixed `release-` to trigger the GitHub Actions build:

```bash
git checkout -b release-beta-0.1.0
git push
```

Builds obfuscated Docker images and pushes to GHCR:
- `ghcr.io/skalrn/purpl-brain-api:beta-latest`
- `ghcr.io/skalrn/purpl-brain-web:beta-latest`

Stable releases: `release-0.1.0` → tags `0.1.0` and `latest`.
