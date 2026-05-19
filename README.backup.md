# purpl-brain

Shared, auditable, cross-agent working memory for AI-assisted software teams.

An agent finishes a session and logs its decisions to the brain. The next session — different IDE, different week, different agent — reads those decisions back with full citations before writing a line of code. The developer does nothing between them.

**Eval results (real numbers, not marketing):**
- 91% recall on Backstage (Spotify) public ADRs — cold ingestion, 11/12 ground-truth questions answered correctly
- 33/33 integration eval PASS — full pipeline: ingestion → extraction → graph integrity → query → drift detection
- ~7s average query latency with Anthropic Claude Haiku
- 8/8 MCP tool eval PASS

---

## Documentation

| Audience | Document |
|----------|----------|
| Business / investors | [docs/pitch/business-brief.md](docs/pitch/business-brief.md) |
| Senior engineers / architects | [docs/pitch/technical-deep-dive.md](docs/pitch/technical-deep-dive.md) |
| Q&A / rebuttal prep | [docs/pitch/faq.md](docs/pitch/faq.md) |
| Full product vision | [docs/product/vision.md](docs/product/vision.md) |
| Architecture deep dive | [docs/technical/architecture.md](docs/technical/architecture.md) |
| Why Qdrant + Neo4j | [docs/technical/adrs/001-hybrid-brain-store.md](docs/technical/adrs/001-hybrid-brain-store.md) |
| Why MCP | [docs/technical/adrs/002-mcp-server-interface.md](docs/technical/adrs/002-mcp-server-interface.md) |
| Why Redis Streams | [docs/technical/adrs/003-event-driven-ingestion.md](docs/technical/adrs/003-event-driven-ingestion.md) |
| Agent write-back design | [docs/technical/adrs/004-agent-decision-trails.md](docs/technical/adrs/004-agent-decision-trails.md) |
| Query layer spec | [docs/technical/query-layer.md](docs/technical/query-layer.md) |
| LLM cost controls | [docs/technical/llm-cost-controls.md](docs/technical/llm-cost-controls.md) |
| Risk register | [docs/risk/risk-register.md](docs/risk/risk-register.md) |

---

## Quick start (10 minutes, source build)

**Prerequisites:** Docker Desktop, Node.js 20+, Anthropic API key + OpenAI API key (for embeddings)

```bash
git clone https://github.com/skalrn/purpl_brain
cd purpl_brain
bash setup.sh
```

`setup.sh` collects your API keys, writes `.env`, builds the MCP server, starts all services via `docker compose`, and prints a ready-to-paste Claude Code MCP config + CLAUDE.md snippet.

### Quick start (beta tester, pre-built images)

No source code needed. Requires Docker and a GitHub account with access to the GHCR images.

```bash
docker login ghcr.io -u YOUR_GITHUB_USERNAME -p YOUR_GITHUB_PAT
cp .env.example .env
# Edit .env: fill in ANTHROPIC_API_KEY + OPENAI_API_KEY  (or set LLM_PROVIDER=ollama)
docker compose -f docker-compose.prod.yml up -d
```

Web UI: `http://localhost:3000` · API: `http://localhost:3001/health`

---

## LLM provider options

| | Anthropic path | Ollama path |
|---|---|---|
| LLM | Claude Haiku (extraction + query) | gemma3n:e2b + gemma2:9b |
| Embeddings | OpenAI text-embedding-3-small (768-dim) | nomic-embed-text:v1.5 (768-dim) |
| Avg query latency | ~7s | ~60-90s (hardware dependent) |
| External dependency | Anthropic API key + OpenAI API key | Ollama running on host |
| Cost | ~$5-15/month active team | Free |

Both paths produce 768-dim vectors — the Qdrant collection is compatible between providers.

---

## MCP tools (Claude Code / Cursor)

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

See `apps/mcp/claude-code-config.example.json` for a ready-to-paste template. For Cursor: `apps/mcp/cursor-config.example.json`.

| Tool | When to call |
|------|-------------|
| `brain_query` | Session start — recall prior decisions and open drift alerts |
| `brain_log_decision` | Session end — log what you decided and why |
| `brain_analyze_impact` | Before refactoring — check which decisions your change affects |
| `brain_log_signal` | When you find something unexpected — report findings that may contradict past decisions |

