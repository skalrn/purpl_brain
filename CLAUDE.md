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
      002-mcp-server-interface.md      # Why MCP over bespoke agent SDK
      003-event-driven-ingestion.md    # Webhook-first with Redis Streams queue
      004-agent-decision-trails.md     # Agent log schema and write-back design
  risk/
    risk-register.md   # Technical, product, market, and security risks with mitigations
```

## Key Architectural Decisions

- **Brain store:** Hybrid — vector store (Qdrant) for semantic retrieval + graph DB (Kuzu → Neo4j) for causal/relational reasoning. See ADR-001.
- **Ingestion:** Webhook-first, event-driven. Redis Streams queue between webhook receipt and processing. See ADR-003.
- **Agent interface:** Agents write structured decision logs to `POST /brain/agent-log`. Brain exposes as MCP server in Phase 4. See ADR-002, ADR-004.
- **Query:** RAG + graph traversal combined. Every answer is grounded with citations to source (URL, timestamp, actor).

## Phase Status

Currently in pre-development. No code exists yet. Phase 1 scope: GitHub-only ingestion → brain update → natural language query with citations.

## Build Order

Phase 1 → Phase 2 → Phase 3 → Phase 4. A phase does not start until its exit criterion is met and documented. See `docs/product/roadmap.md` for exit criteria per phase.

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
