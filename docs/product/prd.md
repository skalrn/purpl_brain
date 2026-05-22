# Product Requirements Document — Project Brain

**Status:** Draft  
**Version:** 0.1  
**Last Updated:** 2026-05-22  
**Author:** Deepak Kollipalli  

---

## 1. Problem Statement

AI coding agents (Claude Code, Cursor, GitHub Copilot, Aider, custom MCP clients) start every session from zero. The agent has no awareness of what was decided last week, what libraries were already evaluated and rejected, or what architectural constraints the project operates under. Each session re-derives context from scratch — often contradicting decisions that the same agent (or a different agent, or the human) already made in a prior session.

The standard workaround is for the developer to act as a human memory bus: re-pasting the same paragraph of project context at the start of every session. This is manual, error-prone, and does not scale across multiple repos or multiple weeks. The agent decision history, even when the developer approves and acts on it, dies in the session transcript.

Purpl Brain solves this by being the persistent memory layer that agents write to at session end and read from at session start, with citations to source signals and a structured decision schema.

The problem is acute for:
- Individual developers and small teams (2–8 engineers) running multiple AI agent sessions per day across one or more repos
- Platform engineering teams running automated agents (CI bots, dependency-update agents, code-review agents) whose decisions need to be auditable
- Anyone whose AI agent decisions currently die at session end with no path to inherit them in the next session

## 2. Goals

- Enable any actor — human or agent — to reach productive context on any task in under 60 seconds
- Capture AI agent decisions as first-class knowledge, persisted across sessions
- Detect and surface plan drift and impact of changes proactively and on-demand
- Support multi-product teams with cross-product knowledge transfer

## 3. Non-Goals (v1)

- Not a project management tool — does not replace Jira, Linear, or GitHub Issues
- Not a communication tool — does not replace Slack or meeting software
- Not a code editor or IDE — does not replace Cursor or Copilot
- Enterprise SSO and fine-grained permission mirroring (SAML, SCIM, per-channel ACL inheritance) are out of scope
- Multi-region deployment (data residency, region-pinned brain stores) is out of scope
- Real-time collaboration features (live cursors, co-editing, multi-user simultaneous query) are out of scope
- Mobile clients are out of scope

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

Post-pivot, the primary metrics measure the agent memory loop. Human-side metrics are retained as secondary indicators.

**Agent memory loop (primary):**

| Metric | Target |
|---|---|
| Agent session write-back rate | ≥ 80% of agent sessions in active repos call `POST /brain/agent-log` at session end |
| Agent query hit rate | ≥ 70% of MCP `brain_query` calls return at least one citation (i.e., the brain had relevant prior context) |
| Agent decision retention | A decision recorded in session N is retrievable via `brain_query` in session N+1 in ≥ 95% of cases (measured by the agent-log round-trip eval) |
| Agent contradiction rate | < 10% of resumed sessions contradict a prior decision without the drift detector flagging it |

**Human surface (secondary):**

| Metric | Target |
|---|---|
| Context acquisition time | Measured via user survey; target < 60 seconds for returning users |
| Anomaly detection precision | > 70% of proactive alerts rated as useful by recipient |
| Source coverage | At least 1 ingestion source (GitHub) active per repo; multi-source is bonus, not required |
| Trusted user retention | > 50% of beta users run an MCP-backed agent session at least weekly |

## 8. Risks

### R1 — Write-back adoption: the brain is only as good as what agents write into it

**Risk:** The entire value proposition depends on agents calling `brain_log_decision` at session end. If they don't — because the developer skips it, the session ends abruptly, or the tool isn't installed — the brain stays empty. An empty brain returns nothing from `brain_query`, which makes the product look broken to a new user even when the infrastructure is working correctly. Research on multi-agent failure modes confirms this: the coordination and specification layer (which purpl-brain lives in) accounts for the majority of failures, but it only helps if it is consistently populated.

This risk has two distinct failure modes that require separate mitigations:

**Failure mode A — Trigger discipline:** the agent does not call the tool at all.

**Failure mode B — Content quality:** the agent calls the tool but logs noise (no rationale, trivial decisions, missing alternatives) or misses the decisions that matter most. A brain full of low-signal entries is nearly as useless as an empty one, and harder to diagnose.

Note on timing: end-of-session logging compounds failure mode B. By session end, the agent's context is compressed and the reasoning behind early decisions may be unrecoverable. Mid-session logging ("log the moment a decision is made") preserves the *why* while it is still explicit. CLAUDE.md enforces this, but it only applies when the agent reads and follows it.

**Mitigations for failure mode A (trigger discipline):**

| Mitigation | Agent scope | Status |
|---|---|---|
| CLAUDE.md instruction — log mid-session immediately on each significant decision | Claude Code only | ✓ shipped |
| `.cursor/rules/brain-protocol.mdc` — same instruction layer for Cursor | Cursor only | ✓ shipped |
| Stop hook (`.claude/hooks/check-brain-decisions.sh`) — queries Neo4j at session end, exits 2 + stderr if no decisions logged in 2 hours, feeds warning back to Claude for one more turn | Claude Code only | ✓ shipped |
| `BrainCallbackHandler` — LangGraph `BaseCallbackHandler` that calls `session.flush()` on `on_chain_end` and `on_chain_error` | LangGraph | ✓ shipped |
| `BrainSession` context manager — `__exit__` calls `flush()` on normal exit and exceptions | ADK / plain Python | ✓ shipped |
| Beta onboarding flow — seeds the brain with one manual decision log before the first agent session | All agents | not yet |
| "Brain health" UI indicator (`last_write: 3 days ago, 0 decisions this week`) | All agents | not yet |
| Periodic digest ("your brain hasn't received a new decision in 5 days") | All agents | not yet |

Note: Cursor has no hook system. The schema validation gate (failure mode B) is the only automated enforcement for Cursor sessions. The `.cursor/rules` file is instruction-only.

**Mitigations for failure mode B (content quality):**

| Mitigation | Status |
|---|---|
| Schema validation gate on `POST /brain/agent-log`: 422 with structured `violations[]` per decision when `rationale` is empty, `description` < 20 chars, or `work_completed` < 10 chars | ✓ shipped |
| `warnings[]` in 202 response for decisions missing `alternatives_considered` — accepted but flagged for improvement | ✓ shipped |
| Re-derivation heuristic in CLAUDE.md: *"If session N+1 starts cold, would not knowing this cause re-derivation or a conflicting choice?"* | ✓ shipped (in CLAUDE.md) |
| Auto-extraction fallback: if no decision logged in a session where file changes occurred, run transcript extraction at `confidence: "low"` | not yet |

**Pre-beta scope (decided 2026-05-21):** Onboarding seed ships before beta (cold-start experience). `BrainHealthBadge` ships as part of the UI build (already specced in UI plan). Periodic digest and auto-extraction fallback are deferred post-beta — scope them after beta teams confirm the pain.

**Owner:** ✓ Core mitigations shipped as of 2026-05-22.

---

## 9. Open Questions

- **Permissions model:** How strictly should we mirror source system permissions at launch? Full mirroring is correct but complex. Initial POC may use project-level access control only.
- **Agent identity:** How do we authenticate agents writing to the brain? API key per agent instance vs. OAuth?
- **Contradiction resolution:** When sources conflict, who arbitrates? Current plan: flag and cite both, let the user decide. Consider a confidence scoring model later.
- **Meeting ingestion:** Which meeting transcription service do we integrate first? Otter.ai and Fireflies both have APIs; Zoom AI transcripts are accessible via Zoom webhooks.
- **Slack integration scope:** Full channel history import at setup, or forward-only from integration date?
