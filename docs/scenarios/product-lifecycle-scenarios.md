# Purpl Brain — Product Lifecycle Scenarios

**Purpose:** Three realistic walkthroughs of a modern multi-agent software team using purpl_brain across the full SDLC. Each scenario traces real user actions, tool calls, Slack messages, PRs, and agent sessions — with explicit callouts for where purpl_brain creates or saves value.

**Team:** Fieldwire Labs — a 9-person B2B SaaS company building a construction project management platform. Stack: Next.js frontend, Node/Fastify API, PostgreSQL, Redis, deployed on AWS. They have been using Claude Code and Cursor for ~4 months. purpl_brain has been running for 6 weeks, seeded with GitHub history and Slack exports.

**Characters:**
- **Maya** — Engineering Manager / tech lead
- **Sam** — Senior backend engineer
- **Priya** — Senior full-stack engineer (joined 3 weeks ago)
- **Darius** — Frontend engineer
- **Lucas** — Product Manager
- **claude-code** — AI coding agent (Claude Code), used by Sam and Priya
- **cursor-agent** — AI coding agent (Cursor), used by Darius

---

## Scenario 1: The Parallel Agents That Almost Shipped a Contradiction

**Context:** Lucas has approved a new feature: real-time notifications for task assignment changes. The team decides to parallelize — Sam handles the backend event pipeline, Darius handles the frontend WebSocket subscription layer. Both start the same morning.

---

### Day 1, 9:02 AM — Lucas writes the PRD

Lucas creates a new Notion page: **PRD: Real-time Task Notifications (v1)**

```
Problem: Users miss task assignments because email notifications arrive 10–40 min late.
Goal: Surface task assignments in-app within 2 seconds of the triggering event.

Requirements:
- Notify assignee when a task is assigned or reassigned
- Notify watchers when a task status changes
- Work across browser tabs (tab in background must receive)
- Graceful degradation if WebSocket disconnects (fall back to polling at 30s)

Out of scope for v1: push notifications, mobile

Success metric: p95 notification delivery < 3s measured from DB write to client receipt
```

He pastes the Notion link into `#product-eng`:

> **Lucas** [9:04 AM]  
> PRD for real-time notifications is up. Tagging this for the sprint. @Maya @Sam @Darius — let's get architecture sorted before we split the work

---

### Day 1, 9:31 AM — Architecture discussion in Slack

> **Maya** [9:31 AM]  
> For the event pipeline I'm thinking Redis pub/sub → WebSocket gateway. We already have Redis in the stack. @Sam thoughts?

> **Sam** [9:44 AM]  
> +1 on Redis. We should avoid adding SQS for something this scoped. One concern: Redis pub/sub doesn't persist — if the gateway restarts mid-push, messages in flight are lost. Could we use Redis Streams instead? Gives us consumer groups + at-least-once delivery

> **Maya** [9:51 AM]  
> Good catch. Redis Streams it is. @Darius the frontend will subscribe via WebSocket — gate on the `/notifications/subscribe` endpoint Sam will expose. Does that work with our existing socket infra?

> **Darius** [9:58 AM]  
> Yes, we use socket.io already. I'll add a `notifications` namespace. One thing: socket.io has its own internal pub/sub adapter — if we want multi-instance support later we'd configure it to use Redis adapter. Should I wire that up now or defer?

> **Sam** [10:03 AM]  
> Defer. Single-instance is fine for v1. Put it in the ADR as a known limitation

---

### Day 1, 10:22 AM — Sam writes ADR-007

Sam creates `docs/adrs/007-notification-event-pipeline.md`:

```markdown
# ADR-007: Notification Event Pipeline

**Status:** Accepted  
**Date:** 2026-05-25  
**Deciders:** Maya, Sam, Darius

## Decision
Use Redis Streams (not pub/sub) as the notification event queue.
WebSocket delivery via socket.io on a dedicated `notifications` namespace.

## Rationale
Redis is already in the stack. Streams provide at-least-once delivery semantics
via consumer groups — plain pub/sub would drop in-flight events on gateway restart.
socket.io multi-instance Redis adapter deferred to post-v1 (single-instance acceptable
at current scale of ~200 concurrent users).

## Alternatives considered
- SQS + SNS: operational overhead not justified; adds ~150ms latency vs in-process Redis
- Native WebSocket (no socket.io): would require reimplementing reconnect logic
  already in socket.io client

## Consequences
- Redis Streams key: `notifications:events` — all services write here
- Consumer group: `notification-gateway`
- Gateway reads stream, fans out to connected sockets
```

Sam opens PR #441 for the ADR, Maya approves and merges.

---

### Day 1, 10:35 AM — purpl_brain ingests the ADR

