# Phase 2 Implementation Plan

**Status:** ✅ Complete (2026-05-18)  
**Scoped:** 2026-05-17  
**Exit criterion:** A demo scenario runs end-to-end showing drift detection across at least two sources (Slack + GitHub), with cited answers spanning both. The system flags a real or synthetic decision conflict and surfaces it in the query interface.

**Completion notes:** All six milestones shipped. Multi-source ingestion (Slack, meetings, Jira, extended GitHub), two-stage drift detection, temporal diff query, impact analysis, streaming LLM responses, and the full eval suite. All Phase 2 evals passed 2026-05-17. See `docs/review/project-review-2026-05-18.md` for the post-phase review.

---

## What Changed from Phase 1

Phase 1 proved the pipeline: ingest → extract → store → query, on a single source (GitHub). Every answer was grounded and cited. The brain was passive — it answered questions but never surfected problems on its own.

Phase 2 adds:
1. **More sources** — Slack, meeting transcripts, Jira, extended GitHub
2. **Active intelligence** — drift detection: the brain watches new events and flags when they contradict existing decisions

The architecture does not change. The same normalize → extract → brain-write pipeline handles all new sources. The main new component is the drift detector worker that runs alongside brain-writer.

---

## Scope

**In:**
- Slack ingestion (Socket Mode — no public webhook URL needed for local dev)
- Meeting transcript ingestion (paste-in API endpoint, no live transcription)
- Jira webhook ingestion (issue created/updated/commented events)
- GitHub extension (issues and commit messages, in addition to Phase 1 PRs)
- Drift detection engine (two-stage: semantic filter → LLM confirmation)
- DriftAlert entity in Neo4j (linked to decisions it challenges)
- Multi-source query answers (citations span GitHub + Slack + Jira + meetings)
- Synthetic Slack/Jira seed data for evals
- Real Slack workspace connection for demo

**Out (explicitly deferred to Phase 3):**
- Drift notification push (Slack bot posting alerts back to channel)
- Codegen prompt generation
- Persona-driven query adaptation
- MCP server interface
- AWS deployment
- Auth / multi-user access
- Automatic decision detection from Slack messages (the ephemeral prompt pattern from purplbox)
- Jira ticket creation from brain decisions

---

## Build Order

```
M1: Slack ingestion          — Socket Mode → normalize → extract → brain-write
M2: Drift detection engine   — semantic filter + LLM confirmation + DriftAlert in Neo4j
M3: Meeting transcript       — POST /ingest/transcript → same extraction pipeline
M4: Jira ingestion           — webhook → normalize → extract → brain-write
M5: GitHub extension         — issues + commit messages alongside existing PRs
M6: Eval + demo              — multi-source evals, drift demo scenario
```

If time runs short, cut in this order: M5 (GitHub extend), then M4 (Jira), then M3 (meetings). M1 + M2 are the non-negotiable Phase 2 core.

---

## Architecture Changes

### New workers

**`drift-detector.ts`** — new worker, listens on `events:extracted` stream alongside brain-writer.

For each extracted event:
1. If `decisions.length === 0` and `decision_candidate === false` → skip
2. Embed the event's decision text → query Qdrant for top-K similar existing decisions
3. Filter candidates above cosine threshold (0.55)
4. If candidates found → LLM confirmation pass: "does this event contradict any of these decisions?"
5. If confirmed → write `DriftAlert` node to Neo4j, linked to the challenged decision

The drift detector is read-only on Qdrant and write-only on Neo4j. It does not modify existing decision nodes.

### New stream

`events:drift` — drift-detector publishes confirmed alerts here for future consumers (Phase 3: Slack notification bot).

### Schema additions

**Decision node (Neo4j)** — add fields required before multi-source ingestion begins (noted as pre-Phase-2 task):
```
status: "confirmed" | "changed" | "under_review"   // default: "confirmed"
source_signals: string[]                            // event_ids that informed this decision
```

**DriftAlert node (Neo4j) — new:**
```
alert_id: string         // uuid
decision_id: string      // Neo4j node id of challenged decision
event_id: string         // event that triggered the alert
source: EventSource      // slack | github | jira | meeting
content: string          // the challenging content (truncated 500 chars)
actor: string            // who said/wrote it
timestamp: string        // ISO
confirmed_by_llm: boolean
resolution: "pending" | "keep" | "under_review" | "reopen"
resolved_at?: string
```

