# UI Implementation Plan — purpl_brain Web

**Status:** Ready to build  
**Branch:** `pivot/agent-memory` (or new branch off it)  
**Stack:** Next.js (existing), TanStack Query, React Flow + dagre, Sonner, Lucide, Tailwind v4  
**Working directory:** `apps/web/`

---

## Context

This plan covers UI-1: the Profile B morning-review dashboard. Profile B is a solo developer running 5–10 simultaneous AI-assisted projects, often with overnight autonomous agent runs. The UI is their morning command centre — scan overnight agent activity across all projects, triage drift, review infra changes, then go code.

Existing components (`Chat.tsx`, `Changelog.tsx`, `CitationCard.tsx`, `UserMenu.tsx`) are kept. New routes and components wrap them.

---

## Technology Choices

| Package | Purpose | Why this one |
|---|---|---|
| `@tanstack/react-query` | Server state management — fetch, cache, background refetch, stale-while-revalidate | Purpose-built for async server data. Handles polling intervals, cache invalidation after mutations (e.g. resolve drift → refetch alerts), and loading/error states without boilerplate. Alternative (SWR) lacks built-in mutation invalidation. |
| `@tanstack/react-query-devtools` | Dev-only panel showing query cache state | Essential for debugging stale cache during development. Zero prod cost — tree-shaken out. |
| `reactflow` | Interactive node-edge graph canvas for the drift subgraph | The only React-native graph library with good TypeScript support, custom node rendering, and zoom/pan out of the box. D3-force requires manual React bridging. Cytoscape.js has no React-native API. |
| `@dagrejs/dagre` | Hierarchical graph layout algorithm | Computes x/y positions for React Flow nodes automatically. Dagre produces clean top-down or left-right layouts suited to decision→drift trees. Alternative (ELK) is heavier and asynchronous. |
| `sonner` | Toast notifications | Lightweight, accessible, Tailwind-friendly. Used for mutation feedback (drift resolved, errors). Alternative (react-hot-toast) has less accessible defaults. |
| `lucide-react` | Icon set | Already consistent with the existing design. Tree-shakeable. `Code2`, `Database`, `Radio`, `Bot` used for agent type badges. |
| `clsx` + `tailwind-merge` | Conditional classname composition | `clsx` handles conditional logic; `tailwind-merge` resolves Tailwind class conflicts when composing component variants. Standard pattern for Tailwind component libraries. |

**Next.js routing:** App Router (file-system based, `app/` directory). Already in use — `app/layout.tsx` and `app/page.tsx` exist. All new routes follow the `app/p/[project_id]/...` convention.

---

## npm Installs Required

```bash
cd apps/web
npm install @tanstack/react-query @tanstack/react-query-devtools
npm install reactflow @dagrejs/dagre
npm install sonner
npm install lucide-react
npm install clsx tailwind-merge
```

---

## Routes

| Route | Description |
|---|---|
| `/` | Multi-project overview — Profile B morning dashboard |
| `/p/[project_id]` | Single-project brain state view |
| `/p/[project_id]/sessions/[event_id]` | Agent session detail — decisions + preflight checks |

---

## API Endpoints Used

All secured with `NEXT_PUBLIC_API_KEY` header `x-api-key`.

| Endpoint | Used by |
|---|---|
| `GET /brain/projects?since=<ISO>` | `/` overview cards |
| `GET /brain/drift-alerts` (no project_id) | `/` cross-project drift link |
| `GET /brain/drift-alerts?project_id=X` | `/p/[project_id]` drift inbox |
| `POST /brain/drift-alerts/:id/resolve` | Drift inbox actions |
| `GET /brain/agent-sessions?project_id=X` | `/p/[project_id]` session list |
| `GET /brain/agent-sessions/:event_id` | Session detail page |
| `GET /brain/tasks?project_id=X` | `/p/[project_id]` tasks panel |
| `POST /brain/query` (streaming) | Chat panel (existing) |

---

## Data Fetching Setup

### `app/lib/api.ts` — typed fetch helpers

```typescript
const API_URL = process.env.NEXT_PUBLIC_API_URL;
const API_KEY = process.env.NEXT_PUBLIC_API_KEY;

function apiFetch<T>(path: string, init?: RequestInit): Promise<T>
```