The GitHub webhook fires on PR merge. The brain's normalizer processes the PR, the entity extractor identifies the decision node:

```
Decision extracted:
  summary: "Use Redis Streams as notification event queue; defer socket.io 
            multi-instance Redis adapter to post-v1"
  rationale: "At-least-once delivery via consumer groups; Redis already in stack; 
              single-instance acceptable at ~200 concurrent users"
  alternatives_considered: ["SQS + SNS", "native WebSocket"]
  confidence: high
  source: github / PR #441
```

The brain also ingests the Slack thread from `#product-eng` (via Slack webhook), linking the discussion to the same decision cluster.

---

### Day 1, 11:00 AM — Sam starts his agent session

Sam opens Claude Code on `fieldwire-api`. Before writing any code, Claude Code fires the session-start hook:

```
brain_query(
  query: "What are the most recent decisions about notifications, 
          Redis, and WebSocket architecture?",
  project_id: "fieldwire_api",
  mode: "project"
)
```

**Brain returns:**

```
The team decided today (ADR-007, PR #441) to use Redis Streams — not pub/sub — 
for the notification event pipeline. Key: `notifications:events`, consumer group: 
`notification-gateway`. socket.io multi-instance adapter explicitly deferred to post-v1.
[Source: github/PR #441, 37 min ago]

Prior related decision (ADR-003, 8 months ago): Redis connection pool capped at 20 
connections per service instance. Any new Redis consumer must share the pool — 
do not open a second connection. [Source: github/PR #218]
```

Sam reads both citations. The ADR-003 constraint is one he'd forgotten — it means the stream consumer must use the existing `redisClient` singleton, not instantiate its own.

**Sam's session — key file changes:**

```
src/services/notification-stream-writer.ts    — writes events to notifications:events
src/workers/notification-gateway.ts           — Redis Streams consumer group, fans out
src/routes/notifications.ts                   — /notifications/subscribe endpoint
```

At session end, Claude Code fires the stop hook:

```
brain_log_decision(
  session_id: "sam-2026-05-25-notifications-backend",
  project_id: "fieldwire_api",
  work_completed: "Built notification event pipeline: Redis Streams writer, 
                   gateway consumer, WebSocket subscribe endpoint",
  decisions: [
    {
      id: "stream-key-schema",
      description: "Notification stream key format: notifications:events:{project_id} 
                    (per-project partitioning, not a single global stream)",
      rationale: "Global stream would require all consumers to filter by project_id 
                  on every message — per-project key lets the gateway subscribe only 
                  to relevant streams, reducing CPU on high-volume projects",
      alternatives_considered: ["single global stream", "stream per notification type"],
      confidence: "high"
    },
    {
      id: "ack-on-delivery",
      description: "Stream messages ACKed only after socket.io emit callback confirms 
                    delivery to at least one connected socket; unacked messages 
                    redelivered after 30s",
      rationale: "Matches PRD p95 < 3s requirement; 30s redelivery window chosen as 
                  conservative floor above the 10s socket.io reconnect timeout",
      alternatives_considered: ["ACK immediately on read", "no ACK (fire-and-forget)"],
      confidence: "high"
    }
  ]
)
```

---

### Day 1, 11:00 AM — Darius starts his Cursor session (simultaneously)

Darius opens Cursor on `fieldwire-web`. Cursor fires the session-start MCP call:

```
brain_query(
  query: "WebSocket notifications frontend architecture — what has been decided?",
  project_id: "fieldwire_web",
  mode: "project"
)
```

**Brain returns:**

```
ADR-007 (merged 1h ago): WebSocket delivery via socket.io on a notifications namespace.
socket.io multi-instance Redis adapter deferred to post-v1. Backend endpoint: 
/notifications/subscribe. [Source: github/PR #441]
```

Darius reads this. His session proceeds.

**Darius's key change:** He needs the frontend socket.io client to connect to the notifications namespace. He implements `src/hooks/useNotifications.ts`.

However, while writing the socket reconnection logic, Cursor suggests a pattern Darius accepts without reading closely:

```typescript
// Cursor autocomplete — Darius accepts
const socket = io('/notifications', {
  transports: ['polling', 'websocket'],  // polling first, then upgrade
  ...
});
```

Polling-first means the client opens an HTTP long-poll before upgrading to WebSocket. This is the socket.io default, and Cursor suggested it because it's common. Darius doesn't notice it conflicts with the PRD requirement for < 3s delivery — HTTP polling introduces ~500ms extra latency during the upgrade handshake.

At Darius's session end, Cursor logs:

