# Purpl Brain — Scenarios v2

**What changed from v1:** Earlier scenarios were built around what purpl_brain
prevents — bugs, missed constraints, failed reviews. Those framings didn't survive
scrutiny against a mature team with real tests, real ADRs, and real reviewers.

These scenarios are built around what purpl_brain *costs less* — specifically the
per-session context reconstruction cost that AI agents cannot amortise the way
human engineers can. The value is not correctness. It is the speed, completeness,
and compounding of institutional context when the actor is an agent, not a human.

Put another way: purpl_brain is GraphRAG over your team's decision history —
so your agents start every session with the same institutional context your
senior engineer carries, without the senior engineer having to brief them.

**Who these scenarios are written for:** Teams already running AI agents regularly.
Not teams considering agents. Teams who have already felt the context reconstruction
pain — who have already started writing more structured session briefs, already
discovered that informal decisions break agent continuity, already paying the agent
adoption tax. These teams are halfway to the behavior purpl_brain needs. They just
don't have the infrastructure to make it compound.

---

## Scenario 1: The Cost That Compounds

### Context

Fieldwire Labs. 8 engineers. Running Claude Code and Cursor across most feature
work for the past 3 months. Strong process: ADRs for major decisions, PR
descriptions that explain reasoning, integration test suite, senior review on
every PR.

They have not noticed a problem yet. But something is quietly expensive.

---

### A Tuesday — three agent sessions, same codebase

**9:00 AM — Sam starts a session on the notification feature**

Sam opens Claude Code. Before writing code he needs context: what decisions have
been made about the notification pipeline, Redis usage limits, the socket
transport layer. He knows these decisions exist somewhere — in ADR-007, in a PR
description from last month, in his own session log from two weeks ago.

He spends 18 minutes assembling the context. He opens ADR-007, reads it. Opens
PR #441, reads the description. Searches Slack for "redis connection" to find the
pool cap decision. Finds it after three searches. Pastes the relevant sections
into his session prompt. Starts coding at 9:23 AM.

**1:00 PM — Priya starts a session on the billing module**

Same process. Billing has its own history: a PRD, two ADRs, three relevant PR
descriptions, a Slack thread about seat counting semantics. Priya knows these
exist. She spends 22 minutes finding and assembling them. Some she finds quickly.
The Slack thread takes three searches and two wrong threads before she finds the
right one. She starts coding at 1:27 PM.

**4:00 PM — Darius starts a session on the frontend settings page**

Darius is newer. He knows there are constraints around plan-based feature
rendering but is less sure where they're documented. He spends 31 minutes — opens
four docs, reads through two that turn out to be outdated, finds the right ADR,
skims three PR descriptions. He starts coding at 4:37 PM.

---

### The hidden cost, made visible

Three sessions. 18 + 22 + 31 = **71 minutes of engineering time spent on context
assembly before a line of code was written.**

This is not wasted time in the traditional sense — the engineers needed that
context to do their work correctly, and some of it was genuine thinking time: forming
a mental model, deciding what was relevant, identifying what to ask next. But it is
time paid at full engineering cost, recurring every session, scaling linearly with
agent adoption, never amortised.

A human engineer who spent 71 minutes assembling context on Tuesday carries that
context through Wednesday, Thursday, next week. They paid once.

An agent session that starts Thursday carries nothing from Tuesday. The 71 minutes
is paid again. Every session. Permanently.

In this example — 3 sessions per day, 5 days per week, 8 engineers — that works out
to roughly 240 context assembly cycles per week. At an average of 24 minutes each:
**96 engineering-hours per week spent on context that could be a query.** Your team's
number will differ; the structure of the cost does not.

---

### The same Tuesday with purpl_brain

**9:00 AM — Sam's session start**

Claude Code fires the session-start hook:

```
brain_query(
  query: "What are the most recent decisions about the notification pipeline,
          Redis usage, and socket transport configuration?",
  project_id: "fieldwire_api"
)
```

**Brain returns in 6 seconds:**

