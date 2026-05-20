# User Personas — Purpl Brain

The pivot ranking: the AI Agent is now the primary persona. The Agent Operator (a developer who runs AI coding agents heavily) is the primary human persona. The Context Switcher and Tech Lead / PM are kept as secondary beneficiaries — they get value from the brain as a byproduct of agents writing to it, but they are not the buyer.

---

## Persona 1: The AI Agent (Primary)

**Type:** AI coding agent — Claude Code, Cursor, GitHub Copilot, Devin, Aider, custom MCP-aware client
**Pattern:** Invoked by a developer for a bounded task. Runs in a session with a fixed context window. Session ends. Resumed (possibly in a different IDE, possibly by a different human) hours, days, or weeks later.

### Situation
A session opens on `repo/auth-service`. The agent has no awareness that two weeks ago, another session in the same repo decided to drop `jose` in favor of `node-jsonwebtoken` because of a JWE bug, evaluated and rejected a refresh-token-rotation pattern, and left an unresolved question about session revocation. The agent re-derives the library choice (possibly picking `jose` again), re-evaluates the refresh pattern, and the developer has to manually re-paste the prior decisions or accept the regression.

### Goals
- Read prior session decisions on the same repo or module at session start, without the developer doing anything
- Emit structured decisions, alternatives considered, and unresolved questions at session end so the next session inherits them
- Avoid contradicting prior decisions made by itself, by other agent sessions, or by humans
- Get cited context for any claim it makes back to the developer

### How Purpl Brain Helps
The brain is the agent's persistent memory across sessions. On invocation, the agent calls the `brain_query` MCP tool with the current task description and gets back a cited summary of prior decisions, open questions, and relevant signals. At session end, it calls `POST /brain/agent-log` with a structured decision log. The next session — same agent, different agent, doesn't matter — inherits that log via the same MCP read path.

### Concrete Usage Scenario
1. Developer opens Claude Code on `repo/auth-service` to add session revocation support.
2. Claude Code, configured with Purpl Brain's MCP server, calls `brain_query` with the task description and the repo.
3. The brain returns: "Two weeks ago, session `abc123` chose `node-jsonwebtoken` over `jose` (cited: agent-log `abc123`, rationale: JWE incompatibility in `jose@5.x`). The same session left an open question about session revocation strategy (cited: agent-log `abc123`, unresolved field)."
4. Claude Code begins the task with that context. It does not re-evaluate the library choice; it picks up the open question directly.
5. The developer makes one correction in chat: "use Redis for the revocation list, not Postgres."
6. Claude Code completes the task. On session end, it calls `POST /brain/agent-log` with:
   - decisions: `[{ decision: "revocation list stored in Redis", rationale: "low-latency lookup on every request, ttl-native eviction" }]`
   - alternatives_considered: `[{ option: "Postgres", reason_rejected: "developer override; latency budget" }]`
   - unresolved: `[{ question: "do we need a per-user revoke-all endpoint?" }]`
7. Three days later the developer opens Cursor on the same repo. Cursor, configured with the same MCP server, calls `brain_query` and gets back both prior decisions (the library and the revocation list) plus the unresolved question. No human re-paste.

---

## Persona 2: The Agent Operator (Primary Human Persona)

**Name:** Sam, Senior Engineer / Solo Developer
**Team size:** 1–8 engineers, often solo across multiple projects
**Environment:** 2–5 active repos. Uses Cursor or Claude Code as a primary editor. Runs 5–20 agent sessions per day across personal projects, side projects, and client work. Already pays for Cursor Pro or Claude Max.

### Situation
Sam runs AI coding agents heavily — most code touched in a day passes through an agent at some point. Sam's frustration is not that the agents are bad at code. It is that Sam has become the human memory bus: every new session starts with the same paragraph of pasted context ("we're on Next.js 15, App Router, Postgres with Drizzle, deployed on Fly, the auth is custom, don't suggest Clerk"). When the agent makes a decision Sam approves, that decision lives in the chat transcript and dies there. The next session re-asks.

### Goals
- Stop manually re-pasting project context at the start of every agent session
- Audit and review what the agents decided, when, and why — with citations to source signals
- Catch when a new agent session is about to contradict a prior decision before it lands as a commit
- Hand off a repo to a future-self or a teammate with the agents' decision history intact

### Frustrations
- Cursor's project rules require manual authorship and don't capture decisions agents make mid-session
- Claude Projects' pinned files are static and only work in Claude.ai
- Reviewing what an agent did three sessions ago requires scrolling through chat transcripts that no longer exist after a fresh window
- No tool lets the agent itself write back what it learned

