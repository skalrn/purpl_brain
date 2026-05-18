# Product Roadmap — Project Brain

**Status:** Draft  
**Last Updated:** 2026-05-15  

---

## Phasing Principles

Each phase proves a discrete thesis before the next begins. A phase is not complete until the core thesis is demonstrated with real data from a real (or realistic) project.

| Phase | Thesis | Exit Criterion |
|---|---|---|
| Phase 1 | Context-on-demand works | A user accurately understands project state from a query, cited to sources |
| Phase 2 | Agent write-back loop works | A resumed agent session inherits prior decisions without re-prompting |
| Phase 3 | Cross-surface synthesis works | A single query synthesizes a decision from 2+ sources |
| Phase 4 | Multi-product graph works | A specialist queries across products by domain |

---

## Phase 1 — Context on Demand (MVP)

**Target duration:** 6–8 weeks  
**Primary persona:** Context Switcher (engineer)

### Scope

**In:**
- GitHub as the sole ingestion source: PRs, Issues, commit messages
- Vector store brain with lightweight relationship graph (PR → Issue → decision)
- Natural language query interface (web chat UI)
- Project-scoped queries only
- Manual project setup (no self-serve onboarding)

**Out:**
- Slack, Jira, meetings, agent trails
- Proactive anomaly detection
- Multi-product graph
- MCP server interface

### Key Deliverables
- Webhook listener for GitHub events
- Ingestion pipeline: parse → chunk → embed → store
- Relationship graph: PR links to Issue, Issue links to prior PR, decision extracted and linked
- Query API with RAG retrieval and citation
- Minimal chat UI (can be a simple web page — not a polished product)

### Phase 1 Exit Criterion
A developer returning after 2 weeks queries the brain about a repo they work on and correctly understands: current PR state, key decisions made, and open questions — all cited to specific GitHub sources.

---

## Phase 2 — Agent Write-Back Loop

**Target duration:** 4–6 weeks (after Phase 1 complete)  
**Primary persona:** AI Agent (non-human actor)

### Scope

**In:**
- Agent decision log schema (defined and published)
- Agent write-back API endpoint
- Brain ingestion of agent logs as a first-class source
- Agent resume query: *"What did the agent decide in its last session?"*
- Integration with one agent (Claude via API as reference implementation)

**Out:**
- Agent identity / auth beyond API key
- Automatic agent instrumentation (agents must explicitly emit logs in Phase 2)

### Key Deliverables
- Decision log JSON schema: `{ task_id, session_id, decisions[], alternatives_considered[], unresolved[], next_steps[], timestamp }`
- Write-back endpoint: `POST /brain/agent-log`
- Brain update logic for agent logs: link to project, ticket, and codebase
- Resume query handler: returns prior session summary for a given task or codebase

### Phase 2 Exit Criterion
An AI agent is invoked on a task, paused, and resumed in a new session. The resumed agent correctly references prior decisions without re-prompting. At least one prior decision is not re-derived or contradicted.

---

## Phase 3 — Multi-Source Synthesis

**Target duration:** 6–8 weeks (after Phase 2 complete)  
**Primary persona:** Context Switcher, Tech Lead / PM

### Scope

**In:**
- Second ingestion source: Slack (forward-only from integration date) or Linear/Jira
- Cross-source entity linking: same decision referenced in GitHub PR and Slack thread
- Proactive anomaly detection (Slack decision contradicts open Jira ticket)
- Human-invokable impact analysis

**Out:**
- Meeting transcript ingestion
- Multi-product graph
- Full Slack history import

### Key Deliverables
- Slack webhook listener and message parser
- Entity linker: connects mentions of the same concept across GitHub and Slack
- Contradiction detector: flags when ingested signal conflicts with existing brain belief
- Anomaly alert surface (query interface notification; optional Slack DM)
- Impact analysis endpoint: given an event ID, return affected tickets, decisions, agents

### Phase 3 Exit Criterion
A single query returns a synthesized answer grounded in both a GitHub PR comment and a Slack thread, with both cited. At least one proactive anomaly alert is generated from a real cross-source contradiction.

---

## Phase 4 — Document Brain + Cross-Product Graph (Restructured)

