# Drift Detection Workflow

**Status:** Current  
**Version:** 1.0  
**Last Updated:** 2026-06-03

---

## Overview

Drift detection is the process by which purpl-brain identifies when new information contradicts an existing confirmed decision and surfaces that contradiction to the team before it becomes a silent assumption mismatch in code.

There are two entry points — the **pipeline path** (automatic, for streaming signals) and the **signal path** (explicit, for agent-reported findings). Both paths converge on the same two-stage detection mechanism and write the same `DriftAlert` graph node.

---

## Entry Points

### Path 1 — Pipeline (automatic, streaming)

Every event ingested through the main pipeline reaches the drift-detector worker after extraction.

```
Source event (Slack / meeting / Jira / agent)
  └──▶  events:raw  ──▶  normalizer
                    ──▶  events:normalized  ──▶  extractor
                                            ──▶  events:extracted  ──▶  drift-detector
```

The drift-detector consumes `events:extracted` via a Redis Streams consumer group (`group: "drift-detector"`). It runs on every extracted event but immediately skips two source types:

- **GitHub events** — skipped to reduce false positives from PR debate (reviewers raising concerns, back-and-forth on approach) which is expected discourse, not contradiction
- **Document events** — skipped because bulk doc ingest causes non-deterministic races where doc chunks drift-check against each other mid-ingest

Sources that **do** run through drift detection: `slack`, `meeting`, `jira`, `agent`.

### Path 2 — Explicit signal (`brain_log_signal` / `POST /brain/signals`)

An agent or human explicitly reports an observation that may contradict a past decision. This bypasses the pipeline entirely — the signal text is processed synchronously by the **signal engine** and a response is returned immediately.

```
brain_log_signal("Redis hit 12% eviction in a burst test — may contradict our caching strategy")
  └──▶  POST /brain/signals  ──▶  signal-engine  ──▶  DriftAlert (if conflict confirmed)
```

The signal is **not stored as a canonical event** — it is ephemeral input that triggers detection. If the finding represents a real decision, callers should use `brain_log_decision` or the meeting transcript endpoint instead.

The signal engine uses a slightly higher relevance threshold than the pipeline (0.60 vs 0.55) because explicit signals are typically direct and specific — a lower threshold would produce too many spurious matches on short, focused observations.

---

## Two-Stage Detection

Both paths use the same two-stage mechanism.

### Stage A — Semantic candidate retrieval

The incoming text is embedded using `nomic-embed-text:v1.5` (via Ollama) and searched against Qdrant, filtered to:

1. The current `project_id` (tenant isolation)
2. Only chunks where `has_decisions = true` (only chunks sourced from confirmed-decision events)

Qdrant returns up to `TOP_K × 4` candidates (over-fetched to allow filtering). Any chunk scoring below the threshold is dropped. The matching chunk `graph_node_id` values are collected and looked up in Neo4j to retrieve the `Decision` nodes extracted from those events.

Only decisions with `status = "confirmed"` that have **not** been superseded (`NOT (d)<-[:SUPERSEDES]-()`) are returned as candidates.

**Thresholds:**

| Path | Parameter | Default |
|---|---|---|
| Pipeline drift-detector | `DRIFT_SEMANTIC_THRESHOLD` | 0.55 |
| Signal engine | `SIGNAL_RELEVANCE_THRESHOLD` | 0.60 |

### Stage C — LLM confirmation

The candidates are sent to the LLM (Claude Haiku 4.5 / Ollama fast model) with a classification prompt:

```
For each candidate decision, classify the incoming signal as one of:
- "conflicts": contradicts or challenges the decision
- "confirms": consistent with or reinforces the decision
- neither: unrelated or routine
```

The LLM returns a JSON object with `drifts` and `confirms` arrays. Only LLM-confirmed conflicts (`drifts`) create `DriftAlert` nodes. Confirmations are stored as resolved alerts with `resolution: "confirms"` for audit purposes — they do not appear in the active alert inbox.

**Why two stages:** Semantic similarity alone cannot distinguish a decision from its reversal. "Use Redis for caching" and "Don't use Redis for caching" score high similarity against each other. Stage A narrows the field cheaply; Stage C makes the actual conflict/confirmation call with reasoning.

---

## Alert Creation

When Stage C confirms a conflict, a `DriftAlert` node is written to Neo4j:

```cypher
MERGE (a:DriftAlert {fingerprint: $fingerprint})
ON CREATE SET
  a.alert_id        = $alert_id,
  a.event_id        = $event_id,    -- the challenging event
  a.source          = $source,
  a.content         = $content,     -- truncated to 500 chars
  a.reason          = $reason,      -- one-sentence LLM explanation
  a.actor           = $actor,
  a.timestamp       = $timestamp,
  a.confirmed_by_llm = true,
  a.resolution      = "pending",
  a.project_id      = d.project_id
MERGE (a)-[:CHALLENGES]->(d)        -- edge to the challenged Decision node
```

**Fingerprint deduplication:** The fingerprint is `SHA-256(decision_id + content[:200])`. The same observation cannot create duplicate alerts against the same decision — `MERGE ON CREATE` is a no-op if the fingerprint already exists.

**Webhook notification:** If `DRIFT_WEBHOOK_URL` is set, the brain immediately POSTs a notification payload to that URL (fire-and-forget, non-fatal on failure):

```json
{
  "alert_id": "...",
  "project_id": "...",
  "risk": "high",
  "challenged_decision_id": "...",
  "challenged_decision_summary": "...",
  "challenging_content": "...(truncated to 300 chars)",
  "reason": "one-sentence LLM explanation",
  "actor": "...",
  "timestamp": "..."
}
```

