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

## Phase 4 — Multi-Product Graph and Specialist View

**Target duration:** 6–8 weeks (after Phase 3 complete)  
**Primary persona:** Floating Specialist

### Scope

**In:**
- Multiple project namespaces in the brain
- Cross-product edge creation: shared team members, shared libraries, analogous decisions
- Expertise-scoped query mode: query by domain across all projects
- MCP server interface (makes the brain natively queryable by Claude, Cursor, and MCP-compatible agents)
- Meeting transcript ingestion (Otter.ai or Fireflies API)

**Out:**
- Self-serve onboarding for new projects (still manual setup)
- Enterprise auth / SSO
- Mobile client

### Key Deliverables
- Multi-tenant namespace model in the brain store
- Cross-product graph edges with relationship type labels
- Expertise-scoped query handler: accepts domain tags, searches across project namespaces
- MCP server: exposes brain query as an MCP resource/tool
- Meeting ingestion pipeline: transcript → decision extraction → brain update

### Phase 4 Exit Criterion
A specialist queries: *"Show me all open auth-related decisions across active products."* The result is accurate, cross-product, and cited. The brain is queryable directly from Claude or Cursor via MCP without the chat UI.

---

## Post-Phase 4 (Future, Not Planned)

The following are identified but not scoped:

- Self-serve project onboarding
- Enterprise SSO and fine-grained permission mirroring from source systems
- Confidence scoring and contradiction arbitration model
- Automated agent instrumentation (no explicit log emission required)
- API for third-party tool integration
- Analytics dashboard: brain usage, anomaly hit rate, context acquisition time metrics
