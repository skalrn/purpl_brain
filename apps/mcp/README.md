# purpl-brain MCP server

Exposes the purpl-brain API to any MCP-compatible coding agent (Claude Code, Cursor, etc.) as two tools: `brain_query` (read project context with citations) and `brain_log_decision` (write this session's decisions back so the next session can find them).

The point: an agent can recover the *why* behind library choices, rejected approaches, and unresolved questions across sessions — without the developer pasting context.

## Prerequisites

- A running purpl-brain stack (API on `:3001`, Redis, Qdrant, Neo4j, and the three pipeline workers). See repo root for stack setup.
- An API key for `/brain/agent-log`. Generate one via the API's key issuance flow and export it.

## Install

```bash
cd apps/mcp
npm install
npm run build
```

This produces `dist/index.js`. The shebang and executable bit are already set; clients can spawn it directly with `node`.

## Claude Code setup

Merge the `mcpServers` block from [`claude-code-config.example.json`](./claude-code-config.example.json) into `~/.claude/settings.json`. Replace the placeholder path with the absolute path to `dist/index.js` in your checkout, and fill in `BRAIN_API_KEY`.

Restart Claude Code. The two tools should appear in the agent's tool list.

## Cursor setup

Drop [`cursor-config.example.json`](./cursor-config.example.json) (without the `_comment` key) at `.cursor/mcp.json` in your project, or merge into your global Cursor MCP config. Same path/key substitution as above; `BRAIN_AGENT_ID` should be `cursor` so logged decisions are attributed correctly.

## How the agent uses it

Both tools are described in a way that triggers the agent automatically — the developer does not need to prompt for them.

- **`brain_query`** — the agent fires this at session start when working on an existing project, or before making any architectural / library decision that may have been settled previously. It returns a cited answer grounded in GitHub PRs, Slack threads, Jira tickets, meeting transcripts, and prior agent decision logs.

- **`brain_log_decision`** — the agent fires this when it makes a significant architectural choice, picks a library, rejects an approach, or flags an unresolved question. The decision is ingested through the same pipeline as human signals, so the next session (human or agent) retrieves it with a citation back to the originating agent and session ID.

The loop closes when Session N+1 retrieves what Session N logged — with no human in the middle.

## LangGraph and ADK agents (Python SDK)

Agents built with LangGraph, Google ADK, or any Python orchestration framework cannot use the MCP server. Use the Python SDK instead — it wraps the same four REST endpoints.

```bash
# from repo root
pip install -e "packages/python[langgraph]"   # LangGraph / LangChain
pip install -e "packages/python[adk]"          # Google ADK
```

**LangGraph:**
```python
from purpl_brain import BrainClient, langgraph_tools
from langgraph.prebuilt import create_react_agent

client = BrainClient()  # reads BRAIN_API_URL + BRAIN_API_KEY from env
agent = create_react_agent(model, langgraph_tools(client))
```

**Google ADK:**
```python
from purpl_brain import BrainClient, adk_tools
from google.adk.tools import FunctionTool
from google.adk import Agent

client = BrainClient()
agent = Agent(
    name="my_agent",
    model="gemini-2.0-flash",
    tools=[FunctionTool(fn) for fn in adk_tools(client)],
)
```

See `packages/python/examples/` for full session lifecycle examples (query at start → impact check mid-session → log decisions at end).

## Verify it works

From `apps/api`, with the full stack running and `BRAIN_API_KEY` set:

```bash
npm run demo:agent-memory
```

This runs an end-to-end demo: logs a decision via `/brain/agent-log`, waits for the pipeline, then queries as a fresh session and checks that the answer references the logged decision with a citation. PASS means the agent memory loop is closing.
