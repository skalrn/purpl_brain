# Technical Spec — Anomaly Engine

**Status:** Draft  
**Version:** 0.1  
**Last Updated:** 2026-05-15  

---

## Overview

The anomaly engine detects when reality is diverging from plan — before a human has to notice it manually. It runs in two modes: proactively after every ingestion event, and reactively on human or agent demand.

**Primary design constraint: precision over recall.** Alert fatigue is the product-killer. One week of noisy alerts trains users to ignore the channel permanently. Every design decision optimizes for trusted alerts over comprehensive detection.

---

## Anomaly Taxonomy

Each type has a distinct detection mechanism and severity profile. Do not treat them uniformly.

| Type | Trigger | Example |
|---|---|---|
| `decision_contradiction` | New Decision node created | "Use JWT" conflicts with existing "Use session cookies" for same scope |
| `implementation_mismatch` | PR merged | PR implements long-lived tokens; Decision node requires short-lived for that module |
| `concurrent_modification` | New PR opened | PR #234 and PR #238 both modify `auth/token.py` |
| `orphaned_decision` | Scheduled scan (daily) | Decision made 14+ days ago with no implementing ticket or PR |
| `stale_state` | Scheduled scan (daily) | Ticket "in progress" 14+ days with no PR activity |
| `scope_creep` | Ticket added to sprint | New ticket added mid-sprint not in original plan |
| `silent_plan_change` | Jira status change | Ticket moved to "Won't Fix" with no Decision node explaining why |

---

## Anomaly Record Schema

```json
{
  "anomaly_id": "uuid",
  "type": "decision_contradiction | implementation_mismatch | concurrent_modification | ...",
  "severity": "high | medium | low",
  "detected_at": "ISO 8601",
  "trigger_event_id": "ingestion event that caused detection",
  "nodes_involved": ["node_id_A", "node_id_B"],
  "description": "PR #234 implements long-lived JWTs (7-day expiry). Decision PROJ-412-d1 requires short-lived tokens (15-min expiry) for the auth module.",
  "evidence": [
    {
      "node_id": "PROJ-412-d1",
      "quote": "Use short-lived JWTs, compliance requires it",
      "source_url": "slack://thread/C04XYZ/1715123456",
      "timestamp": "2026-05-10T14:32:00Z",
      "confidence": "high"
    },
    {
      "node_id": "pr-234-d1",
      "quote": "Token expiry set to 7 days for user convenience",
      "source_url": "https://github.com/org/repo/pull/234#discussion_r123",
      "timestamp": "2026-05-14T09:15:00Z",
      "confidence": "medium"
    }
  ],
  "recommended_action": "Clarify token expiry requirement with compliance team before merging PR #234.",
  "severity_rationale": "Both decisions overlap in scope (auth module). Source decision is high-confidence with explicit compliance rationale.",
  "status": "open | acknowledged | resolved | false_positive",
  "user_feedback": null
}
```

`evidence` with direct quotes is mandatory. An alert without supporting text forces the user to dig through sources themselves — defeating the purpose.

---

## Architecture: Proactive vs. Reactive

These are separate code paths.

```
PROACTIVE (async, non-blocking)
────────────────────────────────────────────────
Ingestion event
    → Processing pipeline completes
    → Brain store updated
    → Anomaly engine trigger enqueued (Redis Streams)
    → Async worker picks up trigger
    → Run detectors relevant to event type
    → Generate anomaly records
    → 15-minute digest batch
    → Alert surface (UI notification + optional Slack DM)


REACTIVE (sync, on-demand, < 5s)
────────────────────────────────────────────────
POST /brain/impact-analysis { event_id, depth_limit }
    → Graph BFS from starting node
    → Score and rank affected nodes
    → Return impact list with dependency paths
```

The proactive path must not block ingestion. The 15-minute digest batching is mandatory — never alert on individual anomaly detection. Batching groups related anomalies, gives self-resolving anomalies time to resolve, and prevents the alert channel from becoming noise.

---

## Detector Implementations

### Decision Contradiction Detector

Triggered by: new Decision node created.