Also available: `/analyze-impact` slash command. Copy `.claude/commands/analyze-impact.md` into your project's `.claude/commands/` directory.

**Make Claude call these automatically** — add the snippet printed by `setup.sh` to your project's `CLAUDE.md`. Without it, tool calls depend on model judgment and will be inconsistent.

---

## Architecture

```
Signal sources (GitHub / Slack / Jira / meetings / agent sessions)
  │
  ▼
POST webhook or seed script
  │
  ▼
Redis Streams: events:raw
  │
  ▼  normalizer worker (rule-based schema normalisation — no LLM)
Redis Streams: events:normalized
  │
  ▼  extractor worker (LLM: extract decisions, people, tickets)
Redis Streams: events:extracted
  │
  ├──▶  brain-writer worker ──▶  Neo4j (graph) + Qdrant (vectors)
  └──▶  drift-detector worker ──▶  DriftAlert nodes in Neo4j

Agent session (POST /brain/agent-log)
  └──▶  bypass LLM extractor ──▶  directly to events:extracted
        (agent output is pre-structured — no LLM re-extraction needed)

Query (POST /brain/query or brain_query MCP tool)
  └──▶  embed query (768-dim)
         └──▶  Qdrant ANN search (has_decisions=true filter, project_id filter)
                └──▶  Neo4j graph expand (Event + Decision + Person + Ticket)
                       └──▶  LLM answer with citations (source_url, actor, timestamp)
```

**Why two databases:** Qdrant finds semantically related chunks (cosine similarity). Neo4j expands from those entry points to the full causal/relational context — who decided what, what tickets it affected, what drift alerts it triggered. Neither alone answers both types of query. See [ADR-001](docs/technical/adrs/001-hybrid-brain-store.md).

---

## Connect signal sources

### GitHub

```bash
# Backfill existing PRs (no webhook/public URL needed):
GITHUB_TOKEN=ghp_... npm run seed:github -w apps/api -- --repo org/repo --limit 50
```

For live ingestion: configure a GitHub webhook to `https://your-domain/webhooks/github` with the `GITHUB_WEBHOOK_SECRET` from `.env`.

### Slack

```bash
# In .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL_IDS
npm run worker:slack -w apps/api
```

### Jira

```bash
# In .env: JIRA_BASE_URL, JIRA_WEBHOOK_SECRET
npm run seed:jira -w apps/api -- --project MY_PROJECT
```

### Local docs / ADRs

```bash
npm run seed:local-docs -w apps/api -- \
  --dir ./docs \
  --project my_project \
  --base-url https://github.com/org/repo/blob/main/docs
```

Attribution is resolved from git history — first commit author for ADRs, collective for general docs.

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
bash demo.sh verify    # checks all services + auth + query + CORS
```

End-to-end eval:

```bash
npm run eval:integration -w apps/api   # 33 checks, full pipeline
npm run eval:mcp -w apps/mcp           # 8 checks, all MCP tools
```

---

## Snapshot and restore

Export the full brain state (Neo4j graph + Qdrant vectors + metadata) to a portable archive:

```bash
bash brain-snapshot.sh my-project-v1.0          # creates brain_snapshot_my-project-v1.0.tar.gz
bash brain-snapshot.sh my-project-v1.0 --push   # also creates a GitHub release
```

Restore on any machine:

```bash
bash brain-restore.sh brain_snapshot_my-project-v1.0.tar.gz   # from local file
bash brain-restore.sh my-project-v1.0                          # from GitHub release
```

---

## Running workers outside Docker (local dev)

```bash
docker compose up -d redis neo4j qdrant   # infra only
npm run dev -w apps/api                   # API on :3001
npm run worker:normalizer -w apps/api
npm run worker:extractor -w apps/api
npm run worker:brain-writer -w apps/api
npm run worker:drift -w apps/api
npm run dev -w apps/web                   # web UI on :3000
```

Apply Neo4j constraints once after first start:

```bash
npm run migrate:constraints -w apps/api
```

---

## Cutting a release

```bash
git checkout -b release-beta-0.1.0
git push
```

GitHub Actions builds obfuscated Docker images and pushes to GHCR:
- `ghcr.io/skalrn/purpl-brain-api:beta-latest`
- `ghcr.io/skalrn/purpl-brain-web:beta-latest`

For stable releases: `release-0.1.0` → tags `0.1.0` and `latest`.
