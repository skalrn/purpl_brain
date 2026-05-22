# Reddit Post Draft

**Target subreddits:** r/LocalLLaMA, r/ClaudeAI, r/devtools, r/MachineLearning (post separately, don't cross-post simultaneously)

**Title options (pick one):**
- "Your AI agent re-derives the same constraints every session. I measured what that costs."
- "AI agents have no memory between sessions. I measured the tax that quietly charges you for it."
- "I noticed my AI agent kept re-reading the same 3 files every session to reach the same conclusion. So I measured it."

---

## POST BODY

Last week I noticed something annoying.

An agent session spent about 4,000 tokens figuring out that our Redis consumer groups needed to exist before workers started — or the first batch of events would be silently dropped. It read the worker init code, traced stream names across three files, found an old bug fix, and synthesized the constraint.

Then the session ended.

Next day, a different session. Same question, different angle. 3,800 tokens. Same conclusion.

I checked our session logs. This had happened four times in two weeks. Same constraint. Re-derived from scratch every time. Because **every agent session starts cold** — it has no memory of what a previous session already worked out.

---

### The problem isn't documentation

My instinct was to write it down. But here's the thing: this constraint was never going to end up in a README. It lives in the gap between three files. You can only see it if you read all three in sequence, in context. It's not a design decision someone would write an ADR for. It's operational knowledge that agents keep re-buying.

I started calling this **re-derivation debt**: knowledge your team already paid for, charged again every session that needs it.

---

### I measured it

A typical re-discovery — read files, trace call chains, synthesize a non-obvious constraint — runs 2,000–5,000 input tokens. Call it 3,000 average.

Over a month, active project, 5 such constraints, 20 agent sessions:

**Without any cross-session memory:**
```
20 sessions × 5 constraints × 3,000 tokens = 300,000 tokens
Cost at Sonnet pricing: $0.90/month
```

That looks small. Scale it:

**Team of 10, each running 15 sessions/month:**
```
10 × 15 × 5 × 3,000 = 2,250,000 tokens/month
Cost: $6.75/month
```

From re-derivation alone. Not from building features. Not from running evals. From re-buying knowledge the team already paid for.

---

### What fixing it looks like (the write side)

When a session discovers something non-obvious, it logs it before closing:

```
"Consumer groups must be created before workers start consuming.
Rationale: Redis silently drops events published to a stream with no consumer
group yet registered. First batch is lost, no error raised."
```

That's it. 30 seconds. One call.

The next session that touches the same area retrieves it in ~150 tokens instead of re-deriving it at ~3,000.

**90% reduction in tokens for that knowledge. Break-even is the second re-discovery.**

---

### The non-obvious part

Re-derivation isn't a failure. The agent is working correctly — it just doesn't know what a previous session already figured out. The failure is systemic: there's no shared layer where session N's findings are available to session N+1.

CLAUDE.md and ADRs are a partial answer. They capture decisions someone had the foresight to document. But the constraint about consumer group initialization was never going to make it into an ADR. Too operational. Too embedded in implementation detail. Too easy to assume "someone else will write it down."

The constraints that cause re-derivation are precisely the ones that don't get documented.

---

### Questions I'm curious about

1. Has anyone else measured this in their own session logs? Does 2,000–5,000 tokens per re-derivation match what you've seen?
2. How are people handling cross-session memory today — CLAUDE.md only? Session summaries? Something else?
3. For teams running multiple agents in parallel (not just sequential sessions), does this compound differently than I'm modeling?

---

I've been working on something that handles this. Happy to share more details with anyone who's hit the same wall — not pitching, just want to know if the problem is as widespread as it feels from where I'm sitting.

---

**[end of post]**

---

## Notes on what's intentionally left out

- No mention of the storage layer (how the memory is persisted or retrieved)
- No mention of the ingestion pipeline or how multi-source context is assembled
- No mention of drift detection, impact analysis, or temporal queries
- The "tool" is described behaviorally (log it / retrieve it) not architecturally
- "Cross-session agent memory" is the concept — not an implementation recipe

The post shows the problem is real (measured, specific), shows the economic argument, and ends with a genuine question that invites discussion. Anyone who wants to clone this still has to solve: storage, retrieval quality, ingestion from multiple sources, multi-tenancy, and the MCP server interface — none of which are mentioned.