One function, all routes use it. Throws on non-2xx.

### `app/providers.tsx` — TanStack Query provider

Wrap `app/layout.tsx` children in `<QueryClientProvider>`.  
Add `<ReactQueryDevtools />` in development only.

### Polling intervals

| Data | Stale time | Refetch interval |
|---|---|---|
| Projects list | 30s | 60s |
| Drift alerts | 15s | 30s |
| Agent sessions | 30s | 60s |
| Session detail | 5 min | none (static once loaded) |

---

## R1-Driven Additions (May 2026 market analysis)

The three components below — `BrainHealthBadge`, the write-back quality signal on sessions, and the session handoff indicator on `SessionDetailView` — were added after the May 2026 market analysis and product review. They close specific gaps from R1 in `docs/product/prd.md` Section 8:

- **`BrainHealthBadge`** addresses R1 failure mode A (trigger discipline): when no decisions have been logged for several days, the UI surfaces the empty-brain state explicitly rather than letting the user discover it by running a query that returns nothing.
- **Write-back quality signal on sessions** addresses R1 failure mode B (content quality): a session full of decisions missing rationale or alternatives is nearly as useless as an empty brain, and harder to diagnose. The amber/red indicator surfaces this without requiring the developer to open each session.
- **Session handoff indicator** is the visual proof of the core value proposition — "the next agent session knows what the last one decided." Showing how many prior decisions were inherited at `brain_query` time makes the write-read loop visible.

These additions extend the existing plan — they do not restructure it. Specs below are folded into the relevant component, route, and build-order sections.

---

## Component Tree

```
app/
  layout.tsx                    — QueryClientProvider + Sonner <Toaster>
  page.tsx                      — ProjectsOverview
  p/
    [project_id]/
      page.tsx                  — ProjectBrainView
      sessions/
        [event_id]/
          page.tsx              — SessionDetailView

  components/
    // ── Existing (unchanged) ──
    Chat.tsx
    Changelog.tsx
    CitationCard.tsx
    UserMenu.tsx

    // ── New: Overview ──
    ProjectCard.tsx             — single project card with overnight delta
    ProjectGrid.tsx             — grid of ProjectCards + cross-project drift link
    EmptyBrainState.tsx         — "brain warming up" state

    // ── New: Drift ──
    DriftInbox.tsx              — persistent triage inbox (not a feed)
    DriftAlertRow.tsx           — single alert with keep/under_review/reopen actions
    DriftBadge.tsx              — red count badge, reused in card + header

    // ── New: Agent Sessions ──
    SessionList.tsx             — filterable list (coding/infra/other + operator filter)
    SessionRow.tsx              — "{operator} via {agent}" row with type icon
    SessionDetail.tsx           — decisions + preflight checks for one session

    // ── New: Drift Subgraph ──
    DriftGraph.tsx              — React Flow + dagre, 2-hop conflict subgraph

    // ── New: Shared ──
    AgentTypeBadge.tsx          — icon + label for coding/infra/other
    OperatorTag.tsx             — "Scheduled" tag when operator_name is null
    RiskBadge.tsx               — low/medium/high/critical colour chip
    BrainHealthBadge.tsx        — amber/red badge surfacing R1-A (no decisions logged recently)
    WriteBackQualityBadge.tsx   — green/amber/red badge surfacing R1-B (rationale/alternatives populated)
```

---

## `/` — ProjectsOverview

### Layout
Full-page. Header: "purpl_brain" wordmark left, `UserMenu` right, "All pending drift (N)" link far right (calls `GET /brain/drift-alerts` with no project_id, shows total count).

Body: `ProjectGrid` — responsive card grid, sorted by `sessions_since + pending_drift_count` descending. Pinned project (orion_commerce) always first.

### `ProjectCard` — fields displayed