```
1. Embed new decision description
2. Vector search: top-10 semantically similar Decision nodes
   (filter: same project_id, confidence >= medium, status != superseded)
3. For each candidate:
   a. Check scope overlap: do scopes reference the same concept/module?
      If no overlap → skip (fast path, no LLM call)
   b. If scope overlaps:
      LLM call (Haiku — cheap): "do these two decisions conflict?"
      Input: decision_A.description + decision_A.scope
             + decision_B.description + decision_B.scope
      Output: { conflicts: bool, reason: str, severity: high|medium|low }
   c. If conflicts=true:
      Create `contradicts` edge in graph
      Generate anomaly record
4. Also check: does new decision match any alternatives_considered[]
   in existing agent-sourced Decision nodes?
   (deterministic lookup — no LLM needed)
```

Scope overlap check before LLM call reduces LLM invocations by ~70%. Two decisions about different modules cannot contradict.

The agent alternatives check is unique value: if an agent explicitly rejected "long-lived tokens" and a human later decides to use them, semantic similarity may miss this (different phrasing). The structured agent log makes it a deterministic lookup.

### Implementation Mismatch Detector

Triggered by: PR merged event.

```
1. Extract files_modified[] from PR event
2. Map file paths → concept nodes using module-concept config
   (e.g., "auth/**" → Concept("auth"), "payments/**" → Concept("payments"))
3. Graph lookup: Decision nodes tagged_with those concepts, status != superseded
4. For each relevant Decision node:
   LLM call: "Does this PR implement or contradict this decision?"
   Input: PR description + key review comments (top 3 by reaction count)
          + decision.description + decision.rationale
   Output: { consistent: bool, reason: str }
5. If inconsistent: generate implementation_mismatch anomaly
```

**Module-concept config** (defined at project setup, stored per project):
```json
{
  "module_map": {
    "auth/**": ["auth", "security", "JWT", "session"],
    "payments/**": ["payments", "billing", "stripe"],
    "api/**": ["API", "REST", "endpoints"]
  }
}
```

For Phase 1 (GitHub only): require explicit module map at project setup. Inference from PR history deferred to Phase 3.

### Concurrent Modification Detector

Triggered by: new PR opened. The only detector that fires on PR *open*, not merge.

```
1. Extract files_modified[] from new PR
2. Graph query: all open PRs (state="open") with overlapping files_modified[]
   (set intersection on file paths)
3. If overlap found:
   Generate concurrent_modification anomaly
```

Severity upgrade: if the concurrent PRs are both linked to Decision nodes for the same concept, check for `contradicts` edge between those decisions. If contradiction exists → severity = high.

This is genuinely novel — no existing tool detects this predictively (GitHub detects merge conflicts after the fact, not concurrently open PRs targeting the same code).

### Orphaned Decision (Scheduled)

Runs daily. Finds Decision nodes with no implementing ticket or PR.

```
Graph query: Decision nodes WHERE:
    - created_at < (now - 14 days)
    - confidence >= medium
    - no outgoing `implements` or `references` edges to Ticket or PR nodes
    - no `supersedes` outgoing edge (not already replaced)
```

These decisions were made but never acted on. High-value anomaly for tech leads — surface as low severity (informational) rather than urgent.

### Stale State (Scheduled)

Runs daily. Finds tickets stuck in active states with no activity.

```
Graph query: Ticket nodes WHERE:
    - status IN ("in_progress", "in_review")
    - last_updated < (now - 14 days)
    - no PR node with created_at > (now - 14 days) linked via `implements`
```

Severity: medium if the ticket is on the current sprint; low otherwise.

---

## False Positive Control

This is the most important design area. Four mechanisms:

### 1. Confidence Gating

Only generate an anomaly if both involved nodes have `confidence >= medium`. Low-confidence suggestions contradicting high-confidence decisions are noise.

```python
if node_A.confidence == "low" or node_B.confidence == "low":
    skip  # do not generate anomaly
```

### 2. Recency Weighting

A decision made 6 months ago being "contradicted" by a new one is probably intentional evolution. Apply severity decay:

```python
older_node_age_days = (now - min(node_A.created_at, node_B.created_at)).days

if older_node_age_days < 30:
    recency_factor = 1.0
elif older_node_age_days < 90:
    recency_factor = 0.7
else:
    recency_factor = 0.4

final_severity_score *= recency_factor
```

### 3. Supersession Check

Before flagging any contradiction: does the older node already have an outgoing `supersedes` edge? If yes, the contradiction is resolved — skip. This requires the `supersedes` edge to be created whenever a team explicitly replaces a decision.

### 4. Digest Batching

