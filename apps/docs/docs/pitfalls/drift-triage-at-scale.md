---
sidebar_position: 3
---

# Drift Triage at Scale

## The triage math

Drift detection sounds straightforwardly useful until you work out the triage volume at realistic production scale.

Assumptions: 10 active agents, 200 decisions/day across all agents, drift detection precision of 89% (confirmed genuine conflicts / total alerts generated).

At a `DRIFT_SEMANTIC_THRESHOLD` of 0.55 (the original default):
- Stage A candidates per day: approximately 60-80 (too many semantically similar pairs at low threshold)
- LLM confirmation rate (Stage C precision at this threshold): ~60-65%
- Confirmed alerts per day: 36-52
- Triage time per alert: 2 minutes (reading both decisions, understanding the conflict, making a resolution)
- **Total daily triage burden: 72-104 minutes per developer**

That is unsustainable. Developers who spend more than 30 minutes per day on drift triage start dismissing alerts without reading them. Once they dismiss a few alerts and nothing bad happens, they dismiss all alerts permanently. The alert channel becomes noise.

## Why the threshold was raised

Raising `DRIFT_SEMANTIC_THRESHOLD` from 0.55 to 0.72 was the most impactful single change to the drift detector. At 0.72:

- Stage A candidates per day: approximately 20-25
- LLM confirmation rate (Stage C precision at 0.72): ~89%
- Confirmed alerts per day: 15-22 (but typically 5-10 genuine high-severity ones)
- Triage time per alert: 2 minutes
- **Total daily triage burden: 30-44 minutes** — borderline sustainable

The candidates that are filtered out by raising the threshold from 0.55 to 0.72 are overwhelmingly false positives: decisions that use similar technical vocabulary (both mention Redis, both mention caching) but are not actually in conflict. These false positives were training users to ignore the alert channel.

The precision improvement at 0.72 is the reason the 15-minute digest batching and severity filtering can do their job. At 0.55, so many candidates survived to the digest that the batching and filtering were overwhelmed.

## The grouping problem (deferred)

Even at 0.72 threshold, a single architectural decision flip can generate many drift alerts — one per existing decision that the new decision contradicts. If an agent decides to switch from REST to GraphQL across a service boundary, and there are 15 prior decisions referencing REST endpoints for that service, the drift detector may generate 15 alerts.

The right response is to group these into a single alert: "New decision contradicts 15 prior decisions about API style in the payments service." The grouped alert is triaged once. Fifteen individual alerts are triaged fifteen times, or dismissed en masse.

Alert grouping is deferred post-beta. The implementation requires clustering Stage A candidates by the existing decision they challenge, not by the new decision that triggered detection. It is a moderately complex change to the drift detector's candidate aggregation logic. The pre-beta mitigation is: raise the threshold enough that the absolute volume stays manageable without grouping.

## What happens when users stop reading alerts

The most dangerous state is when drift alerts exist in the system but no developer is reading them. This is worse than having no drift detection at all, because the developer falsely believes contradictions are being caught.

The 15-minute digest batching with a max of 3 alerts per window is a partial mitigation — it caps the alert volume per window. But if the underlying alert generation rate is high enough, the queue backs up and alerts are processed in a later window, potentially hours after the triggering event.

The feedback loop mechanism is the correct long-term answer: track per-detector false positive rate on a rolling 30-day window. If a specific detector in a specific project exceeds 40% false positives, auto-demote its output to low severity. Notify the project admin that tuning is needed. This prevents a single high-noise detector from poisoning the entire alert channel.

## Pre-beta scope

The threshold is 0.72 as of 2026-05-22. This should not be lowered before beta without testing on real production data from beta teams. The 0.55 threshold is documented as the starting point before calibration — it is not a safe default.

If beta teams report missing contradictions that should have been caught, the investigation should start with Stage C (LLM confirmation quality) before lowering the threshold. A false negative at Stage C (LLM says "no conflict" when there is one) is a prompt quality problem, not a threshold problem. Lowering the threshold to catch more Stage C inputs will also increase the false positive rate, recreating the triage burden.