```
1. Redis Streams chosen over pub/sub for notification event queue (ADR-007,
   PR #441, 3 weeks ago). Key: notifications:events:{project_id}. Consumer
   group: notification-gateway. At-least-once delivery via consumer groups.

2. Redis connection pool capped at 20 connections per service instance — any
   new Redis consumer must share the existing pool, not open a new connection
   (ADR-003, 8 months ago, PR #218).

3. Socket.io transport: websocket-only (not polling+websocket). Polling-first
   adds ~1-2s handshake latency that conflicts with PRD p95 < 3s delivery
   target (PR #443, 2 weeks ago, resolved from a drift alert).

[3 citations — all clickable to source]
```

Sam starts coding at 9:07 AM. He did not open ADR-007. He did not search Slack.
He did not read PR #218. All three constraints — including ADR-003 which he had
half-forgotten — arrived together, connected, cited, in one response.

**1:00 PM and 4:00 PM — same pattern for Priya and Darius**

Each session-start query takes under 10 seconds. The context returned is not a
summary — it is the specific decisions with rationale, the alternatives considered,
and the citations to verify. Darius's query surfaces the plan-based rendering
constraint he was unsure about without him knowing to look for it.

---

### What this is not claiming

This scenario does not claim the brain prevented a bug. Sam, Priya, and Darius
are good engineers — they would have found the constraints eventually. The claim
is narrower and more honest:

**The brain reduced 71 minutes of recurring context assembly to 3 queries totalling
under 30 seconds.** The quality of the context is higher (graph-linked, causally
connected, complete) and the agent operating on it is less likely to miss a
constraint that didn't make it into the manual briefing.

The value scales with agent adoption. The more sessions per day, the larger the
recurring cost the brain eliminates.

---

### Why RAG over docs doesn't fully solve this

The team already has their docs in Notion with search. A reasonable question:
why not just vectorise the docs and query that?

The brain uses GraphRAG — retrieval backed by a knowledge graph — not flat
vector search. The distinction matters in practice:

**Coverage:** Standard RAG retrieves semantically similar chunks. The connection
between ADR-003 (Redis connection pool) and ADR-007 (notification pipeline) is
causal, not semantic — they don't use similar vocabulary. A flat RAG query about
"notification pipeline" scores ADR-007 highly and ADR-003 poorly. GraphRAG
returns both because they are linked as graph nodes, traversable by relationship
regardless of vocabulary.

**Gap awareness:** An agent working from RAG results doesn't know what wasn't
retrieved. The brain's response is bounded and citable — the agent knows exactly
what it has, which surfaces what's missing.

**Recency without re-indexing:** The brain updates continuously from webhooks and
session logs. A RAG index over Notion requires re-indexing after every doc update.
The agent session log from yesterday is in the brain tonight. It may not be in
the RAG index until someone remembers to re-run the pipeline.

---

## Scenario 2: Two Correct Things, One Wrong Combination

### Context

Same team. Jordan (PM) has approved a new billing feature. Sam builds the
backend. Darius builds the frontend billing settings page. Both are experienced.
Both write good PR descriptions. Both have their work reviewed.

The problem doesn't exist in either PR. It exists in the space between them.

---

### The setup

**Jordan's PRD (Notion):**

```
Billing seat count definition:
A billable seat = any workspace member who has accepted their invitation.
Invited-but-not-yet-accepted members are not counted.
Billing snapshot: taken at midnight UTC on the 1st of each month.
```

Jordan shares this in `#product-eng`. Both Sam and Darius read it.

---

### Sam's session — billing backend

Sam's session-start query returns no prior decisions on seat counting (first time
this is being built). He implements correctly per the PRD:

```typescript
// Snapshot-based seat counter — runs at midnight on the 1st via cron
async function getBillableSeatCount(workspaceId: string): Promise<number> {
  return db('members')
    .where({ workspace_id: workspaceId, status: 'active' })
    .count('id as count')
    .then(r => Number(r[0].count));
}
```

At session end, Claude Code logs:

```
decision: "Billable seat = member row with status 'active'. Seat count is
           a point-in-time snapshot run by cron at midnight UTC on the 1st.
           There is no real-time trigger — count does not update when a member
           accepts an invitation."
rationale: "Matches PRD exactly. Snapshot approach chosen over event-trigger
            for billing stability — avoids mid-cycle count fluctuations."
confidence: high
```