```
brain_log_decision(
  session_id: "darius-2026-05-25-notifications-frontend",
  project_id: "fieldwire_web",
  work_completed: "Built useNotifications hook, NotificationToast component, 
                   socket.io connection to /notifications namespace",
  decisions: [
    {
      id: "socket-transport-order",
      description: "socket.io client configured with transports: ['polling', 'websocket'] 
                    — polling first, upgrade to WebSocket after handshake",
      rationale: "socket.io default; ensures connection in restrictive network environments 
                  (corporate proxies that block WebSocket upgrade)",
      alternatives_considered: ["websocket-only transport"],
      confidence: "medium"
    }
  ]
)
```

---

### Day 1, 3:15 PM — purpl_brain detects a drift

The brain's drift detector runs after both sessions are ingested. Stage A (semantic similarity) finds the Darius session decision about `polling first` against the existing constraint from Sam's session (`ACK only after socket.io emit callback confirms delivery`).

Stage C (LLM confirmation) runs:

```
Existing decision: "ACKed only after socket.io emit callback confirms delivery to 
                    at least one connected socket" — assumes WebSocket is the 
                    active transport when ACK fires.

New signal: "transports: ['polling', 'websocket']" — during the initial polling 
             phase, socket.io emit callbacks fire over HTTP long-poll, not WebSocket.
             The p95 latency target (< 3s) may not be met during the upgrade handshake
             window, which can take 1–2 additional seconds under load.

Contradiction confirmed: medium severity.
```

A `DriftAlert` node is created. Sam receives it in the purpl_brain web UI under the project's **Drift** tab:

```
⚠ Drift detected
Decision: "ACK on socket delivery assumes WebSocket transport"
Challenged by: darius-2026-05-25-notifications-frontend
Reason: Frontend configured polling-first transport — ACK latency during 
        upgrade window may exceed the PRD p95 < 3s target.
```

---

### Day 1, 3:40 PM — Sam and Darius resolve it in Slack

> **Sam** [3:40 PM]  
> @Darius — heads up, brain flagged a possible issue. Your socket transport config has polling first. Our ACK logic on the backend assumes we're on WebSocket when the callback fires. The polling upgrade adds ~1-2s which might bust the PRD target. Can you check?

> **Darius** [3:48 PM]  
> Oh that was just the Cursor default. I didn't think about it. What do we lose by going websocket-only?

> **Sam** [3:52 PM]  
> Corporate proxies that block WS upgrades. Probably <1% of our users (construction sites mostly use mobile hotspots). I'd say websocket-only is fine for v1, note it in the ADR

> **Darius** [3:55 PM]  
> Done — switching to `transports: ['websocket']` and will add a note

Darius submits PR #443, updates the socket config. In the PR description he writes:

```
Changed transport order to websocket-only (not polling+upgrade).
Context: brain flagged latency conflict with backend ACK logic — polling handshake 
adds ~1-2s that would bust the PRD p95 < 3s target. Corporate proxy edge case 
acknowledged and deferred (< 1% of user base, tracked in ADR-007).
```

Sam reviews and approves in 8 minutes.

---

### What purpl_brain actually did — and honest limits

**A fair question:** A good code reviewer might have caught this. Sam wrote the backend ACK logic — if Sam reviewed Darius's PR, he might have noticed the transport config and connected the dots.

That is true. Here is what PR review actually looks like in this case:

Darius's PR diff in `fieldwire-web` shows:

```diff
+const socket = io('/notifications', {
+  transports: ['polling', 'websocket'],
+  ...
+});
```

This is the socket.io documented default, present in every socket.io getting-started guide. A reviewer who is:
- not the author of the backend ACK timing logic, **or**
- not deeply familiar with socket.io transport upgrade latency, **or**
- reviewing this at the end of a day with 4 other PRs queued

…would pass it without comment. It looks correct because it is the default.

For Sam to catch it in review, three pieces of context must be simultaneously active in his head:
1. The PRD's p95 < 3s delivery requirement
2. That his own ACK callback fires *after* the transport layer delivers the frame
3. That the polling-to-WebSocket upgrade adds ~1–2s handshake time

Sam wrote decision #2 that morning. Reviewers don't typically re-read their own session logs before reviewing adjacent PRs. The transport choice is in a different repo (`fieldwire-web`) from the ACK logic (`fieldwire-api`), so there is no diff context linking them.

**The honest value of the brain here is not "prevented a merge." It is:**

1. **The catch is deterministic, not reviewer-dependent.** Whether Sam is the reviewer, on PTO, or reviewing 6 other PRs, the drift detector runs within minutes of both sessions being ingested. It does not rely on the right person noticing the right thing at the right time.

2. **The catch happened before either PR was opened** — at 3:15 PM, before Darius had even submitted his PR for review. Sam was already heads-down on something else. The brain routed the signal to him with a one-sentence explanation; he sent a Slack message in 25 minutes. Without it, the conversation would have happened during PR review at best, or not at all.