**Target duration:** 4–5 weeks (after Phase 3 complete)
**Primary persona:** Floating Specialist, Context Switcher
**Status:** M1 and M2 complete. Remaining milestones (M3–M6) are paused. The phase is being restructured around the agent-memory pivot — see the **Pivot — Agent Memory** section below. Cross-product graph and meeting attachment vision processing are deprioritized; document and transcript ingestion (already shipped) remain in the product as context-enrichment sources for the agent memory layer.

### Thesis

Any intelligent actor can query across products *and* across artifact types — not just events (PRs, Slack, Jira) but static knowledge (ADRs, PRDs, meeting notes, diagrams).

### Scope

**In:**
- Document ingestion: ADRs, PRDs, RFCs, runbooks (`.md`, `.pdf`, `.txt`, `.docx`)
- GitHub repo file crawler: auto-index `docs/**/*.md` on project setup
- Meeting transcript ingestion: file upload (`.vtt`, `.srt`, `.txt`) + Fireflies webhook
- Meeting attachment processing: text extraction (PDF/DOCX/PPTX) + vision model pass for images/diagrams
- Cross-product graph edges: shared team members, shared libraries, analogous decisions
- Expertise-scoped query mode: single query across all projects filtered by domain/topic
- Self-serve project onboarding via web UI

**Out:**
- Live meeting integration (real-time transcription)
- Enterprise auth / SSO
- Mobile client
- Full Slack/Jira history backfill

### Milestones

#### M1 — Document ingestion (COMPLETE)
- `POST /ingest/document` REST endpoint (file upload: `.md`, `.pdf`, `.txt`, `.docx`)
- GitHub repo file crawler: scans `docs/**/*.md` at seed time and on push events to `docs/` path
- 512-token sliding window chunking with 20% overlap
- Source type: `"document"`, sub-types: `"adr"`, `"prd"`, `"runbook"`, `"unknown"`
- Exit: query returns a cited answer grounded in an ADR or PRD file

#### M2 — Meeting transcript ingestion (COMPLETE)
- File upload path: `.vtt`, `.srt`, `.txt` transcripts
- Fireflies webhook path (optional, for users with Fireflies account)
- Speaker resolution: fuzzy name → existing Person node by email
- Source type: `"meeting"` with title + date metadata
- Exit: query returns cited answer from a meeting transcript

#### M3 — Attachment processing (2–3 days)
- Text extraction: PDF (`pdfjs`), DOCX (`mammoth`), PPTX text slides
- Image/diagram processing: vision model pass (claude-haiku) → text description chunk linked to parent
- Cost guards: skip images > 5 MB, cap 10 images per meeting
- Exit: architecture diagram in a meeting attachment is queryable by its content

#### M4 — Cross-product graph (3–4 days)
- Shared team member edges: Person active in multiple projects → `[:ACTIVE_IN]`
- Shared library edges: same package referenced across projects → `Library` node + `[:USES]`
- Analogous decision edges: cosine similarity > 0.80 across project namespaces → `[:ANALOGOUS_TO]`
- Expertise-scoped query mode (`mode: "expertise"` in `brain_query`): searches across all projects, filtered by topic tag
- Exit: single query returns cited decisions from two different project namespaces

#### M5 — Self-serve project onboarding (2–3 days)
- "Add project" flow in web UI: paste GitHub repo URL, authenticate, done
- Auto-crawls `docs/**/*.md` + seeds last 90 days of GitHub events on add
- Project dashboard: ingestion status, event count by source, last sync time
- Multi-project switcher in chat UI
- Exit: new project added and queryable in under 3 minutes via UI

#### M6 — Phase 4 eval + demo script (1 day)
- 5 cross-project queries, 3 document-sourced queries, 2 meeting-sourced queries — all cited
- One architecture diagram queryable by content
- Demo script: solopreneur with 3 projects queries spanning GitHub + ADR + meeting note

### Phase 4 Exit Criterion
A specialist queries: *"Show me all auth-related decisions across my projects, including anything in design docs or meeting notes."* The result is accurate, cross-project, cross-artifact, and cited to specific sources.

---

## Pivot — Agent Memory (Current Focus)

**Target duration:** 4–6 weeks from start of P2
**Primary persona:** AI Agent (Persona 1), Agent Operator (Persona 2)
**Branch:** `pivot/agent-memory`

### Why this pivot exists

