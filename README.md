# purpl_brain

Shared, auditable memory for AI coding agents and the teams working with them.

An agent finishes a session and logs its decisions to the brain. The next session — different IDE, different week, different agent — reads those decisions back with citations before doing anything. The developer does nothing between them.

## Quick start (5 minutes)

### 1. Prerequisites

- Docker Desktop running
- Node.js 20+
- An Anthropic API key (`sk-ant-...`)

### 2. Install and start

```bash
git clone https://github.com/skalrn/purpl_brain
cd purpl_brain
bash setup.sh
```

The setup script will:
- Collect your Anthropic API key and a project name
- Write `apps/api/.env` and generate a local API key
- Build the MCP server
- Start everything via `docker compose up -d --build`:
  - Infrastructure: Redis, Neo4j, Qdrant
  - API on `:3001`
  - All four workers: normalizer, extractor, brain-writer, drift-detector
- Print a ready-to-paste Claude Code / Cursor MCP config

Target: < 10 minutes from `git clone` to first query.

### 3. Add the MCP server to Claude Code

Paste into `~/.claude/settings.json` (create if it doesn't exist):

```json
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["/absolute/path/to/purpl_brain/apps/mcp/dist/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3001",
        "BRAIN_API_KEY": "<your-key-from-apps-api-env>",
        "BRAIN_AGENT_ID": "claude-code"
      }
    }
  }
}
```

See `apps/mcp/claude-code-config.example.json` for a ready-to-paste snippet. For Cursor, see `apps/mcp/cursor-config.example.json`.

### 4. Verify the loop works

```bash
cd apps/api
BRAIN_API_KEY=<your-key> npm run demo:agent-memory
```

This simulates two sessions — a write and a read — and prints a pass/fail verdict. If it passes, the agent memory loop is working end-to-end.

### 5. Start a Claude Code session

Open any repo you're working on. Claude Code now has `brain_query` and `brain_log_decision` in its tool chain. It will:
- Call `brain_query` at session start to recall prior decisions
- Call `brain_log_decision` when it makes an architectural choice

No user prompt needed. The tool descriptions trigger the agent automatically.

---

## Connect signal sources (optional)

The brain works immediately from agent logs alone. You can enrich it with your team's existing signal history:

### GitHub

```bash
# In apps/api/.env, add:
GITHUB_TOKEN=ghp_...

# Seed a repo (fetches last 50 PRs):
npm run seed:github -w apps/api -- --repo org/repo --limit 50
```

### Slack

```bash
# In apps/api/.env, add:
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_IDS=C01234,C05678

# Start the Slack listener:
npm run worker:slack -w apps/api
```

### Jira

```bash
# In apps/api/.env, add:
JIRA_BASE_URL=https://myorg.atlassian.net
JIRA_WEBHOOK_SECRET=...

# Seed existing issues:
npm run seed:jira -w apps/api -- --project MY_PROJECT
```

### Meeting transcripts

```bash
# Paste a VTT, SRT, or plain-text transcript via API:
curl -X POST http://localhost:3001/brain/ingest/transcript \
  -H "Authorization: Bearer <key>" \
  -H "Content-Type: application/json" \
  -d '{"text": "...", "title": "Auth design review", "project_id": "my_project"}'
```

---

## Web UI

A query interface is available at `http://localhost:3000` after running:

```bash
npm run dev -w apps/web
```

---

## Architecture

```
Agent session
  └─ brain_log_decision (MCP tool)
       └─ POST /brain/agent-log
            └─ Redis Streams → normalizer → extractor → brain-writer
                 └─ Neo4j (graph) + Qdrant (vectors)

New agent session
  └─ brain_query (MCP tool)
       └─ POST /brain/query
            └─ embed → Qdrant search → Neo4j expand → LLM answer with citations
```

Signal sources (GitHub, Slack, Jira, meetings) flow through the same pipeline and are retrievable through the same query interface.

---

## Running workers manually (local dev outside Docker)

`setup.sh` starts the API and all four workers via `docker compose`. If you
prefer to run them on the host (faster iteration, easier debugging):

```bash
docker compose up -d redis neo4j qdrant    # infra only
npm run dev -w apps/api                    # API on :3001
npm run worker:normalizer -w apps/api      # pass 1: rule-based signal extraction
npm run worker:extractor -w apps/api       # pass 2: LLM decision extraction
npm run worker:brain-writer -w apps/api    # writes to Neo4j + Qdrant
npm run worker:drift -w apps/api           # drift detection (optional)
```

Tail Docker logs:

```bash
docker compose logs -f api extractor brain-writer
```