3. **Cross-repo visibility.** Code review tools show diffs within a single repo. The connection between `transports: ['polling', 'websocket']` in `fieldwire-web` and `ACKed only after socket.io emit callback confirms delivery` in `fieldwire-api` spans two repos and two agent sessions. No review tool surfaces this; the brain does because both decisions are in the same graph.

4. **The ADR-003 catch has no review equivalent.** Sam's own session start query surfaced a connection pool cap from 8 months ago that Sam himself had forgotten. No PR review would have caught a constraint violation that had not been written yet — this is pre-implementation context, not a code diff.

**Realistic worst-case without the brain:** Sam reviews Darius's PR, is not in a socket.io-expert headspace that day, approves. The WebSocket notification feature ships. Under the first enterprise customer load (office of 300 users all logging in at 8 AM), notifications are delayed by 2–4 seconds consistently — just above the PRD target but not alerting-level. It surfaces as a customer complaint 2 weeks later. Debugging requires correlating frontend socket timing with backend ACK logs across two repos. ~3 hours to isolate, ~1 hour to fix, one customer-visible regression.

**Brain touchpoints in this scenario:**
1. `brain_query` at Sam's session start → surfaced a forgotten Redis connection pool constraint (ADR-003) before any code was written
2. `brain_log_decision` at Sam's session end → logged ACK semantics with enough specificity for drift detection
3. `brain_log_decision` at Darius's session end → logged transport decision (cross-repo)
4. Drift detector → connected the two decisions across repos and sessions within 3 minutes
5. Web UI drift alert → routed to Sam with a one-sentence LLM explanation, no manual searching required

---
---

## Scenario 2: The Decision That Was Made in a Slack Thread Nobody Could Find

**Context:** Six months ago, the team evaluated authentication libraries and chose Passport.js. Part of that decision — recorded only in a Slack thread that has since been archived — was that Passport.js's SAML strategy had a known memory leak in high-concurrency scenarios and should not be used for SSO until the upstream patch landed. That patch never landed. The team forgot about it.

Now Lucas has a new enterprise customer who requires SAML SSO as a contract condition. It's on the sprint. Priya has been at the company for 3 weeks. She's never heard of the Passport SAML issue.

---

### Week 1, Monday 9:20 AM — Linear ticket created

Lucas creates in Linear:

```
Title: FEAT-1192: SAML SSO for Enterprise Tier
Description:
  Enterprise customer (Acme Corp) requires SAML SSO with their Okta IdP as a 
  contractual requirement for their $180k ARR deal. Must be live by June 30.
  
  Acceptance criteria:
  - SP-initiated SSO flow works with Okta
  - Attribute mapping: email, first_name, last_name, role
  - Existing session handling unchanged for non-SSO users
  
  Suggested approach: Passport.js SAML strategy — we already use Passport for 
  local auth + Google OAuth
```

Lucas assigns it to Priya and pings her in `#product-eng`:

> **Lucas** [9:22 AM]  
> @Priya FEAT-1192 is yours. Should be straightforward — extend the existing Passport setup with the SAML strategy. Let me know if you hit anything unexpected

---

### Monday 10:05 AM — Priya runs brain_analyze_impact before starting

Priya has been using purpl_brain for two weeks and has learned to run an impact check before touching auth. She opens Claude Code:

```
brain_analyze_impact(
  change_description: "Add SAML SSO support using passport-saml strategy. 
                       Integrating with existing Passport.js auth middleware 
                       on the Node/Fastify API.",
  project_id: "fieldwire_api"
)
```

**Brain returns:**

```
## Impact Analysis — HIGH risk

### Affected decisions (3)

**Do not use passport-saml in production — memory leak in high-concurrency 
  scenarios; upstream fix not merged as of ADR-004 decision date** [confirmed]
  Risk: HIGH
  
  Source: Slack #engineering thread [2025-11-14], decision captured by 
  brain_log_signal 2025-11-14 from Sam. ADR-004 notes: "Passport SAML strategy 
  evaluated and rejected pending resolution of 
  github.com/node-saml/passport-saml/issues/931. Revisit when issue closes."
  
  Status of upstream issue: UNKNOWN — brain does not have current GitHub data 
  for the upstream repo. Recommend checking manually.

**Auth middleware: all new auth strategies must share the existing session store 
  (Redis, TTL 24h)** [confirmed]
  Risk: medium

**Passport.js version pinned at 0.6.0 — do not upgrade; breaks Google OAuth 
  callback URL handling (PROJ-887 regression)** [confirmed]
  Risk: medium
```

