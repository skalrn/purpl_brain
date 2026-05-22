---
sidebar_position: 2
---

# ADR-002: MCP Server as the Agent Interface

**Status:** Accepted | **Date:** 2026-05-15 | **Implementation:** Phase 3 M1 complete

## The problem

The brain's query and write-back interface must be accessible to AI agents — not just to humans via the chat UI. The interface needs to work with Claude Code, Cursor, LangGraph agents, Google ADK agents, CI bots, and any future agent runtime without requiring a custom integration per agent.

Two approaches were seriously considered: a bespoke REST API with agent-specific SDKs, or the Model Context Protocol.

## The decision

Expose the brain as an MCP server, alongside the REST API which remains available for all programmatic use.

MCP is Anthropic's open standard for how AI agents access external tools and context. Claude Code speaks MCP natively — adding the brain's MCP server to `~/.claude/settings.json` gives Claude Code access to all four operations with zero additional integration work. Cursor also supports MCP servers. Any future MCP-compatible agent runtime gets access immediately.

The MCP surface:
- **Resource:** `brain://project/{project_id}/context` — current project snapshot (recent decisions + open drift alerts)
- **Tool:** `brain_query(query, project_id, mode)` — natural language query
- **Tool:** `brain_log_decision(...)` — write structured decisions into the brain
- **Tool:** `brain_analyze_impact(change_description, project_id)` — impact analysis
- **Tool:** `brain_log_signal(text, project_id, source)` — report a contradicting signal

Both stdio transport (local dev) and StreamableHTTP transport (remote/cloud) are implemented.

## The Python SDK as a parallel path

LangGraph agents and Google ADK agents cannot use MCP directly — they operate in an orchestration framework with their own tool call model. For these agents, the Python SDK in `packages/python` provides `@tool`-decorated wrappers for LangGraph and plain callables for ADK's `FunctionTool`.

The SDK wraps the same four REST endpoints as the MCP server. There is no business logic duplication — the SDK is a thin adapter layer. The distinction:

- MCP server: right choice for interactive IDE agents (Claude Code, Cursor) that support MCP natively
- Python SDK: right choice for programmatic agents built in LangGraph, ADK, or any Python orchestration framework

Both paths are first-class. The REST API is always available as the escape hatch for any HTTP-capable agent.

## What was rejected

**REST API only with agent SDKs:** Still provided, but insufficient as the sole agent interface. Every new agent runtime would require a custom SDK integration. MCP eliminates this per-runtime integration cost for MCP-native runtimes.

**LangChain/LangGraph wrappers as the primary interface:** LangGraph agents are one important segment, not all agents. Claude Code and Cursor users cannot use LangGraph wrappers directly. MCP covers the IDE agent segment; the Python SDK covers the orchestration framework segment. Neither alone covers both.

**OpenAI plugin format:** OpenAI-specific standard with limited adoption outside ChatGPT. MCP has broader and more relevant ecosystem momentum for this project's stack.

## The tradeoff

MCP is a maturing protocol. The spec evolves, and tracking spec changes is an ongoing maintenance cost. The SDK available at time of writing (`@modelcontextprotocol/sdk`) is stable enough for production use, but breaking changes in the transport layer (stdio vs StreamableHTTP) have occurred during Phase 3 development.

The bet is that MCP becomes the de facto standard for IDE agent tooling, making the maintenance cost worth paying. As of 2026, Claude Code and Cursor both support MCP, and the ecosystem has grown enough that this bet looks correct.

## Implementation state

All four tools implemented and evaluated (8/8 eval PASS). stdio transport is the default for local dev. HTTP+SSE transport is available for remote deployments. The MCP server shares the same underlying query and write-back services as the REST API — no duplicate business logic.

## Future direction: A2A as a complementary transport

Google's Agent2Agent protocol defines synchronous agent-to-agent communication — live sessions that can call each other's endpoints. A2A and MCP are orthogonal:

- MCP: agent reads from and writes to the brain (asynchronous, session-scoped)
- A2A: brain pushes drift alerts to running agent sessions (synchronous, real-time)

When the brain creates a DriftAlert, it could use A2A to notify any currently-running agent session working on the affected project. The agent would receive an in-session interrupt: "a decision you may be building on has been flagged as contradicted — review before committing."

This is deferred because most agent sessions are ephemeral CLI invocations without stable A2A endpoints. It becomes viable as more agent runtimes adopt persistent-service models.
