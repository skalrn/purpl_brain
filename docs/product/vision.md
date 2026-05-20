# Product Vision — Purpl Brain

## One-Line Statement

Purpl Brain is shared, auditable, cross-agent memory grounded in your team's full signal history. Every agent session — Claude Code, Cursor, Copilot, custom — reads from and writes to the same brain, with structured decision trails citing the GitHub PRs, Jira tickets, meetings, and prior agent runs they came from.

## The Problem

Every AI coding session starts from zero with respect to the team. Claude Code, Cursor, GitHub Copilot — each invocation opens with an empty context window and no awareness of what was decided last week, what was tried and rejected three days ago, or what architectural constraint was set when the project began. The agent re-derives, re-guesses, and often contradicts decisions it (or another agent, or a teammate) already made.

The providers know this and have shipped partial fixes. Claude Projects pins files per project. Cursor Rules persist prompts across sessions. ChatGPT has user-level memory. These help inside a single tool, for a single user, with unstructured text. They do not solve the team problem:

- Alice's Claude Code memory does not flow into Bob's Cursor session, and never will — neither provider has any incentive to integrate with a competitor's runtime.
- The memory is unstructured text recall, not auditable decisions with citations. You cannot ask "what did the agent decide about caching on May 3rd, and what PR did that come from?" — provider memory is opaque to that query.
- The memory has no awareness of the team's actual signal history — the GitHub PRs, the Jira tickets, the meeting transcripts where the real decisions live. It only remembers what the user typed into that one tool.
- The memory has no contradiction detection. If session 5 picks Redis and session 7 picks Memcached, neither provider will tell you.

The result: AI agents stay siloed by tool and by user. The work product of yesterday's agent in one developer's IDE is invisible to today's agent in another developer's IDE — and invisible to anyone trying to audit what the team's agents have been deciding on their behalf.

## The Insight

Agents and the humans working with them need the same thing: institutional memory that is shared across people and tools, structured enough to audit, and grounded in the actual signals where decisions were made. Not a wiki, not a Notion page, not a Slack thread, and not a per-tool memory drawer locked inside one vendor's runtime.

That memory needs four properties at once:

1. **Team-scoped, not user-scoped.** Two developers using two different agents on the same repo read from the same brain.
2. **Cross-agent, not provider-locked.** Claude Code and Cursor use the MCP adapter. Any other agent (Codex, Copilot, custom) uses the same REST API with a thin function-definition wrapper — the brain is not locked to any one runtime.
3. **Structured and cited, not unstructured recall.** Every stored decision carries who decided it, when, why, and a citation to the originating signal (PR, ticket, meeting, prior agent log).
4. **Grounded in the team's signal history.** Memory is enriched by ingestion from GitHub, Jira, Slack, and meeting transcripts — not just by what users have typed into one IDE.

This is not a knowledge base. A knowledge base is human-curated and read-only for agents. This is a team-scoped memory layer where agents are first-class writers and every entry is auditable.

## The Bet

If every agent session writes its decisions back to a shared brain, and every new session reads from that brain before doing anything else, then agents compound across time. Decision N+1 builds on decision N instead of replacing it. The developer stops being the human-memory-bus between sessions.

Concretely: an agent finishes a session and calls `POST /brain/agent-log` with its structured decisions, alternatives considered, and unresolved questions. The next session, in a different IDE or a different week, opens by calling the `brain_query` MCP tool. It gets back the prior decisions with citations and continues from there. The developer does nothing.

The bet is that this loop — write at session end, read at session start, MCP as the transport — is sticky enough to become the default memory layer for AI-assisted development, in the same way `.gitignore` became the default way to keep junk out of a repo.

## The Human Benefit

Humans get auditability and oversight of agent decisions for free. Because every agent decision is a structured log with citations and a rationale field, the developer can query "what did the agent decide about caching last week and why" and get an answer grounded in the agent's own log. This is the same query path the next agent uses, so there are no two sources of truth.

Drift detection comes along as a byproduct: when a new agent decision contradicts a prior one, the brain flags it. The developer sees "session 2 chose Redis; session 1 chose Memcached" before the contradiction lands in production.

The human use case (querying what happened, getting cited summaries, surfacing contradictions) is real and valuable. It is no longer the pitch. It is what falls out when agents have proper memory.

## Competitive Positioning