Priya reads this and stops. She checks the upstream issue directly:

```
github.com/node-saml/passport-saml/issues/931
Status: OPEN. Last comment 3 weeks ago. No fix merged.
```

She messages Sam:

> **Priya** [10:18 AM]  
> @Sam — running the SAML SSO ticket. Brain flagged a memory leak in passport-saml that was a known blocker from November. Issue is still open upstream. Is this still our position or has something changed?

> **Sam** [10:26 AM]  
> Yeah that's still real. I forgot we had that logged. Good catch. The issue is the SAML XML parser doesn't release buffer references under concurrent assertion processing — it's subtle and only shows up under load but we had a test environment crash at ~50 req/s. You'll want to look at node-saml directly (the underlying library passport-saml wraps) or auth0's samlify instead. samlify doesn't have that issue.

> **Priya** [10:31 AM]  
> So the recommendation is: drop passport-saml, use samlify for the SAML parsing layer, keep Passport for session management?

> **Sam** [10:35 AM]  
> Exactly. You'll need to write a custom Passport strategy that uses samlify under the hood instead of passport-saml. More work but correct. Probably 2–3 days vs the 4-hour estimate Lucas had in mind.

---

### Monday 10:45 AM — Priya updates the Linear ticket and writes an ADR

Priya updates FEAT-1192:

```
Updated estimate: 3 days (not 4 hours)
Reason: passport-saml strategy blocked by unresolved memory leak (upstream issue #931). 
        Using samlify as SAML parsing layer instead — requires custom Passport strategy wrapper.
```

She creates `docs/adrs/012-saml-sso-implementation.md`:

```markdown
# ADR-012: SAML SSO Implementation Approach

**Status:** Accepted  
**Date:** 2026-05-25  
**Deciders:** Priya, Sam

## Context
FEAT-1192 requires SAML SSO. passport-saml is the obvious choice given our 
existing Passport.js setup but is blocked by a confirmed memory leak under 
concurrent load (node-saml/passport-saml#931, open as of 2026-05-25).

## Decision
Use **samlify** for SAML assertion parsing. Wrap it in a custom Passport strategy 
class (`SamlifyStrategy`) that conforms to the Passport interface. Session 
management remains in Passport with the existing Redis session store.

## Alternatives considered
- passport-saml: rejected — memory leak under concurrent load (see ADR-004 history)
- auth0-samlp: server-side only, no SP-initiated flow support
- Full migration away from Passport: out of scope; would affect Google OAuth and 
  local auth — breaking change requiring coordinated migration

## Consequences
- samlify adds 1 new dependency; no transitive conflicts verified
- Custom strategy requires maintaining the Passport strategy interface across 
  Passport version upgrades — document in runbook
```

---

### Wednesday — Priya's two agent sessions

**Session 1 (Tuesday):** Priya builds the `SamlifyStrategy` class and the `/auth/saml/callback` route. Claude Code queries the brain at start, gets back ADR-004, ADR-012, and the session store constraint. Logs decisions at end.

**Session 2 (Wednesday):** Priya builds the SP metadata endpoint (`/auth/saml/metadata`) and the test harness against a local Okta simulator. Claude Code queries the brain at start — this time it pulls in Priya's own decisions from Session 1 (`agent-resume` mode surfaces them automatically):

```
brain_query(
  query: "What did the previous session decide about the SamlifyStrategy 
          implementation and the callback route?",
  project_id: "fieldwire_api",
  mode: "agent-resume"
)
```

**Brain returns:**

```
Session darius-priya-2026-05-27-saml-sso (yesterday):
  - SamlifyStrategy validates assertions against a cached IdP metadata XML 
    (refreshed every 6h via a background job, not per-request)
  - Callback route at /auth/saml/callback — POST only; GET returns 405 
    (Okta sends POST, some IdPs send GET — documented as known limitation)
  - Attribute mapping: email from NameID, first_name/last_name from Attributes array
  
  Unresolved from previous session:
  - Clock skew tolerance: samlify default is 5 minutes; Okta documentation 
    recommends 3 minutes — which to use?
```

Priya sees the unresolved item and resolves it before writing any new code: she checks Okta's SAML profile requirements and sets `clockSkew: 180` (3 minutes).

---

### Thursday — PR #451 and code review

Priya opens PR #451: "FEAT-1192: SAML SSO via samlify + custom Passport strategy"

