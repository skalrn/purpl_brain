# Product Vision — Project Brain

## One-Line Statement

Project Brain is the shared working memory for human-agent software teams — eliminating context reconstruction as a productivity bottleneck across products, codebases, and task switches.

## The Problem

Software teams — from solo developers to distributed organizations — lose disproportionate time not to execution, but to **context acquisition**. Every time a human or AI agent switches tasks, joins a project mid-flight, or resumes interrupted work, they must reconstruct current state, prior decisions, and forward plan from fragmented sources.

This compounds for small and specialist-heavy teams running multiple products in parallel with AI codegen and design agents. Agents make consequential decisions — architectural choices, library selections, tradeoff resolutions — that evaporate at session end. The next actor, human or agent, re-derives context from scratch.

**Context reconstruction is the primary bottleneck. Not capability.**

## The Bet

The world is shifting toward small teams or solo developers managing multiple AI-assisted codebases in parallel. The "10x engineer with agents" model is real. The constraint is context, not code.

No existing tool treats **AI agents as first-class actors that both read and write context**. Cursor has session memory. Glean has enterprise search. Jira has AI summaries. None of them connect human + agent context across a multi-product knowledge graph. That is the gap.

## Who It's For

| Actor | Core Pain |
|---|---|
| Engineer (context switcher) | Picks up a 3-week-old ticket and has no idea what changed or why |
| Floating specialist | Joins 4 products part-time, can't hold all their current states simultaneously |
| AI codegen / design agent | Resumes a session with no memory of prior decisions, re-derives or contradicts itself |
| Tech lead / PM | Needs to understand current plan state across multiple work streams without attending every meeting |

## What Success Looks Like

> Any intelligent actor — human or agent — can join any task, on any product, at any point in its lifecycle, and reach productive context in under 60 seconds.

**6-month POC success criteria:**
- A developer can query the brain after a 2-week absence and get an accurate, cited summary of what changed and why
- An AI agent resumed after a pause inherits prior session decisions without re-prompting
- A specialist can query across product boundaries by domain, not by project

## Strategic Positioning

| Tool | What It Does | What It Misses |
|---|---|---|
| Glean | Enterprise search across tools | Search, not synthesis; no agent trails; no temporal versioning |
| Notion AI | Chat over a knowledge base | Human-curated, not event-driven; single product; no agent awareness |
| Atlassian AI | AI on Jira/Confluence | Siloed to Atlassian; no cross-surface synthesis |
| Cursor / Copilot | In-editor AI with code context | Session-scoped; no persistent brain; no cross-codebase graph |

Project Brain's differentiation: **cross-surface synthesis + agent decision trails + multi-product graph + temporal plan versioning.**

## Build Phases (Summary)

- **Phase 1:** GitHub-grounded brain with natural language query — prove context-on-demand
- **Phase 2:** Agent write-back loop — prove agent continuity across sessions
- **Phase 3:** Multi-source, multi-product graph — prove cross-surface synthesis and specialist view

*See [roadmap.md](roadmap.md) for full detail.*
