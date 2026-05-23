# Reddit Post — Week 1
# Target: r/LocalLLaMA, r/ExperiencedDevs (post separately, not simultaneously)

---

## Title options (pick one per subreddit)

- "End-of-session agent memory logging loses your best decisions. The timing is the problem."
- "I've been experimenting with shared memory for AI agents. The problem wasn't storage, and fixing it wasn't a prompt."
- "Agent memory: why the agent that logs faithfully still leaves the next session starting cold"

---

## Body

Been experimenting with shared persistent memory for AI coding agents for the past few weeks. Vector store, knowledge graph, write API, the whole thing.

Hit two failure modes I haven't seen written up clearly anywhere:

**Failure mode A: the agent never writes.** Memory stays empty. Easy to diagnose, frustrating to fix reliably. The obvious solution is a session-end hook, but there's a catch: by the time the session ends, the context window is full of later work. Early decisions, the ones most worth logging, have already been compressed and partially forgotten. Mid-session logging captures the reasoning while it's still explicit in context.

**Failure mode B: the agent writes, but logs actions instead of decisions.** "Used Redis." "Created users table." These pass the write call but fail the usefulness test. The next session queries and gets back facts with no rationale. It re-derives anyway.

The fix for B ended up being server-side, not prompt-side. A validation layer that rejects entries missing rationale fields, with a structured error message the agent can act on, produces better logs than any amount of prompt engineering. The agent retries with a better entry. One round-trip.

The thing that surprised me: Mem0 and Zep sidestep failure mode A entirely by intercepting at the application layer rather than asking the agent to cooperate. But they end up in failure mode B by default. Automatic extraction produces facts, not reasoning. Different tradeoff, not a solved problem.

Has anyone dealt with this differently? Curious what setups people are actually running.

---

*[Optional: "I wrote this up in more detail here if useful: [link]"]*

---

---

## r/LocalLLaMA

**Title:** End-of-session agent memory logging loses your best decisions. The timing is the problem.

Been experimenting with shared persistent memory for AI coding agents for the past few weeks. Qdrant for semantic retrieval, Neo4j for the decision graph, MCP server as the agent interface. Works with any LLM — I've tested with Claude and Ollama-hosted models. The write-back problem is the same regardless of what's running under the hood.

Hit two failure modes that apply no matter what stack you're on:

**Failure mode A: the agent never writes.** The session ends, nothing is logged, and the next session starts cold. The obvious fix is a session-end hook. The problem: by the time the session ends, the context window is full of later work. Decisions made in the first hour of a three-hour session have already been compressed. The agent reconstructs them from a summary, not the original reasoning. Mid-session logging captures the rationale while it's still explicit in context.

**Failure mode B: the agent writes, but logs actions instead of decisions.** "Used Redis." "Created users table." These pass the write call but the next session gets back facts with no rationale and re-derives anyway. The fix was server-side: a validation layer that rejects entries missing rationale fields and returns a structured error the agent can act on. The agent retries with a better entry. One round-trip beats any amount of prompt engineering.

The tradeoff with Mem0 and Zep: they sidestep failure mode A entirely by intercepting at the application layer — no agent cooperation required. But automatic extraction from conversation transcripts produces facts, not reasoning. Different architecture, different failure mode. Not a solved problem either way.

Curious what memory setups people are running with local models. Does the write-back problem look different when the model is slower or has a shorter context window?

*[Optional: "Wrote this up in more detail here if useful: [link]"]*

---

## r/ExperiencedDevs

**Title:** Agent memory: why the agent that logs faithfully still leaves the next session starting cold

If you're running AI agents across a team with multiple developers, this compounds fast.

Been experimenting with shared persistent memory for AI coding agents for the past few weeks. The infrastructure part was straightforward. The failure modes weren't.

**Failure mode A: the agent never writes.** Session ends, nothing logged, next session starts cold and re-derives everything. You notice this one quickly. The fix is a mid-session trigger, not just a session-end hook — by the time the session ends, early decisions have already been compressed out of context. The agent reconstructs from a summary. You get a worse log than if it had written mid-session while the reasoning was explicit.

**Failure mode B: the agent writes, but logs the wrong thing.** The memory store fills up. Looks healthy. But query it from the next session and you get back "used TypeScript, used Postgres, created a users table." Facts about what was done, no rationale for why. The next session re-derives anyway, from a store that looked full.

This one is invisible until weeks in and the memory hasn't helped once.

The fix for B was server-side enforcement, not a better prompt. A validation layer that rejects log entries missing rationale and returns a structured error the agent can act on. The agent retries with a better entry. Prompt instructions alone pull in both directions at once — aggressive enough to guarantee logging tends to over-log; selective enough to filter carefully tends to under-log. You need separate mechanisms for each failure mode.

Has anyone dealt with this at team scale? Curious whether the failure modes shift when multiple developers are running independent sessions against the same codebase.

*[Optional: "Wrote this up in more detail here if useful: [link]"]*

---

## r/MachineLearning

**Title:** Why automatic extraction from agent transcripts loses the reasoning even when it captures the action

Been experimenting with shared persistent memory for AI coding agents for the past few weeks. One finding worth writing up: automatic transcript extraction and agent-cooperative write-back fail in opposite ways, and the distinction matters more than it looks.

**The extraction quality problem:**

Mem0 and Zep intercept at the application layer — you pass raw conversation turns, they run an extraction pass and write to their store automatically. Near-100% coverage by construction. The failure mode is what gets extracted: facts, not decisions.

In my testing, a conversation that produces "okay, I'll use Redis for the revocation list" gets extracted as "team uses Redis." The reasoning — TTL-native eviction, the concurrency model, what Postgres would have required instead — didn't survive the extraction pass. The transcript doesn't contain the rationale explicitly; it's implicit in the back-and-forth that led to the conclusion. I haven't run a systematic eval comparing extraction output to cooperative write-back output — this is an observation from manual inspection, not a controlled study.

**The cooperative write-back tradeoff:**

The alternative is asking the agent to call a write API explicitly, with a structured schema: description, rationale, alternatives considered. You get the reasoning, but you depend on the agent cooperating. In my setup with Claude Code and a session-end hook, compliance ran around 85-90% — rough estimate, not a controlled measurement. Without the hook, closer to 60-70%. The sessions most likely to skip logging are the high-stakes ones where the agent hit something unexpected.

**What server-side validation does:**

A validation layer that rejects entries missing rationale fields and returns a structured error forces a retry with a better entry. One round-trip. The schema contract produces better logs than prompt instructions alone, because prompt instructions can't create a feedback loop — the API can.

The core tradeoff: automatic extraction at near-100% coverage with shallow facts, versus cooperative write-back at ~85% coverage with structured reasoning. Neither is clearly better. It depends on whether you need to know what happened or why it was decided.

The part I haven't resolved: whether structured extraction prompts with explicit rationale fields can close the quality gap. Basic extraction clearly loses reasoning. But a more targeted prompt — "extract the decision, the rationale, and what was rejected" — might recover more than I've measured. Has anyone run an eval on this? Curious how much rationale is actually recoverable from transcripts with better prompting, versus genuinely absent because the agent never made it explicit.

*[Optional: "Wrote this up in more detail here if useful: [link]"]*
