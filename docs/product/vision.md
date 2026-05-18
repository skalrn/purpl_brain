# Product Vision — Purpl Brain

## One-Line Statement

Purpl Brain is the persistent memory layer for AI coding agents. Agents write their decisions back to the brain at session end; the next session reads them back via MCP and continues with context.

## The Problem

Every AI coding session starts from zero. Claude Code, Cursor, GitHub Copilot — each invocation opens with an empty context window and no awareness of what was decided last week, what was tried and rejected three days ago, or what architectural constraint was set when the project began. The agent re-derives, re-guesses, and often contradicts decisions it (or another agent, or the human) already made.

The standard workaround is for the developer to paste the same paragraph of context into every new session — "we're using Postgres, not Mongo; we already tried `pgvector` and ruled it out; the auth module is owned by Alex." This is a manual memory transfer between human and agent, repeated every session, and it does not scale past a single project or a single week.

The result is that AI agents remain unreliable for anything beyond a single bounded session. They are productive within a conversation and amnesiac across conversations. The work product of yesterday's agent is invisible to today's agent.

## The Insight

Agents need the same thing humans need: institutional memory. But they need it in a machine-readable, queryable form — not a wiki, not a Notion page, not a Slack thread. They need a structured store they can write to at session end and read from at session start, with citations to the original signals (commits, PRs, prior agent decisions) so the new session can trust what it inherits.

This is not a knowledge base. A knowledge base is human-curated and read-only for agents. This is an agent-curated, agent-readable memory layer where the agent is a first-class writer.

## The Bet

If every agent session writes its decisions back to a shared brain, and every new session reads from that brain before doing anything else, then agents compound across time. Decision N+1 builds on decision N instead of replacing it. The developer stops being the human-memory-bus between sessions.

Concretely: an agent finishes a session and calls `POST /brain/agent-log` with its structured decisions, alternatives considered, and unresolved questions. The next session, in a different IDE or a different week, opens by calling the `brain_query` MCP tool. It gets back the prior decisions with citations and continues from there. The developer does nothing.

The bet is that this loop — write at session end, read at session start, MCP as the transport — is sticky enough to become the default memory layer for AI-assisted development, in the same way `.gitignore` became the default way to keep junk out of a repo.

## The Human Benefit

Humans get auditability and oversight of agent decisions for free. Because every agent decision is a structured log with citations and a rationale field, the developer can query "what did the agent decide about caching last week and why" and get an answer grounded in the agent's own log. This is the same query path the next agent uses, so there are no two sources of truth.

Drift detection comes along as a byproduct: when a new agent decision contradicts a prior one, the brain flags it. The developer sees "session 2 chose Redis; session 1 chose Memcached" before the contradiction lands in production.

The human use case (querying what happened, getting cited summaries, surfacing contradictions) is real and valuable. It is no longer the pitch. It is what falls out when agents have proper memory.

## Competitive Positioning

| Tool | What it does | Why it does not solve agent memory |
|---|---|---|
| Mem.ai | Personal notes with AI search | Designed for humans capturing thoughts; no agent write-back API, no MCP server, no decision schema |
| GitHub Copilot | Code completion and Workspaces | Session-scoped; Copilot Spaces are repo-pinned context, not cross-session memory; closed to other agents |
| Cursor Project Rules | In-IDE persistent prompts | Cursor-only; rules are human-authored, not agent-written; no query layer |
| Claude Projects | Pinned files per project | Anthropic-only; pinned context is human-curated; no inter-session decision log |
| Glean | Enterprise search across SaaS | Read-only for agents; no agent write path; sales-led, $30+/seat, wrong customer |
| Notion AI | Q&A over a wiki | Human-curated content; no event ingestion; no agent decision schema |

Nobody is shipping agent-first persistent memory with a documented write API, a structured decision schema, and an MCP read path. That is the gap and that is the product.

## Ideal Customer Profile

Primary: individual developers and small teams (2–8 engineers) who use Cursor, Claude Code, or GitHub Copilot as a daily driver, run multiple AI sessions per day, and feel the cost of re-pasting context every time. They already pay $20–100/month for AI coding tools. They will pay $10–30/month for the memory layer those tools are missing.

Secondary: platform engineering teams running automated agents (CI bots, dependency-bump bots, code-review bots) who need those agents' decisions to be auditable. Same write/read schema, different agent client.

Out of scope: enterprise rollouts, floating specialists across a 40-engineer org, teams that do not use AI coding assistants. These were targeted in the original positioning and proved to be a fight against Glean and Notion that this product cannot win.

## Strategic Bets, Ranked

1. **Agent write-back + MCP read is the entry point.** The first thing a new user does is install the MCP server into their Cursor or Claude config. The second thing they do is run an agent session that writes to the brain. The third thing is open a new session and see prior decisions surface. Everything else is supporting infrastructure for this loop.
2. **Human query is a secondary surface.** The same brain that serves `brain_query` to agents serves it to humans via a web UI. Cited answers, drift alerts, agent decision history — all present, none of it the lead.
3. **Multi-source ingestion is context enrichment, not the product.** GitHub, Slack, Jira, and meeting transcripts feed the brain so that agent queries return answers grounded in the full context of the project, not just prior agent logs. This is what makes the agent memory layer better than a local SQLite file. It is not the pitch.

The product is agent memory. The defensibility is the write-back loop. The proof is two Claude Code sessions on the same repo where the second one knows what the first one decided.
