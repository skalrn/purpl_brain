---
sidebar_position: 1
---

# Setup

## Prerequisites

- Docker and Docker Compose
- Node.js >= 18
- A GitHub account (for webhook registration and GitHub token)

## Start the brain

```bash
# Clone the repo
git clone https://github.com/skalrn/purpl_brain.git
cd purpl_brain

# Copy and fill in environment variables
cp .env.example .env
# Edit .env with your values (see below)

# Start all services
docker compose up -d
```

The compose stack starts: the API server, Qdrant, Neo4j, Redis, and the web UI. On first start, Neo4j schema migrations run automatically.

Verify everything is running:
```bash
curl http://localhost:3001/health
# { "status": "ok", "neo4j": "ok", "qdrant": "ok", "redis": "ok" }
```

## Environment variables

Required:

```bash
# Brain API
BRAIN_API_KEY=your-secret-key-here         # used to authenticate API calls
SESSION_SECRET=another-secret-for-sessions

# Neo4j
NEO4J_AUTH=neo4j/your-neo4j-password

# GitHub (for webhook ingestion and link-following)
GITHUB_TOKEN=ghp_your_token_here           # read:repo scope minimum
GITHUB_WEBHOOK_SECRET=your-webhook-secret

# LLM (for extraction and query)
ANTHROPIC_API_KEY=sk-ant-your-key-here
OPENAI_API_KEY=sk-your-key-here            # for embeddings (text-embedding-3-small)
```

Optional (tuning):

```bash
# Drift detection threshold (default 0.72 — do not lower without testing)
DRIFT_SEMANTIC_THRESHOLD=0.72

# Link-following SSRF protection
# Comma-separated "owner/repo" pairs. Empty = allow all (safe for self-hosted)
GITHUB_LINK_FOLLOW_ALLOWLIST=myorg/myrepo,myorg/other-repo
```

## Configure MCP for Claude Code

Build the MCP server:
```bash
cd apps/mcp && npm run build
```

Add to `~/.claude/settings.json`:
```json
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["/absolute/path/to/purpl_brain/apps/mcp/dist/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3001",
        "BRAIN_API_KEY": "your-secret-key-here",
        "BRAIN_AGENT_ID": "claude-code"
      }
    }
  }
}
```

Restart Claude Code. The MCP tools (`brain_query`, `brain_log_decision`, etc.) should appear in the tools list.

## Configure CLAUDE.md

Copy the brain protocol section from the root `CLAUDE.md` into your project's `CLAUDE.md`. This instructs Claude Code to query the brain at session start and log decisions mid-session. The Stop hook enforces this automatically, but the CLAUDE.md instructions tell the agent why and when, which improves compliance.

## Install the Stop hook

The Stop hook is at `.claude/hooks/check-brain-decisions.sh`. Make it executable:

```bash
chmod +x .claude/hooks/check-brain-decisions.sh
```

Register it in `.claude/settings.json`:
```json
{
  "hooks": {
    "Stop": [".claude/hooks/check-brain-decisions.sh"]
  }
}
```

The hook queries Neo4j at session end. If no decisions were logged in the past 2 hours, it exits with code 2 and prints a message to stderr, which triggers one more agent turn to write the missing decisions.

The hook requires `NEO4J_AUTH` to be set in the environment where Claude Code runs. If the hook cannot connect to Neo4j, it exits 0 (silent fail — does not block the session).

## Register a GitHub webhook

In your GitHub repository settings → Webhooks → Add webhook:

- **Payload URL:** `http://your-server:3001/webhooks/github`
- **Content type:** `application/json`
- **Secret:** same as `GITHUB_WEBHOOK_SECRET` in your `.env`
- **Events:** Pull requests, Issues, Issue comments, Push

For local development, use ngrok to expose the local API:
```bash
ngrok http 3001
# Use the ngrok URL as your webhook payload URL
```

## Seed initial data

For a new project, seed the last 90 days of GitHub history:
```bash
npm run seed:github -- --repo owner/repo --project-id my-project
```

This fetches recent PRs, issues, and their comments through the GitHub API (using `GITHUB_TOKEN`) and enqueues them for processing. Seeding a typical repo with 90 days of history takes 2-5 minutes.

## Verify the installation

1. Check the health endpoint: `curl http://localhost:3001/health`
2. Run a seed on a real repo
3. Wait for processing to complete (watch `docker compose logs -f api`)
4. Open the web UI at `http://localhost:3000`
5. Query: "What are the most recent decisions in this project?"
6. Verify you get cited answers pointing to real GitHub sources

If you get empty results after seeding, check:
- `GITHUB_TOKEN` is set correctly in the container environment (not just `.env`)
- The webhook secret matches between GitHub and the `.env` file
- Neo4j is running: `docker compose ps` should show all services healthy
