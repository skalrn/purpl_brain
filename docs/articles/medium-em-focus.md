# Your Agents Are Making Engineering Decisions. Who's Accountable?

I've been building software with AI agents for long enough to notice a management problem that nobody talks about.

We talk about agent capability. We talk about prompt engineering. We talk about context windows. We do not talk about the fact that agents are now making engineering decisions — real ones, with real downstream consequences — and most teams have zero infrastructure to track, review, or build on those decisions.

That is not a tooling gap. It is a management gap.

---

## What Agents Actually Do on a Team

When people say "we're using AI agents," they usually mean: we have Claude Code or Copilot helping individual developers write faster. That is true of a lot of teams.

But the teams ahead of that curve are using agents to take tasks end-to-end: accept a spec, explore the codebase, make trade-off calls, write and iterate on code, and close the loop with a summary. Across multiple sessions. Across multiple agents running in parallel.

Those agents are not just generating code. They are choosing libraries. Rejecting approaches. Introducing architectural assumptions. Finding constraints nobody documented. Each of those is a decision with downstream consequences for the humans and agents that come after.

The problem: those decisions evaporate when the session ends.

An engineer who makes a call in a PR comment, a Slack thread, or a design doc leaves a trace. It is often messy, hard to find, and poorly indexed — but it exists. An agent that makes a call in a session leaves nothing. The session ends, the context clears, and the next session starts from scratch.

Your team is building on a foundation that keeps disappearing.

---

## The Re-Derivation Tax

Here is the compounding effect that took me a while to fully see.

If one agent session spends thirty minutes re-establishing context from previous work — re-reading files, re-running analysis, re-arriving at conclusions someone already arrived at — that is thirty minutes of re-derivation. Annoying, but manageable.

Now multiply that across every session on the project. Multiply it across every agent and developer who touches the same area. Multiply it across the months it takes to ship something real.

The re-derivation tax is not thirty minutes. It is a percentage of every session, forever, until the team either builds memory infrastructure or the project ends.

I measured this indirectly: decisions logged by three different agent sessions over three weeks were recalled correctly by a new session with no shared context. Cross-session recall: 5/5. What I could not measure, but felt constantly, was the sessions before I had the logging in place — the decisions that had to be re-derived because there was nowhere they could have been stored.

The tax is invisible because it looks like normal work. The agent is busy. It appears to be making progress. It is making progress, but some of that progress is re-deriving things already figured out, because there was nowhere to put what was figured out.

---

## The Missing Layer: Decisions as First-Class Records

The standard answer to this problem is "better documentation." ADRs, runbooks, decision logs. Write things down.

This answer is partially right. ADRs are for decisions significant enough to warrant a formal record. Most decisions aren't, and shouldn't be — the bar exists for good reason. Those decisions live in a Slack thread that ended without a summary, a PR comment that closed without a follow-up, or an agent session nobody wrote up because it felt like an implementation detail. They are still the decisions that determine how the codebase behaves.

The insight that reshaped how I think about this: the right unit is not a document. It is a decision record — the choice, the rationale, the alternatives considered, the confidence level, and who made it. Structured enough to be queryable. Lightweight enough that agents can write it at the moment of decision without disrupting work.

"We chose Redis" is a fact. "We chose Redis because TTL-native eviction matched the access pattern and Postgres would have required a background job" is reasoning the next session can actually apply to a different problem.

The difference between those two is the entire value of the system.

---

## Agents Need to Be Writers, Not Just Readers

The design choice that distinguishes this from a knowledge base: agents write to the memory, not just read from it.

An agent session that picks a library, rejects an approach, or discovers a constraint is producing a decision the same way a code review does. Treating agent output as ephemeral — something that lives in session context and then disappears — is the source of the re-derivation problem.

For engineering managers, this is a management question, not just an architecture question. If an agent is making decisions that affect the team's codebase, those decisions belong in the same record as decisions made by humans. The actor is different. The accountability should not be.

When I query the decision graph and see "chose Neo4j because the decision history needed to be temporal and overridable with actor attribution — decided by agent session agent-2025-11-14," that is a record I can reason about. I can see whether that decision is still holding. I can see when it was made and what context existed at the time. I can surface it to a new engineer joining the project or a new agent starting a session.

