# LinkedIn Post — Week 1, Post 1
# Topic: The two ways agent memory fails (no product mention)

---

I spent three months building shared persistent memory for AI coding agents.

Vector store, knowledge graph, write API, MCP read path. The works.

Then I ran a real session and discovered the actual problem has nothing to do with storage.

There are two ways agent memory fails in practice — and they require completely different fixes:

**Failure mode A — The agent never writes.**
The session ends. Nothing was logged. The memory store is empty. The next session starts cold, re-derives everything the previous session already figured out.

This one is obvious when it happens. You notice.

**Failure mode B — The agent writes, but writes noise.**
The memory store is growing. Everything looks healthy. But when the next session queries for context, it gets back:

*"Previous session used TypeScript. Used Postgres. Created a users table."*

Facts, not decisions. What was done, not why. The next session can't build on it — it re-derives anyway, from a memory store that looked full.

This one is invisible. You don't notice until you're three weeks in and the brain hasn't helped once.

The instinct is to solve both with a better prompt. It doesn't work. These two failure modes pull in opposite directions — instructions aggressive enough to guarantee logging produce over-logging. Instructions that filter carefully produce under-logging.

They need separate solutions.

I wrote up what actually works, including why content quality enforcement belongs on the server rather than the prompt, and why mid-session logging is a quality problem as much as a reliability one.

Link in comments.

---

*[link to Substack post in first comment]*