```
┌─────────────────────────────────────────┐
│ project_id        [health]    [2 drift] │  ← BrainHealthBadge + DriftBadge
│                                         │
│ Last session: Deepak via claude-code    │  ← operator_name + agent_id
│ "migrated auth to OAuth" · 4 decisions │  ← work_summary + decision_count
│                                         │
│ ↑ 3 sessions · 8 decisions overnight   │  ← sessions_since + decisions_since
│ 2 tasks pending                        │  ← pending_tasks_count
│                                  12m ago│  ← last_event_at relative time
└─────────────────────────────────────────┘
```

`BrainHealthBadge` placement: top row, left of `DriftBadge`. Renders nothing when the brain is healthy (decisions logged within 3 days). Amber when `last_decision_logged_at` is more than 3 days ago, red when more than 7 days ago. Hover/tap hint: `no agent decisions logged this week — check MCP setup`. Sourced from `last_decision_logged_at` (ISO string) on the project response — add this field to `GET /brain/projects` if not already returned.

- Clicking the card navigates to `/p/[project_id]`
- Clicking the drift badge navigates to `/p/[project_id]` with `#drift` anchor
- "Needs review" composite line only shown if `sessions_since > 0` or `pending_drift_count > 0`

### `since` parameter

On page load, compute `since` as midnight of the current day (local time, ISO string). Pass to `GET /brain/projects?since=<ISO>`. This gives "activity since midnight" as the overnight delta. Store in a date-picker state so the user can adjust the window (e.g. last 48h for weekends).

### Empty state

`EmptyBrainState` when `projects.length === 0` — "No projects in the brain yet. Run a seed or log an agent session to get started."

---

## `/p/[project_id]` — ProjectBrainView

### Layout
Two-column on desktop (lg+). Left 2/3: main panels stacked vertically. Right 1/3: Chat panel (existing `Chat.tsx`).

### Header

`project_id` heading left. Right side, in order: `BrainHealthBadge` (same thresholds as on `ProjectCard` — amber > 3 days, red > 7 days since last decision), `DriftBadge`, `UserMenu`. The badge in the header is the persistent in-page reminder of write-back health while the user is inside the project — the overview badge tells them which project is silent, the header badge keeps that signal visible while they work in it.

#### Left column panels (top to bottom)

**1. Drift Inbox (`DriftInbox`)**  
Header: "Drift (N pending)" with `DriftBadge`. Inbox-shaped — shows pending alerts sorted by timestamp desc. Each `DriftAlertRow` has:
- Alert content (truncated to 2 lines)
- Actor who triggered it + timestamp
- Actions: `Keep` / `Under review` / `Reopen` (calls `POST /brain/drift-alerts/:id/resolve`)
- After resolve: row fades out, toast via Sonner ("Alert resolved")

When count = 0: "No pending drift. Brain is consistent." green state.

**2. Agent Sessions (`SessionList`)**  
Header: "Sessions" + filter chips: `All` / `Coding` / `Infra` / `Other` + operator filter (dropdown of distinct operator_names from session list). Each `SessionRow`:
- Left: `AgentTypeBadge` icon (`Code2` / `Database` / `Radio` / `Bot`)
- Middle: `{operator_name} via {agent_id}` (bold operator, muted monospace agent). If `operator_name` is null: `OperatorTag` showing "Scheduled" chip instead.
- Right: `WriteBackQualityBadge` (small dot — green/amber/red) + decision count + relative timestamp
- Click: navigates to `/p/[project_id]/sessions/[event_id]`

`WriteBackQualityBadge` rules (applied identically here and on `SessionDetailView`):
- **Green:** every decision in the session has a non-empty `rationale` and a non-empty `alternatives_considered` array.
- **Amber:** at least one decision is missing `rationale` or `alternatives_considered`, but fewer than half are missing.
- **Red:** the majority of decisions are missing `rationale` or `alternatives_considered`.
- Sessions with zero decisions render no badge (use `decision_count` only).
- Hover hint shows the breakdown: `3 of 4 decisions missing rationale`.

This badge surfaces R1 failure mode B (content quality) to the developer at scan time, without requiring them to open each session. It also gives them visible feedback that the server-side schema validation gate (PRD R1) is doing its job — green dots across the board means the gate is working.

**3. Brain Changelog (`Changelog`)**  
Existing component. Kept as-is. Feed of graph-mutating events — decision created, drift detected, session logged. 🤖/👤 icons. Operator field: update the agent-event line from "🤖 claude-code" to "🤖 Deepak via claude-code" when `operator_name` is present.

