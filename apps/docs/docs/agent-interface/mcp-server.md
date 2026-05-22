---
sidebar_position: 2
---

# MCP Server

## Setup

**Step 1: Build the server**

```bash
cd apps/mcp && npm run build
```

**Step 2: Add to Claude Code**

Merge this into `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/purpl_brain/apps/mcp/dist/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3001",
        "BRAIN_API_KEY": "your-api-key-here",
        "BRAIN_AGENT_ID": "claude-code"
      }
    }
  }
}
```

**Step 3: Start the brain API**

```bash
docker compose up -d
```

The MCP server requires the brain API to be running. If the API is unreachable, all tool calls will return error responses.

**Remote / HTTP transport:**

```bash
MCP_TRANSPORT=http MCP_PORT=3002 node apps/mcp/dist/index.js
```

Set `BRAIN_API_URL` to your deployed brain URL. Required for AWS-hosted deployments (Phase 3 M6).

**Cursor setup:**

See `apps/mcp/cursor-config.example.json` for the Cursor-specific configuration format.

## The four tools

### `brain_query`

Query the brain for decisions, architecture context, and team knowledge.

```
Required:
  query:      string   — natural language question
  project_id: string   — brain project namespace

Optional:
  mode:       "project" | "expertise" | "agent_resume"   — default "project"
```

Call this at session start before touching any file. Call it before answering any question that asks whether, why, or how to change the system.

```
brain_query(
  query: "What are the most recent decisions and open questions for the auth module?",
  project_id: "skalrn_purpl_brain"
)
```

Returns: a grounded answer with inline citations `[1]`, `[2]`, etc., and a source list at the end. Each source includes type, actor, timestamp, and URL.

### `brain_log_decision`

Write agent session decisions into the brain. Call this the moment a significant decision is made — not at session end.

```
Required:
  session_id:     string   — timestamp-slug or UUID, unique per agent session
  project_id:     string
  work_completed: string   — short summary of what was built or changed
  decisions:      array of:
    id:                     string   — short kebab-case slug
    description:            string   — what was decided (min 20 chars)
    rationale:              string   — why this choice was made
    alternatives_considered?: string[]
    confidence?:            "high" | "medium" | "low"

Optional:
  files_modified:   string[]
  next_steps:       string[]
  unresolved:       string[]
```

The API returns 422 with structured `violations[]` if `description` is under 20 characters or `rationale` is missing. The API returns 202 with `warnings[]` if `alternatives_considered` is absent — the decision is accepted but flagged for improvement.

```typescript
brain_log_decision({
  session_id: "2026-05-22-auth-session",
  project_id: "skalrn_purpl_brain",
  work_completed: "Added session revocation support to auth-service",
  decisions: [{
    id: "redis-revocation-list",
    description: "Store revocation list in Redis, not Postgres",
    rationale: "Low-latency lookup on every request; TTL-native eviction avoids scheduled cleanup jobs",
    alternatives_considered: ["Postgres", "in-memory with restart-risk"],
    confidence: "high"
  }],
  files_modified: ["apps/api/src/auth/revocation.ts"],
  unresolved: ["Do we need a per-user revoke-all endpoint?"],
})
```

### `brain_analyze_impact`

Before a significant change, check which prior decisions it may affect.

```
Required:
  change_description: string   — plain-English description of the proposed change
  project_id:         string
```

Run this before any change that touches ingestion workers, the brain store, query layer, API routes, or data schemas.

```
brain_analyze_impact(
  change_description: "Changing the drift detector threshold from 0.72 to 0.60",
  project_id: "skalrn_purpl_brain"
)
```

Returns: overall risk level, affected decisions with rationale, and recommended next steps.

### `brain_log_signal`

Report an unexpected finding that may contradict existing decisions.

```
Required:
  text:       string   — description of the unexpected finding
  project_id: string

Optional:
  source:     "github" | "slack" | "jira" | "meeting" | "agent" | "document"
              — default "agent"
```

Call this when you discover a library limitation, API constraint, performance finding, or behavior that conflicts with a prior decision — before continuing work.

```
brain_log_signal(
  text: "jose@5.x has a JWE incompatibility that breaks the token format we decided on in PR #89. The decision to use jose should be revisited.",
  project_id: "skalrn_purpl_brain",
  source: "agent"
)
```

## Session start pattern

The complete recommended session start pattern:

```
1. Call brain_query with the current task description
2. Read the returned context before touching any file
3. If the task touches a significant system area, call brain_analyze_impact
4. Proceed with work
5. Call brain_log_decision each time a significant choice is made (not at session end)
6. If you discover something contradicting prior decisions, call brain_log_signal immediately
```

This is enforced in Claude Code via the Stop hook — the hook queries Neo4j at session end and if no decisions were logged in the past 2 hours, it exits with code 2 and a stderr message that triggers one more agent turn to write the missing decisions.