Never alert per-anomaly. Rules:
- Batch window: 15 minutes per project
- Max anomalies per digest: 3 (queue remainder for next window)
- Related anomalies (same nodes involved) → merge into one record
- Anomalies that get a `supersedes` edge within the batch window → drop from digest

### 5. User Feedback Loop

Every anomaly surfaces two buttons: **Relevant** / **Not relevant**.

```python
# Track per detector per project
false_positive_rate = false_positives / total_alerts  # rolling 30-day window

if false_positive_rate > 0.4:
    # auto-reduce severity for this detector in this project
    detector.severity_floor[project_id] = "low"
    # notify project admin: "anomaly detector X has high false positive rate, 
    #                        consider tuning the threshold"
```

At > 40% false positive rate for a specific detector in a specific project, that detector's output is demoted to low severity until a human re-tunes it. This prevents systematic noise sources from destroying trust.

---

## Severity Scoring Matrix

Severity computed from four factors, scored 1-3 each:

| Factor | 3 (High) | 2 (Medium) | 1 (Low) |
|---|---|---|---|
| Decision confidence | Both nodes high | One high, one medium | Both medium |
| Scope breadth | Cross-module / architectural | Single module | Single function |
| Recency | Both nodes < 7 days | One node < 30 days | Both nodes > 30 days |
| Affected actors | Multiple people with in-flight work | One person | No active assignees |

**Sum → severity:**
- 10–12: High (include in next digest, top slot)
- 6–9: Medium (include in digest)
- < 6: Low (log only, visible if queried, not in digest)

---

## Reactive Impact Analysis

`POST /brain/impact-analysis`
```json
{
  "event_id": "pr-234",
  "depth_limit": 3
}
```

**BFS traversal:**
```
Starting node: pr-234
    ↓ (1 hop — direct)
implements → Ticket PROJ-412
affects    → Concept("auth"), Codebase("api-service/auth/")
    ↓ (2 hops — indirect)
Concept("auth") → tagged_with ← Ticket PROJ-389 (open, in progress, owner: bob)
                             ← Decision("all services use centralized auth")
                             ← AgentSession(session-789)
    ↓ (3 hops — transitive)
Ticket PROJ-389 → blocked_by → Ticket PROJ-401
Decision("centralized auth") → referenced_by → Epic PROJ-450
```

**Response:**
```json
{
  "starting_node": "pr-234",
  "impact_summary": "PR #234 directly implements PROJ-412 and affects the auth module. Indirectly impacts 2 open tickets (PROJ-389, PROJ-401), 1 active agent session, and touches a prior architectural decision about centralized auth.",
  "affected_nodes": [
    {
      "node_id": "PROJ-389",
      "type": "ticket",
      "hop_distance": 2,
      "impact_level": "medium",
      "dependency_path": "PR #234 → affects Concept(auth) → tagged_with Ticket PROJ-389",
      "status": "in_progress",
      "owner": "bob"
    }
  ],
  "cited_sources": [...]
}
```

`dependency_path` is the citation for impact analysis — it shows exactly how the starting node connects to each affected node. Without this, the user cannot evaluate whether the impact is real or a spurious graph connection.

---

## Scaling Path

The decision contradiction detector runs an LLM call at write time. At POC scale this is acceptable. The graduation path:

| Phase | Approach |
|---|---|
| Phase 1–2 | LLM-based contradiction detection (Haiku — fast, cheap) on every new Decision node |
| Phase 3 | Train lightweight binary classifier on LLM outputs to replace it for clear cases; LLM only for uncertain boundary cases |
| Phase 4 | Deterministic detection for agent-sourced decisions (structured schema, no LLM needed) |

Do not over-engineer Phase 1. The LLM approach is correct at POC scale. The scaling problem only appears at > 500 Decision nodes/day sustained ingest rate.

---

## Open Questions

- Should the digest be delivered via Slack DM, email, or only surfaced in the UI? For POC: UI only. Slack integration after Phase 3.
- What is the right default for `stale_state` threshold — 14 days or configurable per project? Start at 14 days, make configurable in Phase 3.
- Should reactive impact analysis be synchronous (< 5s) or support async with a webhook callback for large graphs with deep traversal? Synchronous with depth_limit=3 is sufficient for POC. Async pattern needed if depth > 3 is required.
- How do we handle anomalies that span multiple projects (cross-product contradiction)? Deferred to Phase 4 when multi-product graph is implemented.
