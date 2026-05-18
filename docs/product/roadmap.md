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

## Phase 4 — Document Brain + Cross-Product Graph

**Target duration:** 4–5 weeks (after Phase 3 complete)  
**Primary persona:** Floating Specialist, Context Switcher

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

#### M1 — Document ingestion (2–3 days)
- `POST /ingest/document` REST endpoint (file upload: `.md`, `.pdf`, `.txt`, `.docx`)
- GitHub repo file crawler: scans `docs/**/*.md` at seed time and on push events to `docs/` path
- 512-token sliding window chunking with 20% overlap
- Source type: `"document"`, sub-types: `"adr"`, `"prd"`, `"runbook"`, `"unknown"`
- Exit: query returns a cited answer grounded in an ADR or PRD file

#### M2 — Meeting transcript ingestion (2–3 days)
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

## Post-Phase 4 (Future, Not Planned)

The following are identified but not scoped:

- Enterprise SSO and fine-grained permission mirroring from source systems
- Confidence scoring and contradiction arbitration model
- Automated agent instrumentation (no explicit log emission required)
- API for third-party tool integration
- Analytics dashboard: brain usage, anomaly hit rate, context acquisition time metrics
- Live meeting integration (real-time transcription via Zoom/Google Meet SDK)
