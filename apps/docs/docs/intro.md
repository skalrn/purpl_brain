---
sidebar_position: 1
---

# Introduction

purpl_brain is a shared working memory layer for software teams that use AI coding agents. It ingests signals from GitHub, Slack, Jira, meeting transcripts, and agent sessions, maintains a continuously updated knowledge graph, and serves context back to agents and humans through a natural language query interface.

The central design choice is that AI agents are first-class actors. They do not just read from the brain — they write to it. At session end, an agent logs its decisions: what it chose, what it rejected, why, and what remains unresolved. At session start, the next agent reads those logs before touching any file. The developer does nothing between the two sessions.

## The problem it solves

Every AI coding session starts from zero. Claude Code, Cursor, GitHub Copilot — each invocation opens with no awareness of what was decided last week, what was tried and rejected, or what architectural constraint the project operates under. The agent re-derives, re-guesses, and often contradicts decisions it, or another agent, or a teammate, already made.

The standard workaround is manual: the developer re-pastes the same paragraph of context at the start of every session. When the agent makes a decision the developer approves, that decision lives in the chat transcript and dies there. The next session re-asks.

Three distinct failure modes emerge from this:

**Re-derivation cost.** A session that spent 30 minutes evaluating library options and making a reasoned choice produces zero durable output if that decision is not persisted. The next session starts the same evaluation from scratch. At 5-20 sessions per day across multiple repos, this is not an edge case — it is the daily pattern.

**Contradictory decisions.** Without shared memory, there is no mechanism to detect when session 5 picks Redis and session 7 picks Memcached for the same use case. Neither provider will tell you. The conflict surfaces as a code review comment at best, a production bug at worst.

**Opaque reasoning.** Developers cannot audit what agents decided or why. Stack Overflow's 2025 survey found 45.7% of developers actively distrust AI. When every session decision carries who made it, when, why, and which PR or ticket it traces to, the developer can verify before acting. Trust is built through a record, not asserted through a summary.

## Who it is for

The primary target is individual developers and small teams (2-8 engineers) who use Cursor or Claude Code as a daily driver, run multiple AI sessions per day, and feel the cost of re-pasting context every time. They already pay $20-100/month for AI coding tools and will pay $10-30/month for the memory layer those tools are missing.

A secondary use case is the solo developer or micro-founder running 5-10 simultaneous AI-assisted projects with overnight or background autonomous agent runs. They need oversight of their own agent swarm: what did each agent decide while I was away, did any contradict each other across projects, what needs review before I push?

Out of scope: enterprise rollouts, teams that do not use AI coding assistants, and teams whose primary pain is not agent context continuity.

## Quick start

For local setup: [Operations / Setup](/operations/setup)

For the agent interface: [Agent Interface / Overview](/agent-interface/overview)

For how the system works end-to-end: [How It Works / Overview](/how-it-works/overview)
