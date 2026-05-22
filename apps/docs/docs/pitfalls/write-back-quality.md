---
sidebar_position: 2
---

# Write-Back Quality: Facts vs. Decisions

## The failure mode

The brain fills. Agents are writing to it regularly — compliance looks good. But query answers are not useful. The brain is returning entries like:

- "team used TypeScript on this project"
- "added a helper utility for parsing dates"
- "implemented the feature as discussed"

None of these help the next agent pick up context from a prior session. They are implementation notes, not decisions. An agent reading these learns almost nothing actionable.

This is failure mode B: the brain is populated but with the wrong kind of content. It is harder to diagnose than an empty brain because the system appears to be working. Queries return results. Write-back compliance metrics look healthy. The problem only surfaces when a developer asks "why isn't the next agent session picking up context?" and inspects the actual brain content.

## What a decision looks like vs. what a fact looks like

A decision has these properties:
1. Something was chosen from among alternatives
2. There is a reason the choice was made
3. Knowing the choice and reason would change what the next agent does

A fact has these properties:
1. Something is true about the project
2. The truth was not really chosen — it just is
3. The next agent would learn this from reading the code anyway

| Entry | Classification | Why |
|---|---|---|
| "team used TypeScript" | Fact | Not chosen from alternatives in this session; visible from the code |
| "chose TypeScript over Python because type safety catches ~40% of our runtime errors, per our post-mortem data" | Decision | Alternatives were considered; rationale is non-obvious; future agents should not re-evaluate |
| "added a date parsing utility" | Fact | Implementation detail; visible from the code |
| "used native Date.parse rather than date-fns because date-fns added 15KB to the bundle; revisit if we need more locale support" | Decision | Tradeoff was made; rationale is non-obvious; the constraint (bundle size) should inform future choices |

The distinction is not about length. Short facts are common. Long decisions are also common. The test is: would a new agent, reading only this entry, make a different technical choice than if they had not read it?

## Why server-side quality gates beat prompt discipline

The naive approach to quality is to write better prompts instructing the agent to log meaningful decisions. This works to a degree — CLAUDE.md instructions improve quality noticeably. But prompt discipline is variable across sessions, degrades under context compression, and has no enforcement mechanism.

Server-side validation is the reliable enforcement layer:

**422 hard rejection** for entries that fail minimum quality thresholds:
- `description` shorter than 20 characters (catches one-liners like "used TypeScript")
- `rationale` missing or empty (catches entries with no reasoning)
- `work_completed` shorter than 10 characters

**202 with `warnings[]`** for entries that are accepted but flagged:
- `alternatives_considered` absent or empty

The 422 gate forces the agent to write something meaningful or not write at all. An agent that writes "used TypeScript" gets a 422 response and has to try again with a real decision — describing what was chosen, why, and what was rejected.

The 202 warning is softer. A decision without alternatives is accepted — the `alternatives_considered` field is not always applicable. But the warning gives the agent signal that quality could be improved, and it drives the `WriteBackQualityBadge` in the UI.

## The WriteBackQualityBadge

The badge is visible at the project level in the UI. Green means all decisions have `alternatives_considered`. Amber means none do.

The badge is not a compliance metric — it does not count write-back calls. It measures content quality. A project can have perfect write-back compliance (every session writes decisions) and still show amber if every decision log omits alternatives.

The practical use of the badge is during onboarding and during beta review: if a new user's project shows amber after their first few sessions, the developer can see immediately that their decisions need more depth, before they have gone through enough sessions to discover this themselves from unsatisfying query results.

## The re-derivation heuristic

The cleanest mental model for what to log: **if session N+1 starts cold (no memory of session N), would not knowing this decision cause re-derivation or a conflicting choice?**

If yes, log it. If no — if the next agent would arrive at the same place anyway from reading the code — skip it.

This heuristic is in CLAUDE.md as an instruction to the agent. It is simple enough to apply mid-session without extensive reflection, and it catches most of the useful decisions while filtering out implementation notes.
