# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Project Brain — a shared working memory for human-agent software teams. It ingests signals from GitHub, Slack, Jira, meetings, and AI agent sessions, maintains a continuously updated knowledge graph, and serves context to humans and agents via a natural language query interface.

The core insight: AI agents are first-class actors that both read from and write to the brain. Agent decision trails are ingested and stored alongside human-generated signals.

## Documentation Structure

All design and planning documents live in `/docs`:

```
docs/
  product/
    vision.md          # Problem, strategic bet, positioning, phase summary
    prd.md             # Requirements, features, success metrics, open questions
    personas.md        # Four personas including AI Agent as non-human actor
    roadmap.md         # Four phases with exit criteria and deliverables
  technical/
    architecture.md    # Full system design: ingestion → processing → brain store → query → interface
    query-layer.md     # Deep spec: intent parsing, retrieval modes, context budget, citation contract, latency
    entity-extraction.md  # Deep spec: two-pass hybrid extraction, source strategies, confidence scoring
    anomaly-engine.md  # Deep spec: detector implementations, false positive control, severity scoring
    phase1-implementation-plan.md  # 7 milestones, build order, tech stack, exit criterion
    llm-cost-controls.md          # Prompt caching patterns, breakpoint placement, anti-patterns
    adrs/
      001-hybrid-brain-store.md        # Vector DB + Graph DB rationale
      002-mcp-server-interface.md      # Why MCP over bespoke agent SDK; Python SDK for LangGraph/ADK
      003-event-driven-ingestion.md    # Webhook-first with Redis Streams queue
      004-agent-decision-trails.md     # Agent log schema and write-back design
  risk/
    risk-register.md   # Technical, product, market, and security risks with mitigations
```

## Key Architectural Decisions

- **Brain store:** Hybrid — Qdrant (vector) for semantic retrieval + Neo4j (graph) for causal/relational reasoning. See ADR-001.
- **Ingestion:** Webhook-first, event-driven. Redis Streams pipeline: RAW → NORMALIZED → EXTRACTED. See ADR-003.
- **Agent interface:** Three paths — (1) MCP server for Claude Code and Cursor; (2) Python SDK (`packages/python`) with LangGraph `@tool` wrappers and Google ADK callables; (3) REST API directly for any HTTP-capable agent. All four operations (query, log-decision, analyze-impact, log-signal) are available on every path. See ADR-002, ADR-004.
- **Query:** RAG + graph traversal combined. Every answer is grounded with citations to source (URL, timestamp, actor).
- **Drift detection:** Two-stage — Qdrant semantic similarity (Stage A) + LLM confirmation (Stage C). Writes `DriftAlert` nodes.

## Phase Status

- **Phase 1** ✓ complete — GitHub ingestion → brain update → natural language query with citations
- **Phase 2** ✓ complete — Multi-source ingestion (Slack, Jira, meetings, agent logs), drift detection, temporal diff, impact analysis, streaming LLM responses
- **Phase 3** in progress — MCP server (M1 ✓), agent write-back (M2 ✓), MCP eval + docs (M3 in progress), beta setup polish (M4), identity resolution (M5), AWS packaging (M6)

## MCP Setup (Claude Code)

The purpl-brain MCP server exposes 4 tools to any agent connected to the brain:

| Tool | When to use |
|------|-------------|
| `brain_query` | Query the brain for decisions, architecture context, team knowledge |
| `brain_log_decision` | Write agent session decisions back into the brain |
| `brain_analyze_impact` | Before a significant change, check which decisions it may affect |
| `brain_log_signal` | Report an unexpected finding that may contradict existing decisions |

**Local setup (stdio transport):**

1. Build the MCP server:
   ```bash
   cd apps/mcp && npm run build
   ```

2. Add to `~/.claude/settings.json` (merge the `mcpServers` block):
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
   See `apps/mcp/claude-code-config.example.json` for the full template.

3. Start the brain API (must be running for MCP tools to work):
   ```bash
   docker compose up -d
   ```

**Remote setup (HTTP transport):**
```bash
MCP_TRANSPORT=http MCP_PORT=3002 node apps/mcp/dist/index.js
```
Set `BRAIN_API_URL` to your deployed brain URL. Required for AWS-hosted deployments (M6).

**Cursor setup:** see `apps/mcp/cursor-config.example.json`.

## Python SDK Setup (LangGraph / ADK)

For agents built with LangGraph, Google ADK, or any Python orchestration framework, use `packages/python` instead of the MCP server.

```bash
pip install -e "packages/python[langgraph]"   # LangGraph / LangChain agents
pip install -e "packages/python[adk]"          # Google ADK agents
pip install -e "packages/python[all]"          # both
```

```python
from purpl_brain import BrainClient, langgraph_tools, adk_tools

client = BrainClient()  # reads BRAIN_API_URL + BRAIN_API_KEY from env

# LangGraph
tools = langgraph_tools(client)  # returns list of @tool instances

# ADK
from google.adk.tools import FunctionTool
tools = [FunctionTool(fn) for fn in adk_tools(client)]
```

All four operations are available: `brain_query`, `brain_log_decision`, `brain_analyze_impact`, `brain_log_signal`. See `packages/python/examples/` for full session lifecycle examples.

## Brain Tool Usage Protocol

When `brain_query`, `brain_log_decision`, `brain_analyze_impact`, or `brain_log_signal` are available as MCP tools, follow this protocol. These are first-class actions in this repo, not optional helpers.

### Session start — required before writing any code

