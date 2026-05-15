# Product Requirements Document — Project Brain

**Status:** Draft  
**Version:** 0.1  
**Last Updated:** 2026-05-15  
**Author:** Deepak Kollipalli  

---

## 1. Problem Statement

Software teams lose disproportionate time to context reconstruction — rebuilding understanding of current state, prior decisions, and forward plan every time a human or AI agent switches tasks. This information exists but is fragmented across meetings, Slack, tickets, PRs, and AI agent sessions. No existing tool synthesizes it into a queryable, always-current working memory.

The problem is acute for:
- Small teams running multiple products in parallel with AI-assisted development
- Floating specialists who work part-time across multiple codebases
- AI codegen agents whose session-scoped decisions evaporate on session end

## 2. Goals

- Enable any actor — human or agent — to reach productive context on any task in under 60 seconds
- Capture AI agent decisions as first-class knowledge, persisted across sessions
- Detect and surface plan drift and impact of changes proactively and on-demand
- Support multi-product teams with cross-product knowledge transfer

## 3. Non-Goals (v1)

- Not a project management tool — does not replace Jira, Linear, or GitHub Issues
- Not a communication tool — does not replace Slack or meeting software
- Not a code editor or IDE — does not replace Cursor or Copilot
- Not an enterprise compliance or audit system
- Real-time collaboration features (live cursors, co-editing) are out of scope
- Mobile clients are out of scope for Phase 1 and 2

## 4. User Personas

See [personas.md](personas.md) for full detail.

| Persona | Type | Primary Need |
|---|---|---|
| Context Switcher | Human (engineer) | Resume tasks instantly after interruption |
| Floating Specialist | Human (domain expert) | Expertise-scoped view across products |
| AI Agent | Non-human actor | Persistent memory across sessions |
| Tech Lead / PM | Human (manager) | Plan state awareness and anomaly alerting |

## 5. Core Features

### F1 — Multi-Source Ingestion

The brain ingests from the following surfaces. Each is a first-class source.

**Human-generated:**
| Source | Signals Ingested |
|---|---|
| GitHub / GitLab | PRs (title, description, review comments, merge decisions), Issues, commit messages |
| Jira / Linear | Ticket lifecycle: creation, status changes, comments, priority changes, sprint moves |
| Slack / IM | Threads, decisions, pinned messages, channel-scoped discussions |
| Meetings | Transcripts, summaries, action items (via integration with Otter, Fireflies, or Zoom AI) |

**Agent-generated (first-class):**
| Source | Signals Ingested |
|---|---|
| Codegen agent sessions | Decision logs: choices made, alternatives rejected, rationale |
| Agent session boundaries | Structured summary: what was built, what is unresolved, what comes next |

**Requirements:**
- Ingestion must be event-driven (webhook or polling fallback), not batch
- Each ingested item must carry: source, timestamp, author (human or agent ID), project/product association
- Ingestion must be idempotent — re-processing the same event must not create duplicates

### F2 — Incremental Brain Update

The brain is a continuously maintained knowledge state, not a static document store.

**Requirements:**
- New signals update existing beliefs, they do not simply append
- Contradictions between sources are flagged with confidence scores and source citations, not silently overwritten
- The brain maintains temporal versioning: "current plan" is distinct from "plan as of [date]"
- All updates are traceable to their source event

### F3 — Natural Language Query Interface (NotebookLM-style)

Users and agents query the brain in natural language. All answers are grounded and cited.

**Query modes:**
- **Project-scoped:** *"What is the current state of the auth module in Product A?"*
- **Temporal:** *"What changed in the last 5 days on this project?"*
- **Expertise-scoped (specialist view):** *"Show me all open decisions touching payments across all active products."*
- **Agent resume:** *"What decisions did the agent make in its last session on this module, and where did it stop?"*

**Requirements:**
- Every answer must cite the source (meeting timestamp, Slack thread URL, PR link, agent session ID)
- No answer is generated without grounding — the system must not hallucinate context
- Query latency target: under 5 seconds for standard queries
- Interface must be accessible via: web chat UI, API (for agents), MCP server endpoint

### F4 — Agent Write-Back Loop

AI agents emit structured decision logs to the brain at session boundaries.

**Requirements:**
- A standard decision log schema must be defined and published (see Technical Architecture)
- Agents emit logs via the same API used for queries — unified interface
- Decision logs include: task context, decisions made (with rationale), alternatives considered, unresolved questions, recommended next steps
- The brain associates agent logs with the relevant project, codebase, and ticket

### F5 — Impact Analysis and Anomaly Detection

**Proactive (system-initiated):**
- The brain monitors for plan drift: a Slack decision contradicting a Jira ticket, a PR touching code a concurrent ticket is also modifying, a new scope item contradicting a prior architectural decision
- Alerts are surfaced via the query interface and optionally via Slack notification or email digest
- Alert threshold is configurable per project

**Reactive (human or agent-invokable):**
- After any event (meeting, Jira update, merged PR, agent session), a user or agent can trigger: *"What does this change affect across the current plan?"*
- The analysis returns: affected tickets, affected decisions, affected agents or work streams, recommended actions

**Requirements:**
- Proactive anomaly detection runs within 5 minutes of an ingested event
- Impact analysis must cite every affected item with its source
- False positive rate must be low enough that alerts are trusted — tuning mechanism required

### F6 — Multi-Product Graph

The brain maintains isolated namespaces per product but models cross-product relationships.

**Requirements:**
- Each project/product/codebase has its own namespace
- Cross-product edges are created when: shared team members make decisions across products, the same library or component is referenced, analogous problems are detected
- Cross-product queries are opt-in per user — specialists enable them, regular engineers default to project scope

## 6. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Query latency (p95) | < 5 seconds |
| Ingestion lag (event → brain update) | < 5 minutes |
| Brain update consistency | Eventual, with conflict flagging |
| Uptime (POC phase) | Best-effort; no SLA |
| Data retention | Configurable per project; default 12 months |
| Auth | OAuth 2.0 for all source integrations; JWT for API |
| Privacy | Per-user permission model mirrors source system permissions (e.g., private Slack channels require membership) |

## 7. Success Metrics

| Metric | Target (6-month POC) |
|---|---|
| Context acquisition time | Measured via user survey; target < 60 seconds for returning users |
| Agent session continuity | Agent contradicts prior session decisions in < 10% of resumed sessions |
| Anomaly detection precision | > 70% of proactive alerts rated as useful by recipient |
| Source coverage | At least 2 ingestion sources active per project |
| Trusted user retention | > 80% of POC users query the brain at least weekly |

## 8. Open Questions

- **Permissions model:** How strictly should we mirror source system permissions at launch? Full mirroring is correct but complex. Initial POC may use project-level access control only.
- **Agent identity:** How do we authenticate agents writing to the brain? API key per agent instance vs. OAuth?
- **Contradiction resolution:** When sources conflict, who arbitrates? Current plan: flag and cite both, let the user decide. Consider a confidence scoring model later.
- **Meeting ingestion:** Which meeting transcription service do we integrate first? Otter.ai and Fireflies both have APIs; Zoom AI transcripts are accessible via Zoom webhooks.
- **Slack integration scope:** Full channel history import at setup, or forward-only from integration date?
