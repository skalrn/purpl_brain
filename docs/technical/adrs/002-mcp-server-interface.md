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

**LangChain / LlamaIndex tool wrappers**  
Framework-specific. Locks the brain to a single agent framework ecosystem. MCP is framework-agnostic.

**OpenAI plugin format**  
Rejected. OpenAI-specific standard with limited adoption outside ChatGPT. MCP has broader and more relevant ecosystem momentum for this project's stack.

## Consequences

- MCP server shipped in Phase 3 M1 — all four tools implemented and eval'd (8/8 PASS). REST API remains available for programmatic use.
- Must track MCP spec evolution; it is still maturing as of 2026
- The REST API and MCP server share the same underlying query layer — no business logic duplication
- MCP support is a strong portfolio differentiator and signals awareness of current agent infrastructure trends