The direct comparisons a buyer will reach for first are the provider-shipped memory features: **Claude Projects, Cursor Rules / Project Memory, and ChatGPT Memory**. Address these head-on.

| Tool | What it does | Why it is not Purpl Brain |
|---|---|---|
| **Claude Projects** | Pinned files and persistent context per project, inside Claude.ai / Claude Code | Anthropic-only — Cursor and Copilot users see nothing. User-scoped — your teammate's project is invisible to you. Unstructured — no decision schema, no citation back to a PR or ticket, no contradiction detection. |
| **Cursor Rules / Project Memory** | Human-authored `.cursorrules` and an auto-updating project memory inside Cursor | Cursor-only, by design. Rules are human-authored; auto-memory is unstructured text. No write path for other agents. No grounding in Slack/Jira/meetings. |
| **ChatGPT Memory** | User-level memory across ChatGPT conversations | Per-user, per-account. Has no notion of a team, a repo, or a signal source. Not addressable by another agent. |
| GitHub Copilot Spaces | Repo-pinned context for Copilot | Closed to non-Copilot agents; no cross-session decision log; no Slack/Jira/meeting ingestion |
| Mem.ai | Personal notes with AI search | Single-user, manual capture. No agent write-back, no MCP, no decision schema. |
| Glean | Enterprise search across SaaS | Read-only for agents; no agent write path; sales-led, $30+/seat, wrong ICP |
| Notion AI | Q&A over a wiki | Human-curated content; no event ingestion; no agent decision schema |
| **Google A2A** | Agent-to-Agent communication protocol | Synchronous transport between live agents; not memory. No persistence, no semantic conflict detection, no cross-session awareness. Agents must both be running simultaneously and know each other's endpoints. Orthogonal technology — see Future Enhancements. |

**Where provider memory is going, and why it does not converge on Purpl Brain.** Every provider will keep improving the memory drawer inside their own tool — that is a given. None of them will build a *shared* memory layer that spans competing runtimes, because the strategic incentive runs the other way: each provider wants their memory to be the stickiest, not the most portable. None will reach into a team's GitHub, Jira, Slack, and meeting transcripts to ground decisions in signal history, because that requires per-customer SaaS auth and a multi-source ingestion pipeline that is not their core business. And none will offer an auditable decision schema with citations, because their pitch is "the agent remembers" — not "the agent's reasoning is on the record."

**Purpl Brain's defensible wedge, stated as a contract:**

- **Cross-agent and cross-tool by design.** MCP adapter for Claude Code and Cursor (zero-config after install); documented `POST /brain/agent-log` REST write path for any agent that can make an HTTP call. Two different agents, two different IDEs, two different humans, one brain.
- **Team-scoped, not user-scoped.** A project's brain is shared across the team. Permissions and isolation are by `project_id`, not by which Anthropic or OpenAI account you happen to be logged into.
- **Structured decision trails with citations.** Every stored decision has a maker, a rationale, alternatives considered, an unresolved-questions field, and a citation to the originating signal. Auditable. Queryable. Not opaque text recall.
- **Grounded in the team's full signal history.** GitHub PRs, Jira tickets, Slack threads, meeting transcripts, and prior agent logs flow through the same pipeline and link to the same decisions.
- **Drift detection across surfaces.** When a new agent decision contradicts a prior one — same agent, different agent, or human — the brain flags it before it lands.

Nobody is shipping all five at once. Provider memory will close the single-tool single-user gap. It will not close the team-scoped, cross-agent, audit-grade gap. That is the gap and that is the product.

## Ideal Customer Profile

**Profile A — The Agent Operator (primary):** Individual developers and small teams (2–8 engineers) who use Cursor, Claude Code, or GitHub Copilot as a daily driver, run multiple AI sessions per day, and feel the cost of re-pasting context every time. They already pay $20–100/month for AI coding tools. They will pay $10–30/month for the memory layer those tools are missing.

**Profile B — The Concurrent Project Developer (primary):** Solo developers and micro-founders running 5–10 simultaneous AI-assisted projects, often with overnight or background autonomous agent runs. They do not need a team-collaboration story — they need oversight of their own agent swarm: what did each agent decide while I was away, did any contradict each other across projects, what do I need to review before I push? The multi-project dashboard (all drift alerts across all projects in one view) is built for this persona. The acute risk they are managing is undetected cross-project contamination — an agent working on Project B references a decision it absorbed from Project A, without any human noticing.

