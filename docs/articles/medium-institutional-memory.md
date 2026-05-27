# What Happens When You Give AI Agents Institutional Memory

I built purpl-brain as a personal project to test a specific hypothesis: AI agents start every session cold, re-deriving context that previous sessions already settled. If you give them a shared decision memory, does that actually fix it? This is what I built, what the architecture looks like, and what I learned.

The standard answer is better documentation: ADRs, runbooks, decision logs. That answer is partially right. ADRs are for decisions significant enough to warrant a formal record. Most decisions aren't, and shouldn't be. The bar exists for good reason. Those decisions live in a Slack thread that ended without a summary, a PR comment that closed without a follow-up, or an agent session nobody wrote up because it felt like an implementation detail. They are still the decisions that determine how the codebase behaves.

Take the decisions that accumulate on a real open-source project. Hono's `getPath()` function was modified to decode URL paths by default after a discussion about where URI decoding responsibility belongs in the router. A proposal to allow paths starting with `/` to be treated as absolute paths was rejected because it conflicted with the router's existing conventions. A digest middleware PR implemented only `generateDigest` and not the full spec because the scope cut was made for simplicity and performance reasons at the time. None of those made it into an ADR. All of them matter when the next session touches those areas. None of them survive a session boundary.

The repo is open source at github.com/skalrn/purpl_brain.

---

## The Unit of Memory

"Chose Redis" is a fact. "Chose Redis because TTL-native eviction matched the access pattern and Postgres would have required a background job" is reasoning the next agent can apply to a new problem.

**Decisions with rationale** are the unit that matters: not session logs, not documents, not CLAUDE.md files. Session logs capture everything, including noise. Documents capture what someone thought worth writing up. A decision record captures the choice, the alternatives considered, and the why behind it.

The hypothesis: extract that reasoning from wherever it happens (PRs, meeting transcripts, agent sessions) and make it queryable. The next session asks "what did we decide about auth?" and gets a grounded answer with provenance, not a summary of a summary.

## Why Two Databases

The brain store uses two databases, and the reason is worth explaining.

**Qdrant** (vector store) handles semantic retrieval: given a query about database choice, find decisions most related by meaning. **Neo4j** (graph store) handles provenance chains: what was decided, when was it overridden, by whom, and why?

A decision made in January that was overridden in March by a different person for a different reason is not a document. It is a chain of nodes and edges. Vector similarity finds the neighborhood. Graph traversal follows the chain. Neither alone answers both questions, and the query layer needs both to produce a useful answer.

## Agents as Writers, Not Just Readers

The design choice that separates this from a knowledge base: agents write to the brain, not just read from it.

An agent session that picks a library, rejects an approach, or discovers a constraint produces a decision the same way a PR review does. Treating agent output as ephemeral (something that lives in session context and then disappears) is the source of the re-derivation problem.

Human signals (PRs, Slack threads, meeting transcripts) go through an extraction pipeline: a normalizer strips noise, an extractor pulls structured decisions via LLM, a brain-writer commits to the graph. Agent decisions bypass extraction and write structured JSON directly. That distinction exists because agents can produce clean schema; raw human communication cannot.

## The Thing I Didn't Expect

Early in the build I added this to CLAUDE.md:

> Call `brain_log_decision` the moment a significant choice is made. Do not batch decisions for the end of the session.

The agent follows this instruction most of the time. Most of the time is not a reliability guarantee for a critical operation.

The failure mode isn't the agent ignoring the instruction outright. Under context pressure (long sessions, compaction events), the agent makes judgment calls about what counts as significant, and those calls degrade with less context than when they started. The analogy: telling a developer to write tests before merging produces the right behavior most of the time. You still need CI to enforce it. The instruction and the gate serve different purposes.

Claude Code supports lifecycle hooks: shell scripts that fire at specific points in a session. I wrote a Stop hook that checks the brain API for decisions logged in the last two hours. If none are found, it returns exit code 2, which blocks the session from closing. The agent reads the message, calls `brain_log_decision`, and the hook clears. CLAUDE.md shapes behavior during the session. The hook enforces the invariant at the boundary. Both layers are necessary.

## From Storage to Active Work

Reliable logging only matters if the stored decisions do active work later.

Before any significant change, the system can query what existing decisions it conflicts with. **Drift detection** runs in two stages: Qdrant finds semantically related decisions by cosine similarity, then an LLM confirmation pass eliminates false positives before surfacing an alert. For example, a decision made three months ago about JWT expiry scope flags when a new session proposes widening it, with the original rationale and the actor who made the call attached.

That is not retrieval. That is the graph doing work the agent cannot do from session context alone.

## What Validation Showed

Measured against manually labeled test cases. Self-measured, not independently verified.

**Working:**
- Cross-session recall: 5/5 decisions logged by different agent sessions, recalled correctly by a new session with no shared context
- Decision extraction F1: 85.7% against 30 manually labeled GitHub PRs (precision 92.3%, recall 80.0%)
- End-to-end answer recall: 95.5% (21/22 queries correct or partial). Corpus: top 50 PRs and 30 issues from honojs/hono sorted by comment count, minimum 3 comments, bots and trivial dependency bumps filtered out. Selection criterion was discussion volume — high-comment threads are where real decisions happen. No curated seed, no cherry-picked questions. 22 queries written before running the eval, covering router design choices, breaking change rationale, migration decisions, middleware rejections, and negatives (questions with no answer in the data). Graded by auto-scorer with word-overlap; partial credit for answers hitting some but not all expected facts.
- Drift detection: known contradictions caught with less than 8% false positive rate on benign content
- Citation faithfulness: zero fabricated source URLs or quoted text across all test cases
- Query latency: ~14s p50 / ~28s p95 on local Ollama (llama3.1:8b); ~2s on cloud API. Latency scales with answer complexity — synthesis queries over many chunks are slower than point lookups.

**Not yet validated:** multiple developers writing to the same graph. Whether the structured decision trail holds value when a second human joins is the specific hypothesis I want to test with real teams.

## Observations and Limits

**The hook catches sessions that close cleanly.** If a session crashes or is force-killed, the Stop hook doesn't fire. Decisions from interrupted sessions are not recovered by this mechanism.

**The harder problem is mid-session compaction.** A decision made three hours into a session and then compacted before close is lost even with a working Stop hook. The hook solves the boundary case; the mid-session case is still open.

**Logged decision quality depends on timing.** A decision logged at the moment it's made, when context is richest, is more complete than one reconstructed from a hook prompt at session close.

**Source coverage is partial.** Agent sessions and local documents are tested. GitHub and Slack ingestion are implemented but not yet run through a full validation pass.

## What I'd Build Differently

Mid-session checkpointing after any tool call that produces a structural change, not just at session end. The Stop hook was the right first step and it catches the case I anticipated. The more common failure (decisions compacted before the session boundary in a long session) is still open.

---

The system works end-to-end for one developer and a set of agents. The open question is what changes when a second human joins the graph. If that problem resonates with how your team is building, the repo is at github.com/skalrn/purpl_brain and I am interested in the conversation.

---

<!-- MEDIUM IMPORT INSTRUCTIONS
- Use Medium's import feature: profile → Stories → Import a story (do not paste)
- No Mermaid diagrams in this article — nothing to export
- No tables in this article — nothing to convert
- Before importing: run /article-audit on this file to catch any fabricated claims or voice issues
- Recommended tags: AI Engineering, Software Engineering, Engineering Management, LLM, Claude
- The existing article (medium-claude-md-is-not-a-contract.md) can be published as a follow-up or discarded
-->
