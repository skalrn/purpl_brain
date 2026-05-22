# Is purpl_brain Actually Viable? I Ran the Numbers.

*~7 min read*

---

I've been building purpl_brain for several months. It's a shared memory system for AI agent teams — agents read from it at session start, write decisions back to it during the session, and the system surfaces conflicts when different agents make contradictory choices.

The core promise is that ten parallel agents working on the same codebase don't re-derive the same constraints, make conflicting architectural decisions, or lose context between sessions. The brain is the connective tissue.

A few weeks before opening beta, I sat down and asked myself whether the product actually works. Not whether the infrastructure is solid — it is. Whether the value proposition holds under realistic conditions.

The answer is: yes, with a specific user profile. And no, for everyone else.

---

## The Structural Dependency

The entire system depends on agents writing to the brain. Query results, drift detection, the morning dashboard showing what agents did overnight — all of it is downstream of write-back quality and write-back frequency.

I can't force an agent to write. I can instruct it, incentivize it, and catch failures with a session-end hook. But the write path goes through the agent, which means every session is a voluntary act.

This is unlike Mem0 and Zep — the two most widely used agent memory systems — which intercept at the application layer and write automatically regardless of agent behavior. They achieve close to 100% coverage by construction. I don't.

Realistic write-back rates from our own production use:

| Setup | Write-back rate |
|---|---|
| Claude Code + CLAUDE.md + session-end hook | ~85-90% |
| Claude Code + CLAUDE.md, no hook | ~60-70% |
| Cursor (no hook system) | ~40-60% |
| Custom agent, SDK only | Depends entirely on system prompt discipline |

At 85-90%, the brain fills meaningfully. Ten agents running daily generates 140-180 decisions per day even accounting for non-compliance. The morning dashboard has signal within a few days.

At 40-60%, you're looking at 80-120 decisions per day from ten agents. Still usable, but the brain takes longer to reach useful density and drift detection fires less reliably. The morning review becomes less useful because the coverage is inconsistent.

Below that, the brain goes thin and the product stops delivering on its promise.

---

## What Happens at Scale

Running the numbers for a team with ten parallel agents, each running eight-hour sessions:

**Token economics are not the problem.** purpl_brain's own LLM costs — extraction, drift detection, query answering — run around $2-5 per day for ten active agents. Even adding auto-extraction from raw session transcripts as a fallback, the cost barely moves. Tokens are cheap. Human attention is not.

**The real bottleneck is drift triage.** Ten agents making independent decisions on a shared codebase will conflict. At our measured drift precision of 89%, ten agents generating 200 decisions per day could surface 15-30 real conflicts daily. At two minutes per alert, that's 30-60 minutes of triage — more than the morning review was supposed to take.

The fix before beta was a one-line configuration change: raise the semantic similarity threshold from 0.55 to 0.72. This trades recall for precision, catching near-identical contradictions while filtering out semantically adjacent but non-conflicting signals. The threshold was too aggressive for a ten-agent team. Raising it before beta gives us time to measure real triage load before building smarter grouping.

This is the kind of thing that only becomes obvious when you run the scale math before shipping.

---

## Where the Product Is Defensible

Three things don't depend on agent cooperation at all:

**Human-driven queries.** A developer asking "what did we decide about the auth layer?" works regardless of agent write-back quality. If the brain has reasonable coverage, the answer comes back cited and grounded. This is valuable on its own as an audit and institutional memory tool, even if the agent integration is imperfect.

**Drift detection.** Once decisions are in the brain, drift detection runs automatically on every new signal — Slack messages, Jira tickets, meeting transcripts, agent logs. A decision logged three weeks ago by one agent gets flagged when a new signal contradicts it, without any agent needing to call a tool. The detection is automatic; only the initial write required cooperation.

**Cross-agent context.** This is the strongest differentiator. When agent A logs a decision and agent B queries the brain at the start of its next session, B inherits A's reasoning without anyone copying context between them. This is hard to replicate without a shared brain, and it's the scenario where the product is genuinely most useful — multiple agents working in parallel on overlapping parts of the same system.

---

## Where It Breaks Down

**Teams who don't do the setup.** The value requires CLAUDE.md configuration, a session-end hook, and the MCP server running. That's not trivial. A team that installs it and doesn't configure it properly will see an empty brain and blame the product.

**Cursor users.** Cursor has no hook system. Write-back depends entirely on the agent following prompt instructions, which is 40-60% in our experience. The brain fills slowly and inconsistently. The morning dashboard has gaps.

**Solo developers with short sessions.** The re-derivation payoff requires enough sessions to amortize the write cost. A solo developer running one or two agent sessions per week on a stable codebase probably gets enough value from a well-maintained CLAUDE.md. The brain helps more as sessions accumulate.

**Teams with very low decision density.** If agents are mostly doing mechanical work — writing tests, formatting, dependency updates — they're not making many architectural decisions. The brain fills with low-value entries and drift detection fires rarely. The product is less useful.

---

## The Honest Failure Mode

The thing I worry about most: a team sets up the product, runs it for a week, and the brain stays thin because agents aren't complying with logging instructions. They query the brain and get nothing useful back. They conclude the product doesn't work and stop using it.

This is the empty brain problem. An empty brain is worse than a noisy brain, because a noisy brain at least returns something that keeps the user engaged long enough to refine the setup.

The mitigation is auto-extraction from raw session transcripts as a fallback: if the agent doesn't log, the session-end hook reads the conversation and runs the LLM extractor on it. Lower quality — facts rather than reasoned decisions — but something rather than nothing. Auto-extracted entries are flagged and don't trigger drift detection until promoted.

This doesn't solve the write-back problem. It changes the failure mode from "empty brain" to "noisy brain," which is recoverable.

---

## Who This Actually Works For

The product works well for teams that are already running Claude Code as their primary agent, willing to configure CLAUDE.md and the session-end hook per project, and running multiple agents per project where cross-agent context creates real value.

For those teams, the setup cost is low relative to the payoff. The brain fills quickly, drift detection surfaces real conflicts, and the morning review is genuinely useful within the first week.

It breaks down for teams on Cursor or custom agents without hook enforcement, solo developers with infrequent sessions, and teams who won't do the per-project configuration.

The bet is that the first group is large enough to build a product on, and that model instruction-following and MCP adoption both improve enough over the next year that the compliance gap closes. That's a reasonable bet. It's still a bet.

---

## What Would Make This Stronger

One thing would change the product's risk profile significantly: moving the write path to the application layer as a fallback, the way Mem0 does. Not as the primary path — we'd lose the structured reasoning that makes drift detection and impact analysis useful — but as a floor. If the agent doesn't write, the session transcript gets processed automatically. The brain has something. The product doesn't fail silently.

The infrastructure for this is partially there. The session-end hook already runs. Extending it to read the transcript and POST to the ingest pipeline is a few days of work. Whether to build it before or after beta is a product call about how much risk to carry at launch.

I'm planning to carry it, ship to beta, and build the fallback if the empty-brain problem shows up in real usage data. That's the honest answer.

---

*purpl_brain is in private beta. If you're running AI agents on a shared codebase and this problem sounds familiar, I'd like to hear what you're doing about it.*

<!-- MEDIUM IMPORT INSTRUCTIONS
1. No diagrams in this article.
2. Use Medium's import feature: Profile → Stories → Import a story. Do NOT paste markdown directly.
3. The compliance rate table will need manual formatting in Medium — convert to a simple list or screenshot.
4. Suggested tags: AI Engineering, Developer Tools, Startups, Machine Learning, Software Architecture
-->
