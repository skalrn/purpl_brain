# purpl_brain Web UI — User Guide

The web UI is a morning command centre for developers running multiple AI-assisted projects. It answers one question: **what did my agents do overnight, and does anything need my attention?**

---

## Three views

| URL | Purpose |
|-----|---------|
| `/` | Multi-project overview — scan all projects at once |
| `/p/<project_id>` | Single-project detail — triage drift, review sessions |
| `/p/<project_id>/sessions/<event_id>` | Agent session audit — inspect decisions before merging |

---

## Overview page (`/`)

### Activity window

The **Today / 24h / 48h / 7d** buttons in the top-left control the "overnight delta" window — how far back to count sessions and decisions on each project card. After a weekend, switch to 48h or 7d so you don't miss Friday's runs.

### Project cards

Each card shows one project:

```
┌─────────────────────────────────────────┐
│ my_project      [Quiet 4d]   [2 drift]  │
│                                         │
│ Last session: Deepak via claude-code    │
│ "migrated auth to OAuth" · 3 decisions  │
│                                         │
│ ↑ 2 sessions · 6 decisions overnight   │
│ 1 task pending                 45m ago  │
└─────────────────────────────────────────┘
```

- **Click the project name** → go to the project detail view
- **Click the red drift badge** → jump straight to the drift inbox in the project view
- **Cards are sorted** by overnight activity (sessions + drift) descending, so the noisiest project is always first

### Status badges

#### `BrainHealthBadge` — write-back health

| Badge | Meaning |
|-------|---------|
| *(nothing)* | Decisions logged within the last 3 days — healthy |
| **Quiet (Nd)** amber | No decisions logged in 3–7 days — agents may not be writing back |
| **Stale (Nd)** red | No decisions logged in 7+ days — check MCP setup |

When you see amber or red: open the project, check the Sessions panel. If there are recent sessions but no decisions, the agent may not be calling `brain_log_decision`. If there are no sessions at all, the MCP connection may be broken.

#### Red drift badge — pending conflicts

Shows the count of unresolved drift alerts for that project. Zero = no badge. Clicking navigates to `#drift` on the project view.

### Cross-project drift link

Top-right of the header: **"All pending drift (N)"** shows the total pending alerts across all your projects. Click it to see which projects have drift (check the red badges on cards).

---

## Project view (`/p/<project_id>`)

Two-column layout: left column has the action panels, right column has the chat panel for ad-hoc queries.

### Drift inbox

The inbox shows **pending** drift alerts only — alerts that need a decision from you. It is not a feed; resolved alerts disappear.

Each alert shows:
- What the new signal said that contradicts a prior decision
- Which decision it challenges (truncated)
- Who triggered it and when

**Actions per alert:**

| Action | Meaning |
|--------|---------|
| **Keep** | The old decision still stands — the signal doesn't change anything |
| **Under review** | You've seen it, not ready to decide — removes it from the pending count without closing it |
| **Reopen** | The decision is no longer valid — marks it changed and auto-creates a follow-up task |

When the inbox is empty, it shows "No pending drift. Brain is consistent." in green.

### Sessions panel

Lists the last 100 agent sessions for the project, newest first.

**Filter chips:** `All / Coding / Infra / Other` — filters by agent type derived from the agent ID (`claude-code` → Coding, `db-migrator` → Infra). The operator dropdown filters by who ran the session.

**Each row shows:**

- Agent type icon (💻 Coding / 🗄 Infra / 📡 Other)
- **Operator** (bold) `via` **agent** (monospace) — or a "Scheduled" chip when there was no human operator
- Work summary (truncated)
- **Quality dot** — green/amber/red circle on the right (see below)
- Decision count and relative time

**Clicking a row** navigates to the session detail view.

#### `WriteBackQualityBadge` — decision quality signal

| Dot | Meaning |
|-----|---------|
| 🟢 green | All decisions in this session include `alternatives_considered` |
| 🟡 amber | Some decisions are missing alternatives (<50%) |
| 🔴 red | Majority of decisions are missing alternatives |
| *(no dot)* | Session has zero decisions |

This is not a pass/fail gate — all decisions passed the server-side quality gate (rationale is required). The dot surfaces whether the agent also documented what it evaluated before deciding. Red sessions are usable but less rich for future queries.