PR #201 opens. Sam's reviewer reads the implementation. It is correct. Merged.

---

### Darius's session — billing settings UI

Two days later, Darius's session-start query returns Sam's decision:

```
Billable seat = member with status 'active'. Point-in-time snapshot at midnight
on the 1st. No real-time trigger on invitation acceptance.
[Source: sam-billing-seat-counter session, 2 days ago]
```

Darius reads this. He knows the seat definition. He builds the settings page,
including a list of pending invitations with a note explaining their billing
impact. He writes the copy:

```
These 3 people have been invited but haven't accepted yet.
They are not counted in your current seat total.
Adding them will increase your bill by $36/month.
```

This copy is factually correct per the PRD. Accepted members are billable.
Three members at $12/seat = $36. Darius submits PR #203.

---

### The problem neither PR contains

Darius's UI copy says "adding them will increase your bill" — present tense,
implying immediacy. Sam's implementation runs a snapshot on the 1st. If a member
accepts on January 15th, they do not appear in the February 1st bill. They appear
in the March 1st bill.

From the customer's perspective: they see the UI say their bill will increase,
they accept an invitation, the February bill is unchanged. In March the bill
jumps unexpectedly. Support call: "When did you add this person? Why didn't you
tell us?"

No test catches this. Sam's tests verify the seat counter. Darius's tests verify
the UI renders the pending members and the correct dollar amount. Both pass.
Sam's reviewer reads a correct backend implementation. Darius's reviewer reads
correct UI copy — the math is right, the definition is right.

The gap is a billing timing assumption that neither engineer was wrong about
individually, but that resolves into a customer-visible problem when both pieces
run in production together.

---

### How purpl_brain surfaces it

When Darius's session is ingested, the assumption drift detector compares his
decision log against Sam's — looking for decisions in different artifacts that
make incompatible assumptions about shared business rules, not configuration or
infrastructure state. Stage C (LLM confirmation):

```
⚠ Assumption drift detected

Sam's decision: "Seat count is a point-in-time snapshot at midnight on the 1st.
No real-time trigger on invitation acceptance."

Darius's session: UI copy states "Adding them will increase your bill" when
referring to pending invited members — implying immediate billing impact.

Reason: The copy is accurate for the seat definition but implies timing the
backend does not support. A member accepting on the 15th will not affect the
current month's bill. The copy will create a billing expectation the system
does not fulfil until the following month.
```

Sam sees the alert. Slack message to Darius and Jordan. Jordan decides: fix the
copy to say "will be included in your next billing cycle." Two-line change. Merged
before either PR is in the release branch.

---

### What the steelman says and what survives

**"A good reviewer would catch this."**

Darius's reviewer reads the copy "Adding them will increase your bill." They
think: is this accurate? Yes — accepted members are billable at $12/seat. They
do not think: does the billing backend run a snapshot or a real-time trigger?
That is not in Darius's diff. It is in Sam's session log from two days ago in
a different repo.

For the reviewer to catch this they would need to:
1. Know Sam's implementation uses a snapshot not a trigger
2. While reading frontend copy in a different repo
3. Connect those two facts and recognise the timing gap

Sam's reviewer read Sam's implementation. Darius's reviewer read Darius's copy.
Neither reviewer saw both. The brain did — because both decisions are nodes in
the same graph.

This is also where graph-structured retrieval outperforms naive RAG: Sam's session
log and Darius's session log live in different artifacts and use different vocabulary
("point-in-time snapshot" vs "will increase your bill"). A semantic similarity search
would not connect them. The graph does, because the relationship between them is
structural, not textual.

**"Wouldn't QA catch this?"**

QA verifies: does a pending member appear in the list? Does the dollar amount
calculate correctly? Does accepting an invitation change the member's status? All
pass. QA does not simulate a billing cycle across calendar months with an
accepted invitation mid-cycle. That test does not exist because the scenario
requires waiting for a real date.

**What genuinely survives:** The class of problem where two correct implementations
make incompatible assumptions about a shared business rule — assumptions that
each look correct in isolation and only conflict at a specific runtime state. No
single PR review or QA pass sees the combination. The brain does.

**Other examples of the same class:**