Call `brain_query` before touching any file or making any recommendation:

```
query: "What are the most recent decisions and open questions for <area of work>?"
project_id: skalrn_purpl_brain
```

If the task is scoped to a specific layer (ingestion, query, auth, workers), include that in the query. Do not proceed without loading context — the brain may have a constraint you don't know about.

### Before significant implementation — required

Before starting any change that touches ingestion workers, the brain store, query layer, API routes, or data schemas, call `brain_analyze_impact`:

```
change_description: plain-English description of what you are about to change
project_id: skalrn_purpl_brain
```

Do not skip this even if the change looks small. The brain may surface a downstream dependency or prior decision that changes the approach entirely.

### When a decision is made — call immediately, not at session end

Call `brain_log_decision` the moment a significant choice is made. Do not batch decisions for the end of the session. Significant decisions include:

- Choosing a library, pattern, or approach over alternatives
- Deciding NOT to do something (rejection decisions are decisions)
- Discovering a constraint, invariant, or edge case that will affect future work
- Any choice that, if unknown to the next session, would cause re-derivation or rework

**One decision made = one `brain_log_decision` call.** A decision logged mid-session is always recoverable. A decision lost when context is compacted or the session ends is not.

### When something unexpected surfaces — call immediately

If you discover something that contradicts or challenges a past decision — a library limitation, API constraint, performance finding, or behavior that conflicts with an ADR — call `brain_log_signal` before continuing. Do not defer this.

### Subagents

When spawning a subagent via the Agent tool, include the relevant `brain_query` output in the subagent prompt. Do not rely on the subagent to rediscover context independently unless the task requires fresh lookups. Pass what you already know.

---

## Session Handoff Protocol

When the user says anything like "new session", "switching sessions", "let's start a new session", or "I'll continue this later":

1. **Before they leave**, review the current conversation for non-obvious insights that aren't already in memory or code — things like: why a bug happened, ordering constraints between tasks, positioning arguments, patterns to avoid.
2. **Ask the user** which of those are worth saving. List them as short bullet points.
3. **Save the ones they confirm** to the memory system (`~/.claude/projects/.../memory/`).
4. **Remind them** what their next session should start with (the highest-priority pending task).

Do not skip this even if the session was short. The cost of asking is low; the cost of losing a non-obvious insight is re-deriving it next session.

## Build Order

Phase 1 → Phase 2 → Phase 3 → Phase 4. A phase does not start until its exit criterion is met. See `docs/product/roadmap.md` for exit criteria per phase.

## Skill Management

When creating a new Claude Code skill (a `.md` file intended as a slash command):

1. **Project-specific skills** (depend on this repo's MCP tools, file paths, or tooling) → save to `.claude/commands/` in this repo and commit here.
2. **Reusable skills** (pure prompting, no project dependency) → save to `~/.claude/commands/` AND commit to `~/aiplayground/skalrn-claude-skills/commands/`, then push to `github.com/skalrn/skalrn-claude-skills`.

For reusable skills, always do both steps — the local symlink makes it available immediately, the repo commit makes it available on any machine and preserves it across reinstalls.

The `skalrn-claude-skills` repo is symlinked to `~/.claude/commands/` via `install.sh`. Any file added to `skalrn-claude-skills/commands/` is automatically picked up by Claude Code on the next restart.

## Feature Design Review

Before implementing any new feature that touches ingestion, workers, the brain store, or the query layer — pause and raise failure modes before writing code, not after.

Ask: **what does this design assume about the real world that the dev/test environment hides?**

Apply these lenses to the feature description:

- **Real-world inputs:** what does this assume about the shape, completeness, or ordering of inputs that real users won't guarantee?
- **Temporal correctness:** does this preserve when things actually happened, or does it stamp "now"? What does time mean in this context?
- **Idempotency:** what happens if this runs twice, or fails halfway and retries?
- **System interactions:** which existing workers, streams, or stores are downstream of this? Do their assumptions still hold?
- **Tenant isolation:** is every read and write scoped to `project_id`, or can data bleed across projects?
- **Failure recovery:** what is the blast radius if this fails? Can it be retried without side effects?
- **Scale:** what is the bottleneck? What breaks at 10× the current data volume?

These lenses apply to any feature — the specific failure modes they surface will differ each time. If `brain_analyze_impact` is available, run it against the proposed change before starting implementation.

## LLM Cost Controls

Every Anthropic SDK call in this codebase must apply prompt caching. See `docs/technical/llm-cost-controls.md` for full patterns and anti-patterns.

**Rules enforced when writing SDK code:**

- System prompt must be a list of blocks with `cache_control: {"type": "ephemeral"}` on the last block — never a plain string.
- Do not interpolate timestamps, UUIDs, or per-request IDs into the system prompt. Inject dynamic context as a user message at the end.
- Tool definitions must be deterministically ordered (sort by name). Never add or remove tools per-request.
- For session-scoped context (retrieved docs, graph snapshots), add a second `cache_control` breakpoint at the end of the context block in the first user message.
- In multi-turn sessions, move the `cache_control` marker to the last block of the most-recently-appended turn each call.
- Verify caching is working: `response.usage.cache_read_input_tokens` must be non-zero on repeated calls with identical prefixes. If it is zero, there is a silent invalidator — find it before shipping.
- Use 1-hour TTL (`{"type": "ephemeral", "ttl": "1h"}`) for extraction pipelines where calls are bursty with idle gaps; 5-minute (default) for interactive query sessions.