### Changelog

Shows what changed in the last 7 days — decisions created, drift detected, sessions logged. Auto-loads for the project on page open.

### Drift subgraph (collapsed by default)

Click **"Show conflict graph"** to expand a React Flow canvas showing the 2-hop neighbourhood of conflict pairs:

- **Blue-bordered nodes** — coding decisions
- **Amber-bordered nodes** — infra decisions
- **Red nodes** — drift alerts (the conflict edge)

Hover a decision node to see who decided it and when. Useful for understanding cascading conflicts — e.g. an infra migration that conflicts with three coding decisions at once.

### Follow-up tasks

Shows open tasks auto-created when a drift alert is resolved with **Reopen**. Read-only in this build — tasks list who the suggested owner is and whether they require approval before execution.

---

## Session detail view (`/p/<project_id>/sessions/<event_id>`)

Used for pre-merge audits: "what exactly did the agent decide in this session?"

### Metadata bar

Shows agent type, operator/agent attribution, project, timestamp, and the quality badge inline (e.g. "Quality: 3 of 4 decisions missing alternatives").

### Inherited context line

Directly below the metadata bar:

| Line | Meaning |
|------|---------|
| *"This session queried the brain at start. Found 14 prior decisions from 3 sessions."* | Agent called `brain_query` and found context — the write-read loop is working |
| *"This session queried the brain at start. No prior decisions found."* | Agent queried but the brain was empty for this project — likely a cold start |
| *"This session did not query the brain at start."* | Agent skipped the session-start protocol — decisions were made without prior context |

The third case is a soft signal to investigate: the agent may have been run without the MCP connection configured, or it may have been a one-off invocation outside a normal session.

### Decisions

Each decision card shows:
- **Summary** — what was decided
- **Rationale** — why
- **Alternatives considered** — what else was evaluated
- **Confidence** chip — `high / medium / low`
- **`incomplete` chip** (amber outline) — if rationale or alternatives are missing

The `incomplete` chip mirrors the session-level quality dot at the individual decision grain — useful for seeing which specific decisions dragged the session to amber/red.

The `decision_id` at the bottom of each card is copyable (monospace, select-all). Use it to reference the decision in `brain_analyze_impact` calls.

### Preflight checks

Only shown if the agent called `brain_analyze_impact` during the session. Each check shows:

- What change the agent was about to make
- Risk level (`low / medium / high / critical`)
- 2–3 sentence impact summary
- How many existing decisions may be affected

Missing preflight checks on a coding session is expected. Missing them on an infra session (database migrations, schema changes) is worth noting — infra agents should be calling `brain_analyze_impact` before executing.

### Raw log

Collapsed by default. Click to expand the full `raw_content` of the agent log as stored in the brain. Useful for debugging extraction quality — if a decision card looks wrong, compare it to the raw text.

---

## Chat panel (right sidebar on project view)

The existing query interface. Ask in natural language:

- `"What JWT library are we using and why?"` — retrieves decisions from the brain
- `"What changed last 7 days?"` — temporal query, returns changelog format
- `"Did we discuss caching strategy?"` — searches decisions, PRs, Jira, Slack, meeting transcripts

All answers are cited with source, actor, and timestamp. The latency shown below each answer is the full round-trip including LLM generation.

---

## Common workflows

### Morning review (5–10 min)

1. Open `/` — scan cards sorted by activity
2. For any card with a red drift badge → click the badge → triage the inbox (Keep / Reopen)
3. For any amber/red `BrainHealthBadge` → check the sessions panel — is the agent writing back?
4. Click into any session with a red quality dot → identify which decisions are incomplete → decide if they need a follow-up

### Pre-merge audit

1. Find the session from the PR's agent run (check Sessions panel, filter by agent or operator)
2. Open the session detail — verify decisions make sense
3. Check the preflight checks panel if the session touched infrastructure
4. If the inherited-context line says "did not query", confirm the agent had the MCP connection

### Investigating a conflict

1. See a drift alert in the inbox — click "Show conflict graph" on the project view
2. The graph shows which decisions are in conflict and which events triggered them
3. Hover the nodes to see who made each decision and when
4. Resolve in the inbox: Keep (old decision stands) or Reopen (create a task to revisit)
