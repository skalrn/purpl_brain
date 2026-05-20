# ADR-002: Expose Brain as an MCP Server

**Status:** Accepted (Phase 3, M1 complete)  
**Date:** 2026-05-15  
**Deciders:** Deepak Kollipalli  

---

## Context

The brain's query interface must be accessible to AI agents — not just human users via the chat UI. Agents need to query the brain mid-session to retrieve context, and in Phase 4, agents from multiple runtimes (Claude, Cursor, custom agents) should be able to access the brain without custom integration work per agent.

Two interface options were evaluated: a bespoke REST API with agent-specific SDKs, or the Model Context Protocol (MCP).

## Decision

Expose the brain as an **MCP server** in Phase 4, alongside the REST API which remains available for programmatic use.

MCP is Anthropic's open standard for how AI agents access external context and tools. It is becoming the de facto standard: Claude natively speaks MCP, Cursor supports MCP servers, and the ecosystem is growing rapidly. Implementing MCP means:

- Claude can query the brain as a native resource without any custom integration
- Cursor can surface brain context in the editor via MCP tool calls
- Any future MCP-compatible agent runtime gains access with zero additional integration work

**MCP surface exposed:**
- Resource: `brain://project/{project_id}/context` — returns current brain state summary for a project
- Tool: `brain_query(query: str, project_id: str, mode: str)` — natural language query with mode (project, expertise, agent-resume)
- Tool: `brain_log_decision(...)` — write structured agent session decisions into the brain
- Tool: `brain_analyze_impact(event_id: str)` — reactive impact analysis
- Tool: `brain_log_signal(...)` — report a finding that may contradict existing decisions

## Alternatives Considered

**REST API only with agent SDKs**  
Still provided, but insufficient as the sole agent interface. Each new agent runtime would require a custom integration. MCP eliminates this per-runtime cost.

**LangChain / LangGraph and Google ADK tool wrappers**  
Shipped as an addition in `packages/python`, not a replacement for MCP. LangGraph agents get `@tool`-decorated wrappers; ADK agents get plain callables compatible with `FunctionTool`. These cover agents that cannot use MCP (orchestration-framework-based agents, overnight pipeline agents, CI bots). The Python SDK wraps the same four REST endpoints as the MCP server — no business logic duplication. MCP remains the right choice for interactive IDE agents (Claude Code, Cursor); the Python SDK is the right choice for agents built in LangGraph, ADK, or any Python orchestration framework.

**OpenAI plugin format**  
Rejected. OpenAI-specific standard with limited adoption outside ChatGPT. MCP has broader and more relevant ecosystem momentum for this project's stack.

## Consequences

- MCP server shipped in Phase 3 M1 — all four tools implemented and eval'd (8/8 PASS). REST API remains available for programmatic use.
- Must track MCP spec evolution; it is still maturing as of 2026
- The REST API and MCP server share the same underlying query layer — no business logic duplication
- MCP support is a strong portfolio differentiator and signals awareness of current agent infrastructure trends

## Future Enhancements

### A2A as a Complementary Transport Layer

Google's Agent2Agent (A2A) protocol defines a standard for synchronous agent-to-agent communication — live sessions that can call each other's endpoints to delegate tasks, exchange context, or receive notifications.

**Where A2A could augment the MCP interface:**

Currently, agents only receive brain context at the moments they explicitly call `brain_query`. Between those calls, they operate without awareness of new drift alerts that may have been created. With A2A as an additional transport:

1. Purpl Brain exposes an **A2A endpoint** (`POST /a2a/agent-notification`)
2. When the brain creates a `DriftAlert`, it queries its registry for any A2A-addressable agent sessions currently working on the affected project
3. The brain sends a structured A2A message: "DriftAlert `alert_id` was created — your current session may be building on a contradicted decision. Review before committing."
4. The agent receives the interrupt mid-session and can call `brain_query` to get details before continuing

**Why this is deferred:**
- Most agent sessions are ephemeral command-line invocations, not long-lived A2A-addressable services
- A2A requires both parties to have stable endpoints and be simultaneously live — this constraint eliminates most current Claude Code / Cursor use patterns
- Detection and persistence (the core brain loop) must be solid before real-time notification adds value
- A2A ecosystem adoption is early; integration cost should be deferred until it stabilizes

This enhancement does not change the MCP surface or the REST API. It adds an outbound notification path alongside the existing inbound write path.

### Infrastructure Agent Pre-Flight Checks (Direction 2)

Agents configured with infrastructure MCP servers (PostgreSQL, Cassandra, Kafka, etc.) can use Purpl Brain as a **decision authority** before executing consequential operations — schema migrations, topic creation, index drops, keyspace restructures.

The pattern:

1. An agent is about to execute a breaking Cassandra schema migration via its Cassandra MCP server
2. Before executing, the agent calls `brain_analyze_impact` with a description of the change
3. The brain retrieves semantically similar prior decisions: "Two weeks ago, session `xyz` decided to migrate off Cassandra to PostgreSQL — cited: PR #142, rationale: operational overhead"
4. The agent surfaces the conflict to the developer rather than silently applying the migration

This is not a new brain capability — `brain_analyze_impact` and `brain_log_signal` already support this exact flow. The enhancement is **documentation and reference examples** showing infra-agent developers how to wire this up:

- A pre-flight hook pattern for agents using the official Postgres MCP server
- A reference prompt template: "Before executing any DDL or schema change, call `brain_analyze_impact` with the operation description and the affected table/keyspace/topic name"
- Guidance on which MCP tool to use per scenario:

| Scenario | Brain tool |
|---|---|
| About to run a migration — want to check for conflicts | `brain_analyze_impact` |
| Just discovered a schema is inconsistent with docs | `brain_log_signal` |
| Migration completed — want to persist the decision | `brain_log_decision` |

This positions Purpl Brain as the **pre-flight gate** for infrastructure agents, not just coding agents. The brain becomes the shared authority any agent consults before making architectural changes — regardless of whether it's writing TypeScript or altering a Kafka topic schema.