**Secondary:** Platform engineering teams running automated agents (CI bots, dependency-bump bots, code-review bots) who need those agents' decisions to be auditable. Same write/read schema, different agent client.

Out of scope: enterprise rollouts, floating specialists across a 40-engineer org, teams that do not use AI coding assistants. These were targeted in the original positioning and proved to be a fight against Glean and Notion that this product cannot win.

## Strategic Bets, Ranked

1. **Agent write-back + MCP read is the entry point.** The first thing a new user does is install the MCP server into their Cursor or Claude config. The second thing they do is run an agent session that writes to the brain. The third thing is open a new session and see prior decisions surface. Everything else is supporting infrastructure for this loop.
2. **Human query is a secondary surface.** The same brain that serves `brain_query` to agents serves it to humans via a web UI. Cited answers, drift alerts, agent decision history — all present, none of it the lead.
3. **Multi-source ingestion is context enrichment, not the product.** GitHub, Slack, Jira, and meeting transcripts feed the brain so that agent queries return answers grounded in the full context of the project, not just prior agent logs. This is what makes the agent memory layer better than a local SQLite file. It is not the pitch.

The product is team-scoped, cross-agent, auditable memory grounded in the team's signal history. The defensibility is that no single-vendor memory drawer can ever span competing runtimes, ingest a team's full toolchain, or expose decisions as cited records. The proof is two sessions on the same repo — Claude Code, Cursor, or any HTTP-capable agent — where the second session knows what the first one decided and where that decision came from, without the developer doing anything between them.

## Future Enhancements

### A2A Protocol Integration

Google's Agent2Agent (A2A) protocol is a synchronous transport layer for live agent-to-agent communication. It is not memory — it does not persist, does not detect semantic conflicts, and requires both agents to be running simultaneously and know each other's addresses. It solves a different problem: real-time task delegation and capability negotiation between running agents.

These two layers are **orthogonal and potentially complementary**:

| Layer | Technology | What it solves |
|---|---|---|
| Asynchronous memory | Purpl Brain | Cross-session decisions, drift detection, temporal continuity |
| Synchronous transport | A2A | Live agent-to-agent delegation and real-time notification |

**Potential integration:** Purpl Brain could act as an A2A service endpoint. When the brain creates a `DriftAlert`, it could use the A2A protocol to push a structured notification to any agent session currently registered and running on the affected project. The running agent gets an in-session interrupt: "a decision you may be building on has been flagged as contradicted — review before committing."

This would close the real-time notification gap: today, agents only discover drift when they call `brain_query` at session start. With A2A as the delivery mechanism and the brain as the detection layer, an agent mid-session could receive a contradiction alert while the affected code is still being written.

**Why this is a future enhancement, not a current priority:**
1. A2A requires both parties to be live and addressable — most agent sessions are ephemeral, not long-lived services
2. The detection and persistence problem (which Purpl Brain solves) must be solved first; notification is secondary
3. A2A adoption is early; waiting for a more stable ecosystem reduces integration maintenance cost

### Infrastructure Agent Pre-Flight Checks

Agents configured with infrastructure MCP servers — PostgreSQL, Cassandra, Kafka, and similar — make architectural decisions as consequential as any coding agent: schema migrations, topic partitioning, keyspace restructures. These decisions are currently invisible to the brain, and the agents making them have no way to check whether they contradict prior decisions.

The pattern that makes this work requires no new brain capability — it is an application of the existing `brain_analyze_impact` and `brain_log_decision` tools to a broader class of agents:

- **Before a schema migration:** the infra agent calls `brain_analyze_impact` with the operation description. The brain surfaces any prior decision that the change may contradict — for example, "session `xyz` decided to migrate off Cassandra to PostgreSQL three weeks ago, cited: PR #142." The agent surfaces this to the developer instead of executing blindly.
- **After a successful migration:** the infra agent calls `POST /brain/agent-log` with the schema change as a structured decision. The decision enters the brain, becomes subject to drift detection, and is citable by any future agent — including coding agents building service layers on top of that schema.

This extends the brain's reach from "shared memory for coding agents" to "shared memory for every agent that touches the system's architecture." The same loop — read before acting, write after deciding — applies whether the agent is writing TypeScript or altering a Kafka topic schema.
