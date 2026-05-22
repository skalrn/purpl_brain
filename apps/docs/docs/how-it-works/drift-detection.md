---
sidebar_position: 5
---

# Drift Detection

## What drift detection does

When a new decision contradicts a prior one — same agent, different agent, or human — the drift detector creates a `DriftAlert` node and surfaces it to developers before contradictory code lands in production. This is the anomaly engine's most important function.

Alert fatigue is the product-killer. One week of noisy alerts trains users to ignore the channel permanently. The entire design of the drift detector optimizes for precision over recall: a missed contradiction is less damaging than a false positive that causes users to dismiss the alert channel.

## Two-stage detection

**Stage A: cosine similarity via Qdrant**

Every new `ExtractionResult` with extracted decisions triggers Stage A. The new decision text is embedded and searched against existing confirmed Decision nodes in Qdrant. Only nodes within the same `project_id` and with `has_decisions: true` are considered. The similarity threshold is `DRIFT_SEMANTIC_THRESHOLD` (default 0.72).

```typescript
const results = await qdrant.search(COLLECTION, {
  vector,
  limit: TOP_K * 4,  // over-fetch, filter down
  filter: {
    must: [
      { key: "project_id", match: { value: projectId } },
      { key: "has_decisions", match: { value: true } },
    ],
  },
  score_threshold: SEMANTIC_THRESHOLD,
});
```

Stage A produces candidates — events whose embeddings are semantically similar to the new decision. These candidates pass to Stage C.

**Stage C: LLM confirmation**

For each Stage A candidate, a lightweight LLM call asks: "do these two decisions conflict?" The input is the two decision descriptions plus their scopes. The output is `{ conflicts: bool, reason: str, severity: "high"|"medium"|"low" }`.

Stage C is not Stage B — the naming reflects the two-stage design where Stage B (a learned binary classifier) would eventually replace Stage A for clear cases, with LLM only for uncertain boundary cases. At current scale, Stage C runs on all Stage A candidates.

If `conflicts: true`, the detector:
1. Creates a `CHALLENGES` edge in Neo4j between the two Decision nodes
2. Writes a `DriftAlert` node to Neo4j
3. Publishes the alert to `events:drift`

## The threshold was raised from 0.55 to 0.72

The original `DRIFT_SEMANTIC_THRESHOLD` was 0.55. At this threshold, on a realistic production workload of 10 agents making 200 decisions per day, Stage A was producing too many candidates — semantically similar but non-conflicting decisions (e.g., two decisions that both mention Redis but in unrelated contexts). The LLM confirmation rate could not keep up, and confirmed alerts were outpacing developer triage capacity.

The math at scale: 10 agents × 200 decisions/day × false positive rate at 0.55 = 30+ candidates per day needing LLM review, producing 15-30 confirmed alerts per day × 2 minutes per alert = 30-60 minutes of daily triage. That is not sustainable, and developers who cannot keep up with alerts stop reading them.

Raising to 0.72 reduced Stage A candidates significantly while preserving the semantically meaningful conflicts. At 0.72, alerts that reach Stage C are already strong candidates for real contradictions. The precision improvement (89% of confirmed alerts are genuine at 0.72) justifies the recall tradeoff.

## The DriftAlert node schema

```typescript
interface DriftAlert {
  alert_id: string;
  decision_id: string;      // the prior decision being challenged
  event_id: string;         // the new event that triggered the alert
  source: EventSource;      // where the challenging signal came from
  content: string;          // truncated challenging content
  reason?: string;          // LLM one-sentence explanation
  actor: string;            // who authored the challenging signal
  timestamp: string;
  confirmed_by_llm: boolean;
  resolution: "pending" | "keep" | "under_review" | "reopen";
  resolved_at?: string;
}
```

The `reason` field is what the LLM generates in Stage C: a one-sentence explanation of why these two decisions conflict. Without it, a developer seeing a drift alert has to read both decisions and figure out the conflict themselves. The LLM's explanation is the citation for the alert.

## False positive control

Four mechanisms work together:

**Confidence gating:** No alert fires if either involved node has `confidence: "low"`. Low-confidence suggestions conflicting with high-confidence decisions are noise.

**Supersession check:** Before flagging any contradiction, the detector checks whether the older node already has an outgoing `SUPERSEDES` edge. If the older decision was already explicitly replaced, there is no contradiction — skip.

**Recency weighting:** A decision made 6 months ago being "contradicted" by a new one is probably intentional evolution. The severity is decayed based on the age of the older node:

```typescript
if (older_node_age_days < 30) recency_factor = 1.0;
else if (older_node_age_days < 90) recency_factor = 0.7;
else recency_factor = 0.4;
```

**Self-drift exclusion:** The drift detector skips events that generated the Decision nodes themselves (the `excludeEventIds` parameter). Without this, a PR that contains decision language would immediately appear to conflict with itself when it is processed.

## Severity scoring

Four factors scored 1-3 each, summed to a severity bucket:

| Factor | 3 (High) | 2 (Medium) | 1 (Low) |
|---|---|---|---|
| Decision confidence | Both nodes high | One high, one medium | Both medium |
| Scope breadth | Cross-module / architectural | Single module | Single function |
| Recency | Both nodes < 7 days | One node < 30 days | Both nodes > 30 days |
| Affected actors | Multiple people with in-flight work | One person | No active assignees |

Sum 10-12: High. Sum 6-9: Medium. Sum < 6: Low (visible if queried, not in digest).

High severity alerts appear in the 15-minute digest. Low severity alerts are logged and visible in the UI if queried but do not trigger notifications.
