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