The honest project review on 2026-05-17 (`docs/review/project-review-2026-05-17.md`) concluded that the original positioning ("shared working memory for human-agent teams") competes head-on with Glean, Notion AI, and GitHub Copilot Spaces without a defensible wedge. The one genuinely differentiated capability already shipped in the codebase is the agent write-back loop (`POST /brain/agent-log`) combined with the MCP server skeleton in `apps/mcp`. No competitor is doing agent-first persistent memory with a documented write API and an MCP read path.

The pivot narrows the ICP from "small teams running multiple products" to "individual developers and small teams (2–8 engineers) who use AI coding assistants heavily." The primary product surface becomes the MCP server. The web chat UI becomes secondary. Slack, Jira, and meeting ingestion stay in the product as context-enrichment sources, not as the lead pitch.

### Milestones

#### P1 — Auth hardening + eval coverage (COMPLETE)
Steps 1–9 from the production-pivot checklist. API key auth on all `/brain/*` write endpoints, fail-closed webhook signature verification, startup-time assertions for `SESSION_SECRET` / `NEO4J_PASSWORD` / `ANTHROPIC_API_KEY`, hashed API keys at rest, fixed document idempotency, Neo4j uniqueness constraints, dead-letter queue, latency truth-telling on Anthropic, agent-log round-trip eval, project_id isolation eval. All landed on `pivot/agent-memory`.

#### P2 — Agent onboarding entry point
Rewrite the setup flow so the first thing a new user does is install the MCP server into their Cursor or Claude Code config, not set up a GitHub webhook. The web UI shows a one-page setup with the MCP server URL, the API key, and copy-pasteable config snippets for Cursor (`~/.cursor/mcp.json`) and Claude Code (`claude_desktop_config.json` / `.mcp.json`). GitHub webhook setup is demoted to "optional — enrich the brain with PR and commit context" on a secondary page.

Exit: a new user goes from sign-up to first successful `brain_query` MCP call from Claude Code in under 5 minutes, with no GitHub setup required.

#### P3 — Hosted agent demo
A live, public, no-signup-required demo on `demo.purpl.dev` showing the full agent memory loop:
- Session 1: Claude Code (or a scripted MCP client) opens against a sample repo, makes a few decisions, calls `POST /brain/agent-log` at session end.
- Session 2: a second Claude Code session opens against the same repo, calls `brain_query` via MCP, receives the prior decisions with citations, and continues from there.
- The visitor sees both transcripts side by side and the brain state in between.

Exit: a 30-second screencast plus an interactive sandbox that reproduces the loop without the visitor running any local setup.

#### P4 — Agent memory dashboard
A simple web UI showing agent decision history per repo and per agent. Not a chat interface. The dashboard surfaces:
- Recent agent sessions (timestamp, agent identity, repo, decision count, unresolved-question count)
- A timeline of decisions per repo with rationale and citations
- Drift alerts when a new session contradicts a prior decision
- Search and filter by repo, by agent client (`claude-code`, `cursor`, `aider`, etc.), and by topic

Exit: an Agent Operator (Persona 2) can answer "what did my agents decide about X in the last 7 days" in under 30 seconds without scrolling through chat transcripts.

#### P5 — Public beta
Open the product to developers using AI coding assistants. Pricing: free tier (1 repo, 100 agent sessions/month) + paid tier ($15/month, unlimited repos and sessions). Self-serve sign-up via GitHub OAuth. The MCP server URL and API key are issued on sign-up. No sales calls.

Exit: 50 external sign-ups, 10 weekly-active Agent Operators, at least 3 unsolicited testimonials referencing the agent-memory loop as the reason they kept using it.

### Pivot Exit Criterion

A developer installs the MCP server, runs two Claude Code sessions on the same repo, and the second session correctly recalls a decision made in the first — cited, sourced, and without the developer doing anything manually.

---

## Post-Pivot (Future, Not Planned)

The following are identified but not scoped:

- Enterprise SSO and fine-grained permission mirroring from source systems
- Confidence scoring and contradiction arbitration model
- Automated agent instrumentation (no explicit log emission required)
- API for third-party tool integration
- Analytics dashboard: brain usage, anomaly hit rate, context acquisition time metrics
- Live meeting integration (real-time transcription via Zoom/Google Meet SDK)
