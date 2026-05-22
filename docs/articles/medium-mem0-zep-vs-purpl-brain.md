# Mem0 and Zep Don't Ask the Agent to Cooperate. We Do. Here's Why.

*~6 min read*

---

When I started building purpl_brain, I spent a lot of time thinking about the write-back problem — how to get AI agents to reliably log what they decided and why. Session-end hooks, mid-session prompts, server-side validation gates. All of it aimed at the same question: how do you make an agent write to a memory system it didn't ask for?

Then I looked at how Mem0 and Zep handle it.

They don't ask.

---

## How They Actually Work

Both Mem0 and Zep intercept at the application layer, not the agent layer. The write path doesn't go through the agent at all.

With Mem0, you call `mem0.add(messages)` from your orchestration code, passing the raw conversation turns from the session. Mem0 runs its own extraction pass over every message pair, identifies salient facts, and writes them to its store. The agent is never involved. If the agent crashes halfway through, or ignores every instruction it was given, memory still gets written — because the write path doesn't depend on the agent deciding to do anything.

Zep does the same thing with a graph-first architecture. Every conversation episode automatically becomes a graph update. Entities, relationships, when facts became true, when they stopped being true. The developer instruments the application once and every session is covered.

Write-back rate for both: close to 100%, by construction.

---

## This Is a Better Architecture for One Specific Problem

I want to be honest about this: for the trigger discipline problem — getting *something* into memory from every session — their approach is structurally superior to mine.

There is no version of "ask the agent to cooperate" that achieves 100% coverage. Even with a session-end hook, a well-written CLAUDE.md, and mid-session logging instructions, we see roughly 85-90% compliance on Claude Code with the hook running. Drop the hook and it falls to 60-70%. Move to a platform without a hook system and you're depending entirely on the agent following prompt instructions, which is 40-60% in practice.

Mem0 and Zep sidestep all of that. The developer wires it in once and walks away.

---

## The Tradeoff Nobody Talks About

What they get from every session is facts, not decisions.

An automatic extraction pass over raw conversation produces entries like:

> *"Team is using TypeScript."*
> *"Chose Postgres."*
> *"Created a users table."*

These describe what was done. They don't describe why it was done, what the alternatives were, what the constraint was that shaped the choice, or whether the choice is still valid a month later. They pass the "did we write something" test and fail the "is this useful to a future agent" test.

This isn't a criticism of the engineering — it's a product decision. Mem0 and Zep were designed for conversational continuity and personalization. Remembering that a user prefers TypeScript, or that a customer's name is David, or that the last session was about authentication. That's genuinely useful and it works.

The problem I was trying to solve is different: why did the team decide to use TypeScript at all, what did they consider before deciding, and is that decision still valid given what's changed in the codebase since?

That reasoning doesn't survive automatic extraction. A transcript that says "let me check... okay I'll use TypeScript" doesn't contain the tradeoff analysis. The LLM extractor can identify that a choice was made but it can't reconstruct the thinking behind it, because that thinking may never have been made explicit in the conversation.

---

## Two Different Products

The more I've looked at this, the more I think Mem0/Zep and purpl_brain are solving adjacent but distinct problems.

Mem0 and Zep store **conversational memory** — what was said, what was decided, what the user's preferences are. Good for personalization, session continuity, cross-session coherence. The agent tomorrow should know what the agent yesterday talked about.

purpl_brain stores **decision provenance** — why something was decided, what was considered before deciding, what the confidence level was, and whether that decision has been contradicted by something that happened since. The agent tomorrow should know *why* yesterday's agent chose connection pooling over request-scoped connections, and whether the concurrency model assumption that drove that choice is still valid.

These are different things. A Mem0 memory from an agent coding session might be: *"team chose connection pooling."* A purpl_brain decision is: *"chose connection pooling over request-scoped connections because the concurrency model creates contention under load; alternative was per-request connections which were rejected due to connection overhead at scale; confidence high."*

Whether the richer record is worth the write-back friction depends entirely on what you need from memory.

---

## Where We're Exposed

Being honest about the gap: if the agent doesn't cooperate, our brain goes empty. An empty brain teaches users the product doesn't work and they stop using it. This is the single biggest product risk we're carrying into beta.

Mem0 and Zep don't have this failure mode. They have a different one — the brain fills up but the content isn't rich enough to actually help. But a brain with low-quality content is harder to notice than an empty brain, and teams are more likely to stay engaged long enough to improve the setup.

The mitigation we're building: if the agent doesn't log during a session, the session-end hook reads the raw transcript and runs our own extraction pass on it — the same way Mem0 does, as a fallback. Auto-extracted entries are flagged as lower confidence and don't trigger drift detection until a human or a future session promotes them. The brain has something rather than nothing. Teams stay engaged. The setup gets refined.

This doesn't close the quality gap. Auto-extraction from a raw transcript produces the same fact-not-reasoning problem. But an empty brain is worse than a noisy brain in practice, and the fallback buys time to get teams to the point where proper logging becomes habit.

---

## The Bet

We're betting that for software engineering teams specifically — teams running multiple agents across a shared codebase, making architectural decisions that compound over months — structured decision trails with rationale are worth the setup cost. The morning dashboard that shows which decisions your agents made overnight, which ones conflict, and which old decisions have been contradicted by new signals: that only works if the decisions in the brain are rich enough to reason about.

Mem0 and Zep could build drift detection and impact analysis on top of their stores. But the underlying data — facts without reasoning — makes those features much weaker. "Team is using TypeScript" doesn't tell you whether a new JavaScript-based library contradicts a past decision or is simply consistent with the existing direction.

The reasoning is what makes the memory useful for the problems we're trying to solve. Getting that reasoning into the system reliably, without requiring perfect agent cooperation, is the unsolved part of the product.

---

*purpl_brain is in private beta. If you're running AI agents on a shared codebase and hitting these problems, we'd like to talk.*

<!-- MEDIUM IMPORT INSTRUCTIONS
1. No diagrams in this article.
2. Use Medium's import feature: Profile → Stories → Import a story. Do NOT paste markdown directly.
3. Suggested tags: AI Engineering, Developer Tools, Machine Learning, Agents, Software Architecture
-->
