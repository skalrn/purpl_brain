---
sidebar_position: 1
---

# The Re-Derivation Problem

## The cost of starting from zero

An agent session that evaluates three caching libraries, reads through implementation tradeoffs, and lands on a well-reasoned choice produces one durable artifact: a decision. If that decision is not persisted somewhere the next session can read, the session produced nothing structurally different from a conversation that was deleted. The next agent starts the same evaluation from the same place.

Rough cost per re-derivation event: 15-30 minutes of context reconstruction across the LLM, the developer reviewing agent outputs, and any follow-up clarification. On 5-20 sessions per day across 2-5 repos, this compounds. A team of 4 engineers doing this daily loses 2-4 hours per week to knowledge that was already produced and paid for.

## The 91% recall gap

The more concrete failure mode is what we measured during development. When documents — ADRs, design docs, architecture notes — contain embedded GitHub PR URLs, those PR comment threads are where the actual decisions happened. The document might say "we chose Approach B" but the PR discussion has the rationale, the alternatives that were evaluated, and the reason Approach A was rejected.

Before adding link-following to the extractor, ingesting a document captured only the document text. The PR discussions referenced within it were never ingested. Measuring extraction recall against labeled decision sets from real projects showed 91% of the decisions that actually lived in linked PR discussions were missed entirely. The brain had the conclusion but not the reasoning.

The fix was to follow embedded GitHub PR URLs during extraction, fetch the PR body and comment thread, and enqueue those as additional ingestion events. Recall went to 100% on the test set. The lesson: the decision and the rationale are often in different places, and a system that only ingests one is structurally incomplete.

## Two failure modes, not one

The empty brain problem has two distinct shapes, and they require different interventions.

**Failure mode A: the agent does not write to the brain at all.** The session ends — because the developer closes the terminal, because context compaction happens, because the session was interrupted — and no decision log is emitted. The brain is empty. When the next session queries, it gets nothing. A user who sees consistent nothing-responses concludes the product does not work and stops using it.

**Failure mode B: the agent writes to the brain but the content is useless.** Decision logs that say "used TypeScript" or "added a function" are not decisions — they are implementation notes. A brain full of entries like "team used TypeScript on this project" or "wrote a helper utility" will return results for every query, but none of those results will help an agent pick up context from a prior session. The product appears to work but does not. This failure mode is harder to diagnose because the query log shows answers being returned; only reading the actual brain content reveals the problem.

Both failure modes result in the same user behavior: the developer stops querying the brain because it has never been useful. The difference is that an empty brain is easy to diagnose and explain; a noisy brain looks functional until someone inspects it carefully.

The mitigations for each are different. Trigger discipline (getting the agent to call the write-back tool at all) uses hooks, callback handlers, and instruction layers. Content quality (getting the agent to log decisions worth keeping) uses server-side validation gates that reject logs missing rationale and schema constraints that require `alternatives_considered` on accepted decisions. An empty brain and a noisy brain need different fixes.

## The linked PR bug found in production

During the link-following implementation, a specific bug was discovered that illuminates a broader pattern. The drift detector code was reading `decision.summary` from Neo4j query results to build candidate comparisons. But in some code paths, the graph query did not include `summary` in the return columns, so `decision.summary` was `undefined`. When the drift detector passed `undefined` to Qdrant for embedding, Neo4j threw a `ParameterMissing` error on the write path.

The symptom was silent: the drift detector would process an event, fail during candidate lookup, log a warning, and continue. Decisions that should have triggered drift alerts produced no alerts. No error was surfaced to the user.

The fix was explicit: ensure every graph query that feeds the drift detector selects `summary` explicitly, and add a guard that skips candidates with missing summaries rather than propagating `undefined` downstream. But the underlying lesson is that undefined can travel silently through a pipeline of optional fields until it causes a database error three hops later.
