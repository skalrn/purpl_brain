---
sidebar_position: 4
---

# Entity Extraction

## Why extraction quality is the ceiling

Everything downstream — query accuracy, citation quality, drift detection — depends on what gets extracted in the pipeline. A mediocre retrieval algorithm on good Decision nodes returns mediocre answers. A good retrieval algorithm on bad Decision nodes returns confidently wrong answers.

The hard extraction problem is not people, ticket numbers, or dates — those are regex problems. The hard problem is **Decisions**: semantic, implicit, fragmented across multiple messages, expressed differently on every surface. A Slack thread where four people debate an approach and one person says "ok let's just go with JWT" is a decision. A GitHub review comment where a reviewer says "this approach won't work because X, we should use Y instead" followed by the author saying "switched to Y" is a decision with explicit rationale and an alternative considered.

The extractor must catch these while ignoring suggestions, open questions, and statements of intent.

## Two-pass hybrid approach

Running LLM extraction on every ingested event would be slow and expensive. Two-pass hybrid extraction reduces LLM calls by approximately 65%.

**Pass 1: Rule-based (runs on every event)**

```typescript
// Ticket references
const TICKET_RE = /[A-Z]+-\d+/g;    // Jira
const PR_RE = /#\d+/g;               // GitHub

// Decision marker phrases — if any match, event is a decision candidate
const DECISION_MARKERS_TEXT = [
  "we decided", "we've decided", "agreed to", "going with",
  "let's go with", "we will use", "closing in favor of",
  "won't fix", "decided not to", "moving forward with"
];

const DECISION_MARKERS_SPEECH = [   // for meeting transcripts
  "so let's just", "ok let's move forward",
  "alright so we're saying", "i think we all agree",
  "so we're going with", "let's call it"
];
```

Pass 1 extracts ticket refs, person mentions, dates (normalized to ISO 8601 via `dateparser`), and technology keywords. Most importantly, it sets `decision_candidate = true` if any decision marker phrase matches.

**Pass 2: LLM extraction (runs only when `decision_candidate = true`)**

Uses Claude with structured JSON output and temperature=0. The prompt is precision-first:

```
You are a high-precision decision extractor for software engineering content.
Your primary goal is precision: extracting a non-decision is worse than missing a real one.
When in doubt, do NOT extract. A missed decision is recoverable. A spurious one pollutes the brain.

A decision is a concluded choice, not a suggestion or open question.

For each decision, extract:
- description: what was decided (one clear sentence)
- rationale: why (null if not stated — do not infer)
- confidence: high (explicit agreement), medium (strong indicator), low (uncertain)
- decision_maker: who announced or made the decision
- scope: what does this apply to
- reversible: true if presented as tentative, false if presented as final
- quoted_text: exact quote from the source that supports this decision
```

The "do not infer rationale" instruction is critical. An LLM asked to extract rationale will fabricate one if none is stated. Fabricated rationale stored as a cited Decision node is worse than no rationale — it creates false context that future sessions will build on.

## Quality gates

Two gates before a Decision node reaches the brain store:

**Schema validation (server-side):** `POST /brain/agent-log` returns 422 with structured `violations[]` if:
- `rationale` is empty or missing
- `description` is shorter than 20 characters
- `work_completed` is shorter than 10 characters

**Warnings (soft signal):** The API returns 202 with `warnings[]` for decisions that were accepted but are missing `alternatives_considered`. The decision is stored; the caller is informed that quality could be improved. A `WriteBackQualityBadge` in the UI surfaces this at the project level: green means all decisions have alternatives, amber means none do.

## Source-specific strategies

**Slack:** Extraction unit is the full thread, not individual messages. Decisions emerge across thread arcs — the rationale is usually in the messages preceding the announcement, not in the announcement itself. Reaction signals (👍 from 2+ people on a decision-marker message) add +0.15 to confidence.

**GitHub PRs:** Three extraction zones with different signal density. The PR description is high-trust; review comments are medium-trust (debates and rejections); the merge event is an implicit confirmation of whatever the PR description decided. Review comment threads are extracted as units (comment + reply chain), not individual comments.

**Jira / Linear:** Status transitions map to implicit decisions. `Won't Fix` becomes `"decided not to implement {ticket_title}"`. The rationale is usually in the last comment before the transition — the extractor looks there first.

**Meetings:** Noisiest source, lowest decision density. Extraction unit is a paragraph/segment with a 3-segment sliding context window (current + 2 prior). The rationale precedes the decision announcement by 1-2 speaker turns, so the window is necessary to capture it.

**Agent logs:** No LLM extraction. Parse the structured schema directly. Every field is explicitly labeled. Agent logs always receive `confidence: "high"` because the schema is the source — there is no inference step.

## Confidence scoring

Four signals produce a confidence score, which maps to the label stored on the Decision node:

| Signal | Weight |
|---|---|
| Linguistic markers ("decided", "agreed", "we will" vs "maybe", "could") | 0.4 |
| Social confirmation (👍 reactions, senior team member reply) | 0.3 |
| Source authority (#decisions channel vs #random) | 0.2 |
| Rationale presence (stated vs absent) | 0.1 |

Score mapping:
- ≥ 0.7: `high` — full weight in query ranking
- 0.4-0.69: `medium` — stored, deprioritized in ranking
- < 0.4: `low` — stored as candidate, not surfaced unless explicitly queried

## Eval results

Phase 1 eval (20-30 GitHub PRs with manually labeled decisions):

| Metric | Target | Result |
|---|---|---|
| Precision | > 75% | 92.3% |
| Recall | > 65% | 80.0% |

The precision calibration used an expanded system prompt with a decision taxonomy and 5 few-shot examples showing the difference between a decision ("chose Redis for session storage") and a suggestion ("we might want to consider Redis").

Below 75% precision, the brain fills with noise and users stop trusting query answers. Below 65% recall, important decisions are silently missing and users learn that "no information" responses cannot be trusted.