### How Purpl Brain Helps
Sam installs the Purpl Brain MCP server into Cursor and Claude Code in five minutes. From then on, every session reads from and writes to the brain automatically. Sam queries the brain from a web UI to audit agent decisions: "what did Claude Code decide about the cache layer last week" returns a cited answer pointing to the specific agent-log entry. Drift alerts surface when a new session is about to contradict an old decision. The context-paste ritual goes away.

---

## Persona 3: The Concurrent Project Developer (Primary Human Persona — Profile B)

**Name:** Maya, Solo Developer / Micro-Founder
**Team size:** 1 (herself), 5–10 simultaneous AI-assisted projects
**Environment:** Overnight and weekend autonomous agent runs. Cursor or Claude Code open all day. Bounces between a SaaS product, two client projects, an open-source library, and several experimental repos. Each project has its own agent history.

### Situation
Maya runs agents on multiple projects in parallel — often kicking off an overnight run on two or three repos and reviewing the diff in the morning. Her problem is not context within one project; it is oversight *across* projects after agents have been running without her.

The risk Maya is managing: an agent working on Project B absorbed context it shouldn't have — a constraint from Project A leaked in through a shared prompt, a library decision from one repo was mirrored to another without reason, or two agents in different projects made incompatible infrastructure choices that will collide when she eventually integrates them.

She has no dashboard for this. She checks each repo's git log manually, re-reads agent transcripts that may no longer exist, and has no way to surface cross-project contradictions without doing the analysis herself.

### Goals
- Wake up to a summary of what every agent decided overnight, not a pile of diffs to review
- Catch cross-project contamination before it's merged — did the agent bring in assumptions from another project?
- See all pending drift alerts across all projects in a single inbox, not one-per-project navigation
- Confirm that each project's agent is working from that project's decisions, not contaminated by another's

### Frustrations
- Every tool (Cursor, Claude Code) is single-project scoped in its UI
- No way to see "decisions made across all my projects in the last 24 hours" without clicking through each repo
- Agent transcripts expire; the decisions they contain are lost unless explicitly persisted
- No contradiction detection across projects — only within one repo at a time

### How Purpl Brain Helps
The `/` root view is Maya's command center: all projects listed with health state, pending drift count, last agent session time, and last event time. She scans it in thirty seconds each morning. Clicking a red drift badge opens the specific contradictions waiting for triage. The `GET /brain/agent-sessions?project_id=X` endpoint surfaces every decision the overnight agent made for each project. She approves or flags before pushing.

The Profile B use case is served entirely by the multi-project dashboard endpoints and the drift inbox UI that are part of the Profile B build (Phase 3). Nothing in the agent write-back or MCP layer changes; the new surface is purely observability-facing.

---

## Persona 4: The Context Switcher (Secondary Beneficiary — Profile A)

**Name:** Alex, Senior Software Engineer
**Status:** Secondary persona. Gets value from the brain because the agent decision history is also human-queryable, not because Purpl Brain was built primarily for them.

### Situation
Alex works on a feature, gets pulled into a P0 for four days, returns to find their own prior agent sessions on the original branch. Reconstructing where the agent left off — what it tried, what it ruled out, what it was waiting on — takes time.

### How Purpl Brain Helps
Same agent-log query path the next agent session would use. Alex queries: "what was the agent working on in this repo last week" and gets a cited summary. This persona is served by Persona 1's product; nothing in the roadmap is built specifically for it.

---

## Persona 5: The Tech Lead / PM (Secondary Beneficiary)

**Name:** Jordan, Engineering Manager / Technical PM
**Status:** Secondary persona. Benefits from agent decision auditability for oversight, not the target buyer.

### Situation
Jordan oversees a team of engineers who use AI coding agents heavily. Jordan needs to know what the agents decided, where the agents are likely to have made suboptimal choices, and whether the team is converging on consistent patterns across repos.

### How Purpl Brain Helps
Cross-session, cross-repo audit queries: "show me every decision the team's agents made about retry logic in the last 30 days." Drift alerts when agents in different repos converge on incompatible patterns. This is oversight, not the primary use case.

---

## Deprecated / Removed Personas

**The Floating Specialist (Priya)** — removed as a primary persona during the agent-memory pivot. The original ICP analysis assumed enterprises with dedicated security or platform specialists. That is not the buyer for an agent memory layer priced at $10–30/month. The persona is preserved in git history (see `vision.md` pre-pivot) but is no longer a design target.
