# LinkedIn Post — Week 1, Post 1
# Topic: The two ways agent memory fails (no product mention)

---

My AI agents are making decisions I don't know about.
I'm making decisions they don't know about.
And they don't know what each other decided either.

I built a shared decision log for human-agent teams to find out whether it would actually hold up. Somewhere humans and agents both read from and write to. The infrastructure wasn't the hard part.

Two ways shared agent memory fails in practice:

**Failure mode A: the agent never writes.**
Session ends, nothing logged, next session starts cold. Re-derives everything the previous session already figured out. You notice this one quickly.

**Failure mode B: the agent writes, but logs the wrong thing.**
The memory store fills up. Looks healthy. But the next session queries it and gets back "used TypeScript, used Postgres, created a users table." Facts, not decisions. What was done, not why. It re-derives anyway, from a store that looked full.

This one is invisible. You don't notice until weeks in and the memory hasn't helped once.

The instinct is to fix both with a better prompt. It doesn't work. They pull in opposite directions and need completely different solutions.

Wrote up what actually works and why. Link in comments.

---

*[link to Substack post in first comment]*