**4. Drift Subgraph (`DriftGraph`)**  
Collapsed by default, "Show conflict graph" toggle. On expand: React Flow canvas with dagre layout. 2-hop neighbourhood around conflict pairs. Node types:
- Decision node (blue border) — coding-origin
- Decision node (amber border) — infra-origin
- DriftAlert node (red) — the conflict edge label
- Event node (grey) — source citation

Hover tooltip on Decision nodes: `decided by {agent_id} on behalf of {operator_name} at {timestamp}`. Falls back gracefully when `operator_name` is null.

**5. Follow-up Tasks**  
Simple list below Changelog. `GET /brain/tasks?project_id=X&status=open`. Each task shows title, suggested_owner, `Requires approval` badge. No actions in this build — read-only view.

---

## `/p/[project_id]/sessions/[event_id]` — SessionDetailView

Single session full-page detail. Used for pre-merge audit.

### Header metadata bar
`agent_id` (with `AgentTypeBadge`) · `operator_name` (with `OperatorTag` if null) · `project_id` · `timestamp` · `WriteBackQualityBadge` (same green/amber/red rules as on `SessionRow`, with the breakdown text rendered inline next to the badge instead of on hover, e.g. "Quality: 3 of 4 decisions missing rationale").

### Inherited context

Shown directly under the header metadata bar, above the Decisions section:

```
This session queried the brain at start. Found 14 prior decisions from 3 sessions.
```

- Renders only if the session actually called `brain_query` at start (i.e. the field is not null).
- If the session did not call `brain_query`: render a muted line `This session did not query the brain at start.` — this is a soft signal that the agent skipped its session-start protocol, useful for diagnosing R1-A.
- If the session queried the brain but found nothing: render `This session queried the brain at start. No prior decisions found.` — distinct from "did not query" and from "found N decisions".

Backed by one new field on the agent session detail response: `brain_query_results_count` (nullable integer — `null` = did not query, `0` = queried with no hits, `>0` = queried with hits). The "from N sessions" count comes from `brain_query_distinct_sessions_count` (or can be derived server-side from the same query). Add both fields to `GET /brain/agent-sessions/:event_id` if not present.

This section is the visual proof of the core value proposition — "the next session knows what the last one decided." Without it, the write-read loop is invisible to the developer: they see decisions get logged but never see them get read. Surfacing the inherited-context count makes the loop legible.

### Sections

**Decisions** — list of decision cards. Each card: `summary`, `rationale`, `confidence` chip, `status` badge, `decision_id` (monospace, copyable). Cards with missing `rationale` or empty `alternatives_considered` get a small amber outline and an inline `incomplete` chip, mirroring the session-level `WriteBackQualityBadge` at the per-decision grain.

**Preflight Checks** — shown only if `preflight_checks.length > 0`. Each check:
- `change_description` (what the agent was about to do)
- `overall_risk` chip (`RiskBadge`: green/amber/red/critical)
- `summary` (2-3 sentence impact assessment)
- `affected_decision_count` — "N decisions may be affected"
- `checked_at` timestamp

