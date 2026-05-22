---
sidebar_position: 3
---

# Post-Beta Items

These are features that are designed and have a clear implementation path, but are only worth building if beta teams confirm the pain. Building them before beta validation is premature.

## Living guidelines

**What it is:** A `Guideline` node type in the knowledge graph that stores team coding conventions — not just historical decisions, but active rules that should be enforced going forward. A `brain_get_guidelines` tool that agents call at session start alongside `brain_query`. A `RuleDrift` alert that fires when a new decision violates an established guideline.

**Example:** A team decides that all API endpoints must return standardized error shapes. This is logged as a Guideline, not just a Decision. An agent that later proposes a non-standard error shape triggers a `RuleDrift` alert — the violation is flagged before the code is written.

**Why deferred:** The current Decision memory approach may be sufficient for most teams. Guidelines add a new node type, a new tool, and a new alert category — significant scope. Beta will reveal whether teams want conventions enforced prospectively or whether they are satisfied with retrospective drift detection.

## Cross-source deduplication

**What it is:** Entity resolution at the Decision level. When a Slack discussion, a GitHub PR, and an agent log all record the same decision (choosing Redis for session storage), these three nodes should be linked or merged into a single canonical decision with multiple source citations.

**Current behavior:** Three separate Decision nodes exist, each with its own citation. A query about Redis for session storage returns all three with slightly different phrasing. Not wrong, but potentially confusing.

**Why deferred:** The deduplication algorithm requires semantic similarity at the decision description level plus scope comparison to confirm they are the same decision, not just similar ones. Incorrectly merging two distinct decisions is worse than having duplicates. Beta will reveal whether users are confused by seeing the same decision cited from multiple sources.

## `brain_trace_decision`

**What it is:** A query that shows the full provenance chain for a specific decision: every source that mentions it, every actor who contributed to it, every modification since it was first created, and every other decision it links to or contradicts.

**Example query:** `brain_trace_decision("redis-session-storage")` returns: first mentioned in Slack thread #arch-decisions on May 10 by alice, confirmed in PR #89 review by bob on May 12, adopted as project-level decision by agent session abc123 on May 15, challenged by agent session def456 on May 20 (DriftAlert created, resolved by alice on May 21).

**Why deferred:** This is a query pattern addition, not a new capability. The graph already stores all this information — the `brain_trace_decision` tool is just a well-structured traversal with a clean output format. Beta will reveal whether audit-grade provenance is something users actively want or whether it is a nice-to-have that nobody queries.

## Auto-extraction fallback

**What it is:** For sessions where no decision was explicitly logged but file changes occurred, run transcript extraction on available session output at `confidence: "low"` to recover decisions that were made but not written.

**Why deferred:** Auto-extracted low-confidence decisions are useful only if they are clearly labeled as such and distinct from agent-logged decisions in query results. If users cannot tell the difference between a high-confidence agent-logged decision and a low-confidence auto-extracted one, the auto-extraction pollutes the brain with noise. The labeling UX needs to be designed, and beta will reveal how much users actually need this vs. how much they are satisfied with improving Stop hook compliance.

## Identity resolution (M5)

**What it is:** Email as the `Person` node primary key, with per-source alias merge. Currently, `alice` in GitHub and `alice_smith` in Slack and `alice@company.com` in Jira are three separate `Person` nodes with no connection. Identity resolution merges these into a canonical person record, enabling "show me all decisions alice made across all sources" queries.

**Why deferred post-beta:** Identity resolution requires GitHub OAuth for seat authentication, which is M5. M5 is deliberately blocked until the write API contract is finalized (the 422 validation gate is stable and complete) and until beta validates the product. The identity resolution is required for billing — you cannot charge per seat without knowing whose seat is whose. It is a dependency of Phase 4, not Phase 3 beta.

## Alert grouping

**What it is:** When a single new decision contradicts multiple prior decisions (e.g., switching API style from REST to GraphQL contradicts 15 prior decisions about REST endpoints), group those contradictions into a single alert rather than generating 15 separate alerts.

**Why deferred:** Alert grouping requires clustering Stage A drift detector candidates by the existing decision they challenge, not by the new decision that triggered detection. Moderately complex change to the drift detector. The pre-beta mitigation is the raised threshold (0.72) which reduces absolute alert volume enough that grouping is not urgently needed. Beta will reveal the actual alert volume at real production usage levels.
