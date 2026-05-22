---
sidebar_position: 2
---

# Competitive Landscape

## Provider-shipped memory

Every major AI coding tool ships some form of memory. None of them solve the team problem.

**Claude Projects** pins files and persistent context per project, inside Claude.ai and Claude Code. It is Anthropic-only — Cursor users see nothing from it. It is user-scoped — your teammate's project is invisible to you. It has no decision schema, no citation back to a PR or ticket, and no contradiction detection. It is a sticky note attached to your Claude account, not a shared brain.

**Cursor Rules / Project Memory** works similarly within Cursor. Human-authored `.cursorrules` files persist prompt context. There is auto-updating project memory, but it is unstructured text. There is no write path for other agents. There is no grounding in Slack or Jira or meetings.

**GitHub Copilot Spaces** provides repo-pinned context for Copilot sessions. It is closed to non-Copilot agents, has no cross-session decision log, and ingests no external signal sources.

**Cloudflare Agent Memory** (entered private beta April 2026) is the closest competitor in stated intent. It is a managed memory service for agents running on Cloudflare Workers, with shared team profiles so coding conventions accumulate across developers. The important difference: it is infrastructure passthrough. There is no decision schema, no rationale field, no alternatives-considered, no citations back to source signals, no drift detection, and it is locked to the Cloudflare Workers runtime. You cannot ask it "what did the team decide about caching in May?" — it has no query layer with semantic grounding. It stores what agents say; it does not know why they said it.

## Agent memory infrastructure

A separate category has emerged: developer libraries for building agents with persistent memory. These are general-purpose plumbing, not products built for dev teams.

**Mem0** (~48K GitHub stars as of 2026) is a dual-store memory layer — vector and graph — with cross-agent scoping at user, session, agent, and app levels. It is framework-agnostic and widely adopted. It does not target dev teams specifically. There is no GitHub/Jira/Slack/meeting ingestion, no structured decision schema with rationale and citations, and no drift detection. It stores what agents type; it does not know what your team decided or why.

**Zep / Graphiti** builds a temporal knowledge graph that tracks entity relationships with validity windows — it knows when a fact was true and when it was superseded. The temporal validity tracking is genuinely sophisticated. But it is not targeting dev teams, has no external signal ingestion, and temporal validity is not the same as contradiction detection across agent sessions.

**Letta (MemGPT)** takes an OS-inspired approach to tiered memory where agents actively manage their own context. It is per-agent, not team-scoped. There is no shared layer across agents or developers.

**LangMem** is key-value semantic memory built into LangGraph with team-level namespace scoping. It is tied to the LangGraph ecosystem and has no external signal ingestion.

**Cognee** has broad ingestion connectors (30+ data sources) and builds a knowledge graph from them. The ingestion breadth is genuine. But it is not dev-team specific, has no structured agent decision schema, and no drift detection. Raw graph extraction from general data sources is not the same as a queryable, cited decision history grounded in your team's GitHub and Slack.

## The three unoccupied positions

Running these competitors against the full differentiator set shows which positions are actually occupied.

Cross-agent, cross-tool scoping: partially covered by Mem0, LangMem, and Cloudflare. The MCP-native focus for interactive coding agents is not covered by anyone.

Team-scoped shared memory: covered by Mem0, LangMem, and Cloudflare.

**Structured decision trails with citations (rationale, alternatives, source PR/ticket): nobody.**

**Grounded in team signal history (GitHub, Jira, Slack, meetings): nobody** (Cognee has connectors but is not dev-team specific).

**Drift detection across agents and surfaces: nobody.**

The three unoccupied positions are also the hardest to build. They require an opinionated schema for what a decision is, a multi-source ingestion pipeline that follows links and resolves entities across sources, and a detection system tuned carefully enough to not generate noise. General-purpose memory infrastructure providers are not going to build these — their addressable market is every agent application, not dev tooling specifically, and opinionated schema design for a narrow domain does not fit their product strategy.

## Where competition is heading

Mem0, Zep, and Letta will keep improving generic memory primitives. None will build an opinionated decision schema for software teams, because their TAM requires staying general. Cloudflare will keep expanding Agent Memory as infrastructure — shared profiles, faster retrieval — but will not build a query layer grounded in your team's GitHub history, because that is a per-customer integration problem outside their platform scope.

The most credible threat vector is Mem0 adding a structured decision schema as a configuration option. They already have cross-agent scoping and team namespacing. Adding schema constraints is a config option, not a product pivot. This is worth monitoring.

The answer to that threat is the ingestion pipeline. Schema is table stakes once someone ships it. The GitHub/Jira/Slack/meeting ingestion pipeline is the harder moat — it requires sustained engineering on source-specific parsers, link-following, entity extraction, and the deduplication logic that makes ingestion idempotent at scale. That work does not transfer from one product to another.
