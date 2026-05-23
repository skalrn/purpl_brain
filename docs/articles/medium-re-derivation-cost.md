# Every Agent Session Starts Cold. Here's What That Costs.

*The hidden tax on AI-assisted development that compounds with every session you run*

---

Here's a concrete constraint from building this system: Redis consumer groups must exist before workers start consuming. If they don't, the first batch of events is silently dropped with no error.

An agent session traced this by reading the worker initialization code, following stream names across three files, and finding a retry loop added in an earlier bug fix. It synthesized the constraint from the gap between those three files. The constraint was never written down anywhere.

Then the session ended.

The next agent session that touched the worker startup sequence had no way to know that tracing had already been done. It started from scratch.

This is not a documentation problem. The constraint was never going to end up in a README. It lives in the gap between three files, visible only to someone who reads all three in sequence. Without a shared memory layer, every session that touches that code re-derives it independently.

That's the re-derivation problem. And once you see it, you see it everywhere.

---

## What Re-derivation Actually Costs

A typical re-discovery (the kind where an agent reads source files, traces call chains, and synthesizes a non-obvious constraint) runs somewhere between 2,000 and 5,000 input tokens. Call it 3,000 for a constraint of average complexity.

Here's what that looks like over a month on an active project with five discovered constraints and 20 agent sessions:

```
Sessions: 20
Constraints discovered: 5
Re-discovery cost per constraint: ~3,000 tokens
```

**Without persistent memory:**
```
20 sessions × 5 constraints × 3,000 tokens = 300,000 tokens
Cost at Sonnet pricing ($3/1M): $0.90
```

**With brain_log_decision + brain_query:**
```
First discovery: 5 × 3,000 = 15,000 tokens (unavoidable)
Subsequent sessions: 5 × 19 sessions × 150 tokens = 14,250 tokens
Total: 29,250 tokens
Cost: $0.088
```

**Saving: ~$0.81 over 20 sessions. 90% reduction. Zero change to the codebase.**

Those numbers look small in isolation. They compound.

---

## The Compounding Math

The problem with re-derivation debt is that it doesn't stay constant; it grows with team size and session frequency.

At a team of one running 20 sessions/month, the cost is background noise. At a team of five, each running independent sessions, the same constraint gets re-discovered by each developer's agent independently. At 10 developers, each running 15 sessions/month:

```
10 developers × 15 sessions × 5 constraints × 3,000 tokens = 2,250,000 tokens/month
Cost: $6.75/month
```

With persistent memory, that same constraint corpus costs roughly the same to retrieve no matter how many sessions run:

```
5 constraints × 150 sessions × 150 tokens = 112,500 tokens/month
Cost: $0.34/month
```

**$6.41/month difference, from re-derivation alone.** Not from better retrieval. Not from fancy embeddings. From simply not re-buying knowledge the team already paid for.

And this is a conservative estimate. It only counts 5 constraints. A real codebase has dozens: the ones about why certain abstractions exist, which configuration values can't be changed without a migration, which third-party APIs have undocumented rate limits that aren't in any README, which ordering constraints exist between initialization steps.

---

## Why This Doesn't Show Up in Your Logs

Re-derivation cost is invisible per-session because it looks exactly like useful work. The agent is reading files. It's making inferences. It's producing correct output. Nothing in the trace tells you that this exact sequence of tool calls happened three sessions ago and produced the same conclusion.

The cost only becomes visible in aggregate. Most teams don't aggregate agent session costs across sessions. They look at per-request billing, not at the cumulative cost of the same knowledge being reconstructed repeatedly.

This is why re-derivation debt doesn't get fixed. It's not painful enough in any single session to trigger a response, but it's a steady tax across every session the team runs.

---

## What Closing the Loop Looks Like

The fix is not elaborate. When a session discovers something non-obvious (a constraint, a decision, an edge case that cost tokens to find), it logs it before the session ends:

```
brain_log_decision({
  session_id: "2026-05-21-auth-investigation",
  project_id: "your_project",
  decisions: [{
    id: "consumer-group-init-order",
    description: "Consumer groups must be created before workers start consuming",
    rationale: "Redis silently drops events published to a stream with no consumer group yet registered. First batch is lost with no error.",
    confidence: "high"
  }],
  work_completed: "Traced worker startup ordering constraint"
})
```

The next session that touches the worker startup sequence:

```
brain_query({
  query: "What ordering constraints exist in the worker startup sequence?",
  project_id: "your_project"
})
```

Returns 150 tokens. Cites the original session. The agent has the constraint without re-deriving it.

The write takes about 30 seconds. The read pays for itself the second time someone's agent session would have re-discovered the same thing.

---

## The Non-Obvious Part

Here's what makes this different from a documentation problem: **the act of re-derivation is not the failure. The failure is that re-derivation happens without awareness that the knowledge already exists.**

An agent that re-derives a constraint isn't doing anything wrong. It's working correctly, given what it knows. The problem is systemic: there's no shared layer where session N's findings are available to session N+1.

CLAUDE.md and ADR files are a partial answer. They capture decisions that someone had the foresight to write down. But the constraint about consumer group initialization order was never going to make it into an ADR. It's too operational, too implementation-specific, too embedded in the gap between three files.

The constraints that cause re-derivation are precisely the ones that don't get documented.

---

## The Right Unit of Measurement

When teams evaluate AI coding tools, they tend to look at per-request latency and per-token cost. These are the right metrics for a single session. They're the wrong metrics for an ongoing team workflow.

The right unit for a team running multiple agent sessions over weeks is **cost per piece of knowledge, amortised over the number of times it gets used**.

A constraint that costs 3,000 tokens to discover and gets re-discovered 20 times costs 60,000 tokens. The same constraint stored after first discovery and retrieved 19 more times costs 3,000 + 2,850 = 5,850 tokens. The difference is not a retrieval technology question. It's a write-back question. Did the first session log what it found?

That's the only question that matters. Everything else is implementation detail.

---

## The Operational Cost Comparison

The token math above measures the cost of re-derivation itself. There's a second cost that teams rarely account for: the human time spent maintaining context so agents don't start cold.

The alternative to a shared memory layer is manual context management: CLAUDE.md files, ADRs, handoff notes. Someone has to write them, keep them current, and review them before sessions. At a senior engineer's mid-market salary, 30 minutes per day of context maintenance runs roughly $75/day for a 10-agent team. The brain's LLM costs for the same team (extraction, drift detection, query answering) run $2-5/day.

The break-even against manual context maintenance is the first week.

This isn't an argument that manual context management is bad. Teams that do it well get real value. It's an argument about where the cost actually lives: not in the token bill, which is rounding error, but in the engineering attention required to keep context files accurate across a team that's moving fast.

---

## What This Means in Practice

For a team of three to five developers actively using AI agents:

- **The initial constraint corpus builds itself.** Sessions naturally discover constraints through normal work. The discipline is logging them, not finding them.
- **The break-even is fast.** A constraint that gets re-discovered twice has already paid back the cost of storing it. At three re-discoveries, it's generating a return.
- **Scale does the rest.** The more sessions run, the bigger the gap between teams that store knowledge and teams that don't. The compounding isn't theoretical. It's arithmetic.

The hidden cost of every session starting cold isn't visible until you're looking at the cumulative picture. When you look at that picture, it's not subtle.

---

*I built this memory layer to test whether the loop was worth closing. Continuous ingestion from GitHub, Slack, and Jira, plus agent write-back via `brain_log_decision`. The token costs above use Sonnet's published input pricing; the constraint count and session count are illustrative for a mid-size active project running five to ten sessions per week.*