This is the real-time coordination primitive for parallel agent workflows — a coordinator agent or Slack channel can receive the alert while the contradiction is still cheap to resolve.

---

## How Agents See Alerts

Agents do not receive push notifications by default. They encounter open alerts on two query paths:

**`brain_query`** — The query response includes open drift alerts in the context passed to the LLM, so cited answers surface relevant alerts inline.

**`brain_analyze_impact`** — Decisions with open drift alerts are floored to `risk: "high"` regardless of LLM assessment. An agent checking impact before a change will see the alert as an explicit risk flag:

```
Brain: risk=high · cache-001: Redis caching adopted 3 weeks ago [agent session]
       ⚠ 1 open drift alert — Redis hit 12% eviction in burst test (SRE via Slack)
```

**`GET /brain/drift-alerts?project_id=<id>`** — Direct API call returns all pending alerts for a project. The web UI polls this endpoint to populate the drift inbox.

---

## Resolution

A human or orchestrator resolves an alert via:

```
POST /brain/drift-alerts/:alert_id/resolve
{
  "resolution": "keep" | "under_review" | "reopen" | "escalate",
  "resolution_reason": "optional free text"
}
```

**Resolution semantics:**

| Resolution | Meaning | Effect on Decision node |
|---|---|---|
| `keep` | Alert is acknowledged; decision stands as-is | No change to `d.status` |
| `under_review` | Team is actively evaluating the decision | `d.status → "under_review"` |
| `reopen` | The decision has genuinely changed | `d.status → "changed"` + FollowUpTask created |
| `escalate` | A confirmation (`confirms`) is actually a conflict — escalate for review | `a.resolution → "pending"` (moves it back into the active inbox) |

**`reopen` creates a FollowUpTask** — when a decision is marked changed, the brain automatically creates a `FollowUpTask` node linked to the alert. The task appears in `GET /brain/tasks?project_id=<id>` with `requires_approval: true`. Tasks are not auto-executed — they are surfaced to humans as actionable items.

---

## Superseding a Decision

When an agent logs a new decision that explicitly supersedes an older one (using `SUPERSEDES` in the decision description, or when the graph writer detects SUPERSEDES intent), the brain:

1. Writes a `SUPERSEDES` edge from the newer `Decision` to the older one
2. Auto-resolves all pending `DriftAlert` nodes that were challenging the older decision (`resolution → "superseded"`)

The rationale: once a decision is superseded, its drift alerts are no longer actionable. The contradiction has been resolved by the act of superseding.

---

## Complete Sequence: Slack Signal → Alert → Agent Response

```
1. SRE posts in Slack: "Redis hit 12% eviction in burst test — watch this"
   └──▶  slack-listener → events:raw

2. normalizer: flags as decision_candidate (COMMITMENT_RE pattern matches)
   └──▶  events:normalized

3. extractor: LLM extraction — no concluded decision found (it's an observation)
   └──▶  events:extracted (decision_candidate=true, decisions=[])

4. drift-detector: Stage A — embeds Slack text, searches Qdrant
   Finds: cache-001 ("Adopt Redis as primary caching layer, TTL 60s")
   Score: 0.72 > threshold 0.55

5. drift-detector: Stage C — LLM confirmation
   Verdict: conflicts — "Eviction under burst load challenges the Redis write-through
   decision by suggesting the chosen TTL and tier may not hold under production load"

6. writeDriftAlert(cache-001, "pending")
   CHALLENGES edge written to Neo4j
   Webhook fires to DRIFT_WEBHOOK_URL

7. SecurityAuditAgent starts new session, calls brain_query:
   "What caching decisions have been made?"
   └──▶  query response includes open drift alert inline

8. SecurityAuditAgent calls brain_analyze_impact:
   "Extend Redis TTL to 300s and add eviction-aware backfill"
   └──▶  cache-001 returned with risk=high (open drift alert floor)
          reason: "Eviction finding challenges the 60s TTL decision"

9. SecurityAuditAgent logs a pivot decision:
   brain_log_decision: "Defer TTL extension pending burst test investigation"
   └──▶  new Decision node, no SUPERSEDES yet (deferral, not reversal)

10. Human resolves alert as "under_review":
    POST /brain/drift-alerts/:id/resolve { "resolution": "under_review" }
    └──▶  cache-001.status → "under_review"
           alert removed from pending inbox
```

---

## Configuration Reference

| Environment variable | Default | Effect |
|---|---|---|
| `DRIFT_SEMANTIC_THRESHOLD` | `0.55` | Stage A cosine similarity cutoff (pipeline path) |
| `DRIFT_TOP_K` | `3` | Max candidate decisions passed to Stage C |
| `SIGNAL_RELEVANCE_THRESHOLD` | `0.60` | Stage A cutoff for explicit `brain_log_signal` path |
| `DRIFT_WEBHOOK_URL` | _(unset)_ | HTTP endpoint for real-time alert notifications |

---

## Known Limitations

- **GitHub events are not drift-checked.** A PR that reverses a prior decision does not automatically produce a drift alert. Use `brain_log_signal` to explicitly report PR-vs-decision conflicts, or wire `brain_analyze_impact` into your CI pipeline before merge.
- **Thread replies are not fetched from Slack.** The Slack listener captures top-level messages only. Multi-turn Slack threads where the final resolution contradicts the opening message are partially invisible.
- **Stage A uses event-level proxy scores.** Decisions inherit the cosine score of their source event's chunks, not a per-decision similarity score. A highly relevant chunk from an event with multiple decisions will pull in all decisions from that event, not just the one that semantically matches.
- **The signal path is synchronous.** `POST /brain/signals` blocks until LLM confirmation completes (~1–3s on cloud, ~5–15s on Ollama). It is not suitable for high-throughput signal ingestion.
