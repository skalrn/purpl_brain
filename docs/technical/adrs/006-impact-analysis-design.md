# ADR-006: Impact Analysis — LLM-Only Risk Scoring and Its Known Limits

**Status:** Accepted with known gaps  
**Date:** 2026-05-26  
**Deciders:** Deepak Kollipalli  

---

## Context

Before making a significant change, an agent calls `brain_analyze_impact`. The system needs to answer: which existing decisions does this change affect, and how risky is the conflict?

The challenge is that "risk" is contextual. A change that touches a high-confidence decision made three months ago with multiple downstream references is more dangerous than one that touches a speculative decision made yesterday. The system needs to score that difference.

---

## Decision

Risk scoring is delegated entirely to an LLM (`MODELS.QUERY`) against a four-tier rubric:

| Tier | Definition given to LLM |
|---|---|
| `critical` | Breaks a hard constraint |
| `high` | Likely rework needed |
| `medium` | Possible friction |
| `low` | Worth knowing, minimal risk |

`overall_risk` is set to the highest tier across all assessed decisions. The LLM receives the change description and the list of semantically relevant decisions (filtered by Qdrant cosine similarity ≥ 0.55) and returns a per-decision risk tier and a plain-English summary.

If the LLM call fails or returns unparseable JSON, all decisions default to `medium` and the summary reads "Impact assessment unavailable — manual review recommended."

---

## Rationale

LLM-only scoring was chosen for speed of implementation and because the rubric requires natural language understanding — "breaks a hard constraint" cannot be evaluated without reading the decision rationale. A rule-based system would need structured metadata that the current decision schema does not capture.

---

## Known Gaps

**The rubric is vague.** "Likely rework needed" vs "possible friction" is a judgment call the model makes without domain context. The same change described differently can produce different tiers. There is no validation that the tier assignment is consistent across runs.

**No rule-based floor.** A change that directly contradicts a high-confidence decision referenced by three other decisions gets the same tier as one that touches a speculative note from yesterday, if the LLM judges them equally. Decision metadata (confidence, downstream reference count, age, open drift alert history) is not used to enforce a minimum tier.

**`overall_risk` = max tier.** One loosely related low-severity decision rated `critical` by the LLM makes the entire analysis `critical`. There is no weighting by relevance score or decision importance.

**Silent exclusion.** Decisions whose Qdrant score falls below 0.55 are silently excluded before the LLM sees them. A decision that is relevant but phrased differently from the change description will not appear in the analysis.

---

## What Better Looks Like

A hybrid scoring model:

1. **Rule-based pre-scoring** uses decision metadata to set a floor:
   - Decision confidence (`high` → floor of `medium`)
   - Downstream reference count (decisions referenced by ≥3 others → floor of `high`)
   - Open drift alert on the decision → floor of `high`
   - Decision age < 7 days → reduce floor by one tier (recent decisions are more likely to be revisited intentionally)

2. **LLM assessment** adds nuance on top: reads the rationale, understands the semantic conflict, and can elevate above the floor.

3. **`overall_risk` = `max(rule_floor, llm_assessment)`** per decision, then aggregate.

This approach makes the scoring auditable (the rule floor is deterministic) while preserving the LLM's ability to catch semantic conflicts the rules miss.

---

## Consequences

Current: impact analysis is a useful first signal but cannot be relied on for automated gates. It requires human or agent review before acting on the result.

Future: with the hybrid model, the rule floor could be used to block or warn on changes programmatically — for example, requiring explicit acknowledgement before touching a decision with an open drift alert.