Without that record, the decision exists only in a session that ended months ago.

---

## What This Changes for the Management Layer

The immediate practical impact is onboarding — both human and agent.

When a new engineer joins, the question is not "can they read the code?" They can. The question is "can they understand the why behind the code?" Why this database and not that one. Why this approach was tried and rejected. Why this constraint exists. The code answers what. The decision graph answers why.

The same applies to agents starting a new session. An agent that queries the decision graph before touching a codebase does not have to re-derive the structural choices already made. It inherits them. It can work with them or challenge them with new information — but it does not have to pretend they never happened.

The second impact is drift detection. When work in progress contradicts a decision made months ago, the system surfaces it before the code ships. Not "this looks wrong" — "this contradicts a specific choice made on a specific date by a specific actor for a specific reason." That is not retrieval. That is the decision history doing active work.

For an engineering manager, that is the difference between discovering contradictions in code review and having them flagged before they become merged. The earlier the catch, the lower the cost.

---

## What I Would Build Into Every AI-Assisted Team

The infrastructure is not complicated. It is three things:

**Decision logging at the moment of decision.** Not at session end, not in a retrospective. At the moment the choice is made, with rationale attached. Agents can be instructed to do this; the instruction alone is not sufficient (more on that below).

**A hook to enforce the invariant at the session boundary.** CLAUDE.md instructions shape agent behavior during a session. They are aspirational — the agent follows them under normal conditions, but judgment degrades under context pressure. A Stop hook that checks whether any decisions were logged and blocks the session from closing if not is the enforcement layer. The instruction and the gate serve different purposes. You need both.

**A queryable graph, not a flat log.** Decisions override each other. A choice made in January that was revisited in March by a different person for a different reason is not two documents. It is a chain with temporal edges and actor metadata. A graph captures that structure. A flat document store or a vector database alone does not.

The combination gives you something an engineering manager can actually reason about: a navigable record of why the codebase is the way it is, kept current by both humans and agents, queryable before any significant change.

---

## The Open Question

I have validated this for one developer working with agents over months. Cross-session recall, drift detection, extraction quality — all tested and documented.

What I have not validated: multiple developers writing to the same graph.

That is the specific hypothesis worth testing. Does a shared decision graph hold value when there are two humans and multiple agents contributing to it? Does the structured format survive the messiness of real team disagreement, different writing styles, and competing rationale for the same choice?

I believe it does. The structure — decision, rationale, actor, timestamp — is language-neutral and role-neutral. A graph edge from an agent decision to the human decision that overrode it is the same structure regardless of who the actors are.

But belief is not evidence. That test requires teams willing to try it early.

---

The repo is open source at github.com/skalrn/purpl_brain. If you are managing a team that ships with AI agents and thinking about any of this — the re-derivation cost, the accountability gap, the onboarding problem — I am interested in the conversation.

---

<!-- MEDIUM IMPORT INSTRUCTIONS
- Use Medium's import feature: profile → Stories → Import a story (do not paste)
- No Mermaid diagrams in this article — nothing to export
- No tables in this article — nothing to convert
- Before importing: run /article-audit on this file to catch any fabricated claims or voice inconsistencies
- Recommended tags: Engineering Management, AI Engineering, Software Engineering, LLM, AgentOps
- Target audience: EMs and tech leads managing teams using AI agents at meaningful scale
- This is the EM-focused companion to medium-institutional-memory.md (builder perspective)
  and medium-claude-md-is-not-a-contract.md (reliability perspective)
- Reading time: ~8 minutes
- Validated metrics (as of 2026-05-27, qwen2.5:7b + llama3.1:8b):
    Cross-session recall: 5/5 (100%)
    End-to-end answer recall: 95.5% (21/22 queries) — corpus: top 50 PRs + 30 issues
      from honojs/hono sorted by comment count (min 3, bots + trivial bumps filtered);
      22 queries written before eval covering router design, breaking changes, migration
      rationale, middleware rejections, and negatives; auto-graded with partial credit
    Query latency: ~14s p50 / ~28s p95 local Ollama (llama3.1:8b); ~2s cloud API
    Citation faithfulness: 0 fabricated
-->