- **Rate limiting:** Frontend caches API responses per user ID and displays a
  remaining-requests counter assuming rate limits are per-user. Backend enforces
  rate limits per-IP address. Both are internally correct. Behind a corporate
  NAT where 40 users share one IP, one user's burst exhausts the limit for
  the entire office. No single PR contains both the frontend cache key and the
  backend limit key. The conflict only appears under a specific network topology
  that QA never runs behind.

- **Feature flags:** Two agent sessions implement the same feature flag in
  different services in the same day. Sam's session sets the default to `false`
  in the API service (cautious rollout). Darius's session sets it to `true`
  in the background worker (faster rollout for async jobs). Both decisions are
  locally defensible. In production the worker activates the feature by default
  while the API suppresses it — the worker begins processing events the API
  does not surface to users, creating invisible data divergence. Both service
  test suites pass. The drift detector connects the two session logs and flags
  the default-state conflict before either is deployed.

---

## Scenario 3: The Compounding Decision Record

### Context

This scenario is not about a bug or a drift catch. It is about the value of a
decision record with time lineage when the team is mid-way through a large,
multi-sprint feature built primarily through agent sessions.

---

### The feature: multi-tenant permissions overhaul

Six months ago SimpleTeam started a permissions overhaul — moving from a simple
3-role model (Owner, Admin, Member) to a custom role system with granular
permissions. This is a large cross-cutting change. It has touched 14 files, 6
agent sessions, 3 engineers, and generated 2 ADRs, 11 PRs, and a permissions
design doc in Notion.

Today a new constraint surfaces: an enterprise customer requires that certain
permissions can only be granted by the workspace Owner, not by any Admin —
regardless of what custom roles the Admin has been given.

Jordan creates the ticket. Priya picks it up. She is not the engineer who built
the permissions system. She has read the Notion doc. She has not read all 11 PRs
or both ADRs in full.

---

### Without purpl_brain

Priya needs to understand the current state of the permissions model before
touching it. She has:

- The Notion design doc (describes the original intent, partially outdated)
- ADR-015 (covers the decision to use a capability-based model over RBAC)
- ADR-016 (covers the database schema for custom roles)
- 11 PRs with descriptions of varying quality
- 6 agent session logs (not linked to any document — they're in the agent
  runner's output history, partially deleted after session cleanup)

She reads the Notion doc: 20 minutes. She reads both ADRs: 15 minutes. She
reads the 6 most recent PR descriptions: 25 minutes. She cannot find the agent
session logs — they were in a terminal that was closed. Total: 60 minutes, with
gaps she doesn't know about.

She starts building. Midway through she discovers a decision she wasn't aware of:
permission checks are evaluated at request time, not at role-assignment time.
This means "Owner-only permissions" needs to check the actor's workspace role
at the point of the action, not the role stored on their session token. She
would have built it wrong. She catches it by reading the implementation.

She catches it — this time. But the catch came from reading code, not from
understanding the reasoning. She doesn't know if this was a deliberate decision
or an implementation accident. She asks Sam, who was in a meeting. She waits
40 minutes for a reply.

---

### With purpl_brain

Priya's session-start query:

```
brain_query(
  query: "What are the key decisions behind the custom permissions system —
          capability model, evaluation timing, schema choices, and anything
          that would affect adding an owner-only permission constraint?",
  project_id: "simpleteam_api"
)
```

**Brain returns:**

```
The permissions overhaul has the following established decisions:

1. Capability-based model chosen over RBAC (ADR-015, 5 months ago). Rationale:
   RBAC requires predefined role hierarchies — incompatible with the customer
   requirement for fully custom roles. Capabilities are additive and composable.

2. Permission evaluation at request time, not session-token time (agent session:
   sam-permissions-evaluation, 3 months ago). Rationale: role assignments can
   change while a session is active. Evaluating at session-token time would
   allow a demoted admin to retain permissions until their next login. Deliberate
   design decision, not an implementation detail.

3. The permission check pipeline runs: workspace role check → custom role check
   → capability check, in that order. Workspace roles (Owner, Admin, Member)
   are checked first and can short-circuit the custom role evaluation
   (agent session: priya-permissions-pipeline, 6 weeks ago).

4. One unresolved question from sam-permissions-evaluation: "how do we handle
   permissions that should only be grantable by workspace Owners, bypassing
   custom role inheritance?" — marked as deferred pending a concrete customer
   requirement.

[6 citations: ADR-015, ADR-016, 4 agent session logs]
```

Point 2 is the decision Priya would have discovered by reading code 40 minutes
into her session. She has it in 8 seconds, with the rationale — so she knows it
was deliberate.

Point 4 is the previous engineer explicitly flagging that the exact problem
Priya is solving was anticipated and deferred. The session log from 3 months ago
is speaking directly to her feature without anyone knowing it would be relevant.

Priya builds the owner-only permission check correctly on the first attempt.
She does not interrupt Sam.

---

### The time lineage point

The brain does not return a static document. It returns a chronological sequence
of decisions with the reasoning at each step:

```
5 months ago: chose capability model over RBAC
3 months ago: chose request-time evaluation over session-token evaluation
6 weeks ago:  established the pipeline order; noted owner-only question as deferred
Today:        Priya picks up the deferred item
```

No single document contains this lineage. The Notion doc describes the original
design. The ADRs describe the major choices. The agent session logs contain the
micro-decisions and the unresolved items. The brain holds all of them in the same
graph and returns them in causal order when the query is relevant.

A new engineer, a new agent, or Priya on a feature six months from now gets the
same lineage in the same 8-second query. The senior engineer who made these
decisions does not need to be in the room.

---

### What the steelman says and what survives

**"A good wiki or Notion setup with linked documents achieves this."**

Partially. A well-maintained Notion with linked ADRs and decision logs can
approximate the lineage. The difference:

- Notion requires someone to maintain the links as decisions are made. The brain
  builds links automatically from ingested sources.
- Agent session logs are not Notion docs. They're structured outputs from a
  session runner. Getting them into Notion requires a manual step nobody takes.
- The "deferred question" from Sam's session log 3 months ago would not be in
  Notion unless Sam specifically wrote it there. It would be in a terminal output
  that no longer exists. The brain ingested it when the session ran.

**What genuinely survives:** The specific value of agent session logs as a
first-class input. These are not documents — they are structured outputs from
automated processes. They do not naturally flow into Notion or ADRs. The brain
is one of very few surfaces that treats them with the same fidelity as human-written
documentation and connects them into the same causal timeline.

---

## What These Scenarios Are Claiming and Not Claiming

### Claiming

1. **The per-session context reconstruction cost for AI agents is real, recurring,
   and scales with agent adoption.** The brain reduces it from minutes to seconds,
   per session, permanently.

2. **Two individually correct implementations can conflict at their intersection**
   in ways that no single PR review, test, or QA pass detects, because each
   verification surface sees one piece at a time. The brain sees both.

3. **Agent session logs contain decisions and unresolved questions that no other
   documentation surface captures.** Without the brain, they are lost at session
   end. With the brain, they become part of the permanent decision record with
   full lineage.

### Not claiming

- purpl_brain replaces ADRs, PR descriptions, Notion docs, or code review.
  It reads them. It does not replace them.
- purpl_brain catches bugs that tests and reviewers would miss in general.
  The specific class of cross-repo, cross-session behavioral assumption conflict
  is a real but narrow case.
- purpl_brain provides complete institutional memory. Coverage depends on what
  surfaces are connected. Verbal decisions, DMs, and informal choices remain
  invisible. The brain is the best available consolidation of what was recorded
  — not a complete record of everything that happened.

- purpl_brain assumes agents have no session-to-session memory. Many frameworks
  (LangGraph, MemGPT, AutoGen) support agent memory mechanisms of their own.
  The accurate claim is narrower: without a *designed institutional memory system
  shared across all agents and humans on the team*, agents cannot carry your
  team's accumulated decision context between sessions. Framework-local memory
  is per-agent and per-run. The brain is team-scoped and permanent.

### The honest prerequisite

These scenarios assume the team is already running AI agents regularly and already
paying the context reconstruction cost. For teams not yet using agents at scale,
the reconstruction cost argument does not land — because their agents are not
running frequently enough for the per-session cost to accumulate into something
visible.

The right buyer is a team that has already felt the pain these scenarios describe.
Not a team that needs to be convinced the pain exists.