**Canonical event — extend existing interface:**
```typescript
source: "github" | "slack" | "jira" | "meeting"   // already partial, make explicit
// Slack-specific (optional fields):
slack_channel?: string
slack_thread_ts?: string
slack_workspace?: string
// Jira-specific (optional fields):
jira_issue_key?: string
jira_project_key?: string
jira_event_type?: "created" | "updated" | "commented" | "status_changed"
// Meeting-specific:
meeting_title?: string
meeting_participants?: string[]
```

### Query engine extension

`runQuery` currently only searches Qdrant and expands via Neo4j. Add:
- **DriftAlert context:** if retrieved chunks have linked DriftAlerts in Neo4j, append a drift summary to the chunk content before LLM answering
- **Source label in citations:** citation cards now show source icon (GitHub / Slack / Jira / Meeting)

---

## Milestone Detail

### M1 — Slack Ingestion

**Goal:** Slack messages from a configured channel flow into the brain and are searchable.

**Approach:** Socket Mode (Bolt SDK) — no public URL needed for local dev. Listens for `message` events in configured channels.

**Tasks:**
- Add `@slack/bolt` to dependencies
- `src/workers/slack-listener.ts` — Socket Mode client, publishes to `events:raw` stream
- Extend `normalizer.ts` to handle `source: "slack"` events → canonical event
- Slack normalizer: channel message → `event_type: "slack_message"`, `raw_content: message text`, `actor: user display name`, `decision_candidate: false` (extractor decides)
- Extend extractor's decision-candidate detection: Slack messages with commitment language ("we'll go with", "agreed", "decided to") → `decision_candidate: true`
- Seed script: `scripts/seed-slack.ts` — generates synthetic Slack messages (decisions, discussions, conflicts) for eval
- New env vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`

**Eval:** 20 synthetic Slack messages (10 with decisions, 10 noise) → extraction precision > 75%, all indexed in Qdrant.

---

### M2 — Drift Detection Engine

**Goal:** New events that contradict existing decisions are flagged as DriftAlerts in Neo4j within the same pipeline pass.

**Approach:** Two-stage (borrowed from purplbox):
- Stage A: Qdrant cosine similarity against existing decision chunks (threshold: 0.55)
- Stage C: LLM confirmation on candidates — single call per event with top-3 candidate decisions

**Tasks:**
- `src/workers/drift-detector.ts` — consumer group on `events:extracted`
- Add `DriftAlert` write capability to `neo4j.ts`
- Drift confirmation prompt: concise, structured — "does this message challenge any of these decisions? answer yes/no with reason"
- Add `Decision.status` and `Decision.source_signals` fields to Neo4j schema (run migration)
- Add `GET /brain/drift-alerts` API endpoint — returns open alerts with decision + source context
- Extend `runQuery` to surface drift context when answering questions about a decision
- Publish confirmed alerts to `events:drift` stream

**Eval:** Seed 5 synthetic conflict messages against known Phase 1 decisions (e.g., a Slack message saying "actually let's support zstd after all"). Drift detector must flag all 5, no false positives on 15 neutral messages.

---

### M3 — Meeting Transcript Ingestion

**Goal:** Paste a meeting transcript, get decisions and action items extracted into the brain.

**Approach:** Simple API endpoint. No live transcription. Same extraction pipeline as other sources.

**Tasks:**
- `POST /ingest/transcript` — accepts `{ text, title, participants, occurred_at, project_id }`
- Normalizer extension: meeting transcript → canonical events (one event per extracted decision)
- Extraction prompt tweak: meeting-specific context (speaker attribution, timestamp parsing)
- Meeting entity in Neo4j: `Meeting` node linked to its extracted `Decision` nodes
- Simple seed script: 2-3 synthetic meeting transcripts with known decisions

**Eval:** 2 transcripts → verify decisions are extracted and queryable.

---

### M4 — Jira Ingestion

**Goal:** Jira issue events (created, updated, commented) flow into the brain. Comments that contradict decisions trigger drift alerts.

**Approach:** Jira webhook → API endpoint → normalize → extract → brain-write (same pipeline).

**Tasks:**
- `POST /webhooks/jira` — receive Jira webhook events
- Jira normalizer: issue event → canonical event with `jira_issue_key`, `jira_project_key`
- Extraction: Jira issue description and comments as extraction candidates
- Decision-candidate detection: Jira comments with design discussion language
- Synthetic Jira seed script for evals
- New env vars: `JIRA_WEBHOOK_SECRET`

**Eval:** 10 synthetic Jira events → 3 with decision content, 7 noise. Extraction targets same as Slack.

---

### M5 — GitHub Extension

**Goal:** Issues and commit messages indexed alongside PRs from Phase 1.

**Tasks:**
- Extend `seed-github.ts` to fetch issues (`--issues` flag already exists, wire it fully)
- Normalizer: `issue` event type → canonical event
- Commit message ingestion: fetch commits per PR, normalize as lightweight events
- Extraction: commit messages are rarely decision candidates — low `decision_candidate` rate expected

**Eval:** Re-run Phase 1 extraction eval on combined PR + issue corpus. Precision should hold > 85%.

---

### M6 — Multi-Source Eval + Demo

**Goal:** All evals pass on multi-source data. Demo scenario runs end-to-end.

**Evals to run:**
- Extraction: precision > 80%, recall > 70% across all source types
- Query accuracy: > 80% on 20 new test queries that span Slack + GitHub + meetings
- Citation accuracy: 0 fabricated citations, source labels correct
- Drift detection: 100% recall on 5 seeded conflict messages, < 20% false positive rate
- Latency: p95 < 5s with Claude API

**Demo scenario:**
See `docs/demo/phase2-demo-script.md` (written at M6 start).

Core narrative: engineer returns after 2 weeks. Queries span GitHub PRs and Slack discussions. System surfaces a drift alert — a Slack message from last week challenges the compression decision. Engineer resolves it as "under_review" in the API.

---

## Pre-Phase-2 Schema Migration

Before M1 starts, run a one-time Neo4j migration to add `status` and `source_signals` to existing `Decision` nodes:

```cypher
MATCH (d:Decision)
WHERE d.status IS NULL
SET d.status = "confirmed", d.source_signals = []
```

This must run before multi-source ingestion begins. Existing Phase 1 data is unaffected.

---

## New Environment Variables

```
# Slack (Socket Mode)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_CHANNEL_ID=C0123456789