```
## Summary
Implements SAML SP-initiated SSO using samlify (not passport-saml — blocked by 
upstream memory leak, see ADR-012 and ADR-004).

## Key decisions made in this PR
- Clock skew: 180s (Okta recommended), not samlify default of 300s
- IdP metadata cached 6h background refresh — not per-request (avoids latency spike on assertion validation)
- /auth/saml/callback POST only (Okta sends POST; GET 405 documented)

## Testing
- Local Okta simulator: SP-initiated flow, attribute mapping, session creation ✓
- Load test at 60 req/s for 5 min: no memory growth (confirms samlify fix)

## Brain sessions
- Session 1: priya-2026-05-27-saml-sso (strategy + callback)  
- Session 2: priya-2026-05-28-saml-metadata (metadata endpoint + tests)
```

Sam reviews and leaves one comment:

> **Sam** [PR #451, comment]  
> The 6h IdP metadata cache TTL — is there a manual refresh endpoint? If the customer rotates their Okta signing cert, we need ops to be able to invalidate without a deploy.

Priya adds `POST /auth/saml/metadata/refresh` (API-key protected), addresses the comment, Sam approves, PR merges.

---

### What purpl_brain prevented

Without the brain: Priya builds SAML SSO on passport-saml, same as Lucas suggested. The implementation works in development. It ships. Under the first week of real enterprise traffic (Acme Corp has ~300 users who all log in at 8 AM), the Node process memory climbs steadily and the server OOMs after ~4 hours. Incident, rollback, emergency re-implementation. Estimated cost: 2 days engineering time + a customer escalation on their second week of using the product.

**Brain touchpoints:**
1. `brain_analyze_impact` before writing a line of code → surfaced a 6-month-old blocker recorded in a Slack thread nobody would have found
2. `brain_query` at Session 2 start with `agent-resume` mode → surfaced an unresolved item from Session 1, preventing a silent wrong default (clock skew)
3. ADR-012 written and ingested → next engineer who touches SAML will get the full decision context in < 5 seconds

---
---

## Scenario 3: Three Weeks, Four Agents, One Codebase — The Onboarding Problem

**Context:** Priya joined Fieldwire Labs three weeks ago. The codebase is two years old with ~140k lines of code. The team has been using AI agents for 4 months and has logged 67 agent sessions. This scenario shows a full three-week sprint from Priya's perspective — how she uses purpl_brain to onboard without burning her colleagues' time, and what happens when the 4th agent session (run by someone else) contradicts a decision she made in week 1.

---

### Week 1, Day 1 — Priya's onboarding query session

Priya has been given read access to purpl_brain. Her first action is not to open the codebase — it's to open the web UI and ask the brain questions.

**Query 1:**

> "What is the overall architecture and what are the most important decisions that shape how the backend is structured?"

```
Answer: The API is a Fastify monolith (not microservices — rejected in ADR-001, 
Dec 2024, due to team size). Database is PostgreSQL with a single connection pool 
via pg-pool capped at 25 connections. Redis is used for session storage, 
rate-limiting, and (as of 3 weeks ago) notification event streaming via Redis Streams.

Most consequential recent decisions:
1. All DB queries go through a repository layer — direct Knex in route handlers was 
   banned after a P1 incident (PROJ-714) where a missing .trx() call caused a 
   partial write (Feb 2025, ADR-005)
2. Authentication via Passport.js — Google OAuth + local. SAML added last week (ADR-012)
3. Multi-tenancy: every DB query must include project_id in the WHERE clause — 
   no exceptions. RLS not used (performance regression at scale, ADR-008)

[8 citations: ADRs 001, 005, 008, 012; GitHub PRs #87, #218, #309, #451]
```

**Query 2:**

> "Why don't we use an ORM? I noticed only raw Knex queries in the codebase."

```
Answer: The team evaluated Prisma and TypeORM in Sept 2024 (Slack #engineering, 
thread from Sep 12). Decision: use Knex (query builder) not a full ORM. Rationale: 
Prisma's migration system conflicts with the existing Flyway-based DB migration 
workflow already in CI/CD. TypeORM evaluated and found to produce N+1 queries 
silently in the task list endpoint (load tested at 500 tasks — query count 
reached 2,800). Sam's comment: "we'd spend more time fighting the ORM than 
writing SQL."

The repository pattern (ADR-005) provides the abstraction layer without the ORM overhead.

[3 citations: Slack thread Sep 12 2025, Sam; PR #309 description; ADR-005]
```

Priya spends 2 hours querying the brain. She covers: testing philosophy, error handling patterns, rate limiting, deployment process, and the team's approach to feature flags. She estimates this saves her ~3 days of "why does this code do X" questions to Sam and Maya.

---

### Week 1, Day 3 — Priya's first ticket: FEAT-1198 (Bulk task assignment)

Linear ticket assigned. Priya runs Claude Code.

**Session start brain query:**

```
brain_query(
  query: "What decisions affect bulk operations, the task assignment flow, 
          and database write patterns?",
  project_id: "fieldwire_api"
)
```

**Brain returns:**

```
1. Bulk writes must use Knex .batchInsert() with a chunk size of 500 rows — 
   larger chunks cause PostgreSQL lock contention on the tasks table at scale 
   (ADR-010, confirmed by load test in March 2026)

2. Task assignment triggers a notification event (Redis Stream: 
   notifications:events:{project_id}) — bulk assignment must write one event 
   per assignee, not one per bulk operation, so notification consumers receive 
   individual assignee events [Session: sam-2026-05-25-notifications-backend]

3. All task writes must go through TaskRepository.bulkAssign() if that method 
   exists — check before adding a new path (ADR-005 repository pattern rule)

[Citations: ADR-005, ADR-010, Sam's session log 2026-05-25]
```

Point 2 is critical — without it, Priya would have written one notification event for the whole bulk operation, meaning the notification gateway would fire one toast for "You were assigned to 47 tasks" instead of 47 individual events. That's both a UI problem and a data model problem.

**Priya's session decisions logged:**

```
decisions: [
  {
    id: "bulk-assign-transaction-scope",
    description: "Bulk assignment wraps ALL rows in a single DB transaction — 
                  partial success not allowed. If any row fails, entire batch rolled back.",
    rationale: "PRD requires atomic bulk assignment. Partial success creates 
                inconsistent state visible to end users (some teammates assigned, 
                some not) with no recovery path from the UI.",
    alternatives_considered: ["per-row transactions with partial success reporting"],
    confidence: "high"
  },
  {
    id: "notification-event-per-assignee",
    description: "Bulk assignment emits one notification event per unique assignee, 
                  not one event for the batch",
    rationale: "Per brain context from sam-2026-05-25 session: notification consumers 
                expect per-assignee events. Batch event would break the notification 
                gateway fan-out logic.",
    confidence: "high"
  }
]
```

PR #455 opens. Sam reviews. Merges Day 4.

---

### Week 2 — Three more agent sessions touch adjacent code

**Sam's session (Week 2, Tuesday):** Sam is building a bulk export feature. He runs Claude Code. The brain surfaces Priya's `bulk-assign-transaction-scope` decision. Sam models his export transaction scope the same way — no re-derivation.

**Darius's session (Week 2, Wednesday):** Darius adds a new notification type (comment mentions). He queries the brain, gets Sam's original notification stream decisions AND Priya's `notification-event-per-assignee` decision. He models comment mention notifications the same way: one event per mentioned user. Consistent with no discussion needed.

**External contractor agent session (Week 2, Friday):** The team hires a contractor (Reno) for a one-week sprint to build a CSV import feature. Reno uses Cursor. His session queries the brain, gets the `batchInsert chunk size 500` constraint and the repository pattern rule. He does not need to read ADR-005 or the load test report. He writes correct code on the first attempt.

---

### Week 3, Tuesday — The drift alert

Sam is building a background job that processes bulk task status updates from integrations (Fieldwire's Procore integration sends bulk webhook payloads). He runs Claude Code. His session makes a decision:

```
decision: "Bulk status update job does NOT use a single wrapping transaction — 
           each row committed individually with status tracking in a job_runs table. 
           Failed rows are retried independently."
rationale: "Background job processes up to 5,000 rows per batch from Procore. 
            A single transaction held open for 5,000 writes locks the tasks table 
            for ~12 seconds at p95 — unacceptable for concurrent user writes. 
            Individual commits with retry tracking are safer at this volume."
```

**purpl_brain drift detector fires (3 minutes after session ingestion):**

```
⚠ Drift detected
Decision challenged: "Bulk assignment wraps ALL rows in a single DB transaction — 
                      partial success not allowed" [Priya, Week 1]

Challenged by: sam-2026-05-26-procore-bulk-status  
Reason: New session chose individual-row commits for a bulk operation, contradicting 
        the atomic transaction requirement established in FEAT-1198. The two decisions 
        may be intentionally different (user-facing bulk assign vs background job 
        bulk update have different consistency requirements) but need explicit 
        acknowledgement.
```

The alert surfaces in the purpl_brain web UI. Sam sees it before he's even closed his laptop.

> **Sam** [Slack #engineering, 4:12 PM]  
> @Priya — brain flagged a conflict with your bulk assign decision. I used per-row commits in the Procore background job, you used a single transaction for bulk assign. Intentionally different (UI atomic vs background job with retry tracking) but want to make sure you're aligned

> **Priya** [4:19 PM]  
> Yes that's intentional — for user-facing operations the "all or nothing" UX is important. For a background job that's reconciling with an external system, per-row with retry makes total sense. We should document the distinction explicitly so agents don't blindly copy one pattern for the other

Sam resolves the drift alert with **"keep"** and adds a note. He then adds a comment to ADR-010:

```markdown
## Update — 2026-06-03

Two valid patterns for bulk writes depending on context:

1. **User-facing bulk operations** (e.g. bulk task assignment): use a single 
   wrapping transaction. Partial success is not acceptable in a UI context.
   
2. **Background job bulk processing** (e.g. Procore sync): use per-row commits 
   with job_runs retry tracking. Holding a transaction open for 5,000+ rows 
   causes table lock contention.

Do not conflate these patterns. Apply (1) for anything triggered by a user action, 
(2) for anything triggered by a background job or external webhook.
```

He opens PR #462, which includes only this ADR update. Priya reviews and approves.

---

### Week 3, Thursday — Priya queries the brain as a new engineer would in 6 months

As a final test of her own onboarding, Priya asks the brain the question a future engineer would ask:

> "When should I use a single transaction vs per-row commits for bulk database operations?"

```
Answer: Two established patterns exist in this codebase, both documented in ADR-010 
(updated June 3, 2026):

1. User-facing bulk operations (e.g. bulk task assignment, FEAT-1198): use a single 
   wrapping Knex transaction. Partial success creates inconsistent state visible to 
   users with no recovery path from the UI.

2. Background job bulk processing (e.g. Procore sync worker): use per-row commits 
   with job_runs retry tracking. Transactions held open across 5,000+ rows cause 
   ~12 seconds of table lock contention at p95, blocking concurrent user writes.

Apply (1) for anything triggered by a user action. Apply (2) for background jobs 
and external webhook processing.

[Sources: ADR-010 (2 citations), priya-bulk-assign session, sam-procore-sync session]
```

The answer is grounded, specific, and citable. It took 4 seconds.

---

### What purpl_brain enabled across this scenario

| Moment | Without brain | With brain |
|--------|--------------|------------|
| Priya's day-1 architecture questions | 3 days of Slack questions to Sam | 2 hours of self-serve queries |
| Priya's bulk assignment session start | Would have missed the per-assignee notification constraint → broken notification UX | Constraint surfaced from Sam's prior session |
| Contractor (Reno) onboarding | Would need a 1-hour walkthrough from Maya | Queried brain, wrote correct first-attempt code |
| Sam's bulk commit contradiction | Would have shipped two incompatible patterns in the codebase | Drift alert fired before PR was reviewed — resolved in 15 minutes |
| Future engineer asking about transaction patterns | Would find two contradictory examples in the code and make a guess | Gets a specific, cited answer with the rationale for both valid patterns |

**Brain touchpoints in this scenario:**
1. 6 self-serve queries by Priya on Day 1 — onboarding without burning team time
2. `brain_query` at each of 4 agent session starts — prevented 2 derived-from-scratch mistakes
3. `brain_log_decision` at each session end — created a compounding knowledge base
4. Drift alert Week 3 — surfaced an intentional deviation before it became a silent inconsistency
5. ADR-010 updated and re-ingested — next query gets the clarified dual-pattern answer

---

## Cross-Scenario Observations

### Where purpl_brain creates the most value

**1. The "forgotten constraint" problem**
In all three scenarios, the highest-value brain interaction was surfacing a constraint that existed but was invisible: the Redis connection pool cap (Scenario 1), the passport-saml memory leak (Scenario 2), the per-assignee notification requirement (Scenario 3). These constraints were in ADRs, Slack threads, or prior session logs — findable in theory, but never found in practice without the brain.

**2. Agent-to-agent continuity**
Scenario 1 shows two agents working in parallel on the same feature making a contradictory choice within hours. The drift detector caught it before code review — the type of thing that is invisible in a PR review because each PR looks correct in isolation.

**3. Onboarding leverage**
Scenario 3 quantifies the onboarding value: a new engineer (Priya) and an external contractor (Reno) both write correct, idiomatic code on their first session because the brain surfaces the team's prior decisions proactively. This doesn't require anyone to write documentation — the decisions are already in the brain from prior agent sessions.

### Where purpl_brain does NOT substitute for other tools

- **Linear/GitHub Issues** remain the source of truth for task state and assignment
- **ADRs in git** remain the canonical long-form record — purpl_brain supplements with natural language query, it doesn't replace the ADR
- **Slack** remains where real-time discussion happens — brain ingests it as a signal source, not as a replacement
- **Code review** remains essential — brain drift alerts are a pre-review signal, not a post-review substitute
- **CI/CD** remains the final gate — the brain has no awareness of whether code compiles or tests pass

The brain sits between these tools: it reads from all of them, finds the connections they can't see across each other, and surfaces those connections at the moment an agent or engineer is about to make a decision.