If no preflight checks: "No preflight checks recorded for this session." (not an error — most coding agents won't have them; infra agents will).

**Raw log** — collapsible `<pre>` of `raw_content`. Useful for debugging.

### Infra session rendering rules

Infra agent sessions (`agent_type: "infra"`) have different content shapes than coding sessions. The session detail must handle these without breaking:

- **`files_modified`** may contain `.sql`, `.cql`, Kafka topic names, schema registry URLs, or Avro/Protobuf schema paths. Render as a plain string list — do not attempt to construct GitHub repo links from these. A `.sql` migration path is not a GitHub file URL.
- **`work_summary`** may reference table names, keyspace names, or topic names that are not `Decision` or `Event` nodes in the graph. `CitationCard` must check whether the referenced entity exists before rendering a link — render as plain text if not found, never a 404 or broken link.
- **Decision `summary` fields** from infra agents describe schema operations, not code patterns. They will not match the vocabulary of coding decisions. This is expected — do not filter or truncate them based on length or unfamiliar terminology.

---

## Key Design Rules

### Drift inbox is not a feed
No infinite scroll. All pending alerts are shown (capped at 50 in the API). Resolved alerts disappear. It is a triage inbox, not an activity log.

### Changelog is not the inbox
The Changelog shows what happened. The Drift inbox shows what needs a decision. Keep them visually distinct.

### Agent type icon, not text
`AgentTypeBadge` shows icon + short label ("Coding" / "Infra" / "Other"). Use Lucide: `Code2`, `Database`, `Radio`, `Bot`. No wall of text in the session row.

### Operator is primary, agent is secondary
In all session row displays: operator name bold, agent_id in muted monospace. "Deepak via claude-code" not "claude-code (Deepak)". When operator is null, "Scheduled" chip replaces the operator slot entirely.

### Non-fatal errors get toasts, not broken pages
All mutation errors (resolve drift, etc.) surface via Sonner toast. Data fetch errors show inline empty states, not full-page errors.

### `since` window is user-adjustable
The overview page `since` defaults to today midnight but exposes a simple "Last 24h / 48h / 7d" toggle. This makes the overnight-delta cards useful after weekends.

### CitationCard must not 404 on infra entities
`CitationCard` is designed for GitHub PRs, Jira tickets, and Slack threads — all of which have resolvable URLs in the graph. Infra agent sessions may reference Cassandra table names, Kafka topics, or migration filenames that have no corresponding graph node. Before rendering a `CitationCard` link, check that a matching source URL or graph node exists. Render as plain text if it does not. This applies to `work_summary` previews on `ProjectCard` and to citation rendering in `SessionDetail`.

### Bulk review affordance (future, not this build)
With 10 projects × overnight runs, per-item drift triage across 10 separate inboxes will become the dominant friction point for Profile B. This build does not implement bulk actions, but the `/` overview page must at minimum make it immediately visible which projects have zero pending drift (so the user can skip them entirely without clicking in). The `DriftBadge` on `ProjectCard` serves this purpose. A future "Approve all low-risk" bulk action on the overview page would close the remaining gap — flag for post-beta design.

---

## Changelog.tsx Update Required

The existing `Changelog.tsx` renders agent events without operator attribution. Before building new components, update it:

- When event source is `"agent"` and `operator_name` is present: render "🤖 {operator_name} via {agent_id} logged decision …"
- When `operator_name` is null: render "🤖 {agent_id} logged decision …" (existing behaviour)

This requires the Changelog to consume the new `operator_name` field from the changelog API response. Check whether the changelog endpoint currently returns this — if not, add it to the query that backs the Changelog component.

---

## Build Order

1. `npm install` all packages
2. `app/lib/api.ts` + typed response interfaces
3. `app/providers.tsx` — TanStack Query setup
4. Update `app/layout.tsx` — wrap in providers, add `<Toaster />`
5. `AgentTypeBadge`, `OperatorTag`, `RiskBadge`, `DriftBadge`, `BrainHealthBadge`, `WriteBackQualityBadge` — shared primitives first
6. `ProjectCard` + `ProjectGrid` + `EmptyBrainState` → wire `/` page (include `BrainHealthBadge` on each card)
7. `DriftAlertRow` + `DriftInbox` → wire into `/p/[project_id]`
8. `SessionRow` + `SessionList` → wire into `/p/[project_id]` (include `WriteBackQualityBadge` on each row)
9. Update `Changelog.tsx` for operator attribution
10. `DriftGraph` (React Flow) → add as collapsible panel
11. `/p/[project_id]/sessions/[event_id]` — `SessionDetailView` with preflight checks, inherited-context section, and `WriteBackQualityBadge` in header
12. `GET /brain/drift-alerts` cross-project count link on overview header
13. `since` date-window toggle on overview
14. Test golden path: overview → click project card (health badge visible) → session row (quality badge visible) → session detail (inherited-context line + per-decision quality) → preflight check

---

## Environment

```
NEXT_PUBLIC_API_URL=http://localhost:3001
NEXT_PUBLIC_API_KEY=dev-local
```

These already exist in `apps/web/.env.local`.