# Jira
JIRA_WEBHOOK_SECRET=your-webhook-secret

# Drift detection tuning
DRIFT_SEMANTIC_THRESHOLD=0.55    # cosine similarity cutoff for Stage A
DRIFT_TOP_K=3                    # max candidate decisions per event
```

---

## What We Are Not Rebuilding from purplbox

| purplbox feature | Decision |
|---|---|
| Flat JSON storage | Skip — we have Qdrant + Neo4j, no reason to add JSON files |
| Socket Mode Slack listener | **Adopt** — same approach, different codebase |
| Two-stage drift detection (A+C) | **Adopt** — the pattern is right, reimplement cleanly |
| Decision deduplication (semantic at ingest) | **Adopt** — add to brain-writer in M1 |
| k/u/r drift resolution UI | **Defer** — Phase 3. Phase 2 exposes resolution via API only |
| Codegen prompt generation | **Defer** — Phase 3 |
| Persona-driven query adaptation | **Defer** — Phase 3 |
| Slack bot posting back to channel | **Defer** — Phase 3 |
| Automatic ephemeral decision prompts | **Defer** — Phase 3 |

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Slack Socket Mode connection drops in local dev | Medium | Auto-reconnect built into Bolt SDK; document restart procedure |
| Drift detector produces too many false positives | Medium | Stage A threshold is tunable; eval with synthetic conflicts before real data |
| Multi-source context noise degrades query accuracy | Medium | Keep source-type filter as an optional query param; eval M6 catches regressions |
| Jira webhook delivery unreliable locally | High | Use ngrok for Jira; or skip live Jira webhooks and use polling + seed data for evals |
| 4 sources is too much for one phase | Medium | Cut order defined: M5 first, then M4, then M3 — M1+M2 are the hard floor |

---

## Technology Additions

| Component | Technology | Notes |
|---|---|---|
| Slack listener | `@slack/bolt` (Socket Mode) | No public URL needed locally |
| Jira webhook | Existing Fastify server | New route only |
| Drift detection LLM | Same `llm.ts` router | Uses MODELS.QUERY (or a cheaper model) |
| Neo4j DriftAlert | Existing neo4j driver | New node type, no schema migration tool needed |
