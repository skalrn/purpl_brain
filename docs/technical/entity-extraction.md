# Technical Spec — Entity Extraction

**Status:** Draft  
**Version:** 0.1  
**Last Updated:** 2026-05-15  

---

## Overview

Entity extraction transforms raw ingested signals into structured nodes suitable for the brain store. It is the most quality-critical component in the system — everything downstream (query accuracy, citation quality, anomaly detection) depends on what gets extracted here. A bad retrieval algorithm on good nodes returns mediocre answers. A good retrieval algorithm on bad nodes returns confidently wrong answers.

The hard problem is not extracting people, ticket numbers, or dates — those are regex problems. The hard problem is extracting **Decisions**: semantic, implicit, fragmented across multiple messages, expressed differently on every surface.

---

## Output Schema

The extractor produces this for every ingested event:

```json
{
  "decisions": [
    {
      "description": "Use short-lived JWTs (15-min expiry) for session tokens",
      "rationale": "Security requirement from compliance review",
      "confidence": "high | medium | low",
      "decision_maker": "alice",
      "scope": "auth module, all services behind the API gateway",
      "reversible": false,
      "quoted_text": "Ok we're going with short-lived JWTs, compliance requires it"
    }
  ],
  "action_items": [
    {
      "description": "Alice to update the token refresh endpoint by Thursday",
      "assignee": "alice",
      "due": "2026-05-20",
      "linked_ticket": "PROJ-412"
    }
  ],
  "entity_refs": {
    "tickets": ["PROJ-412"],
    "prs": ["#234"],
    "people": ["alice", "bob"],
    "concepts": ["auth", "JWT", "token storage", "session management"]
  },
  "sentiment": "aligned | contested | uncertain"
}
```

`quoted_text` is mandatory for high-confidence decisions — if you cannot quote the source text that supports the decision, confidence must drop to medium or low. A decision without a quotable source is inferential.

---

## Two-Pass Hybrid Approach

Do not use LLM extraction for everything. LLM calls are slow and expensive. Two-pass approach reduces LLM calls by ~65%.

### Pass 1 — Rule-based (fast, cheap, deterministic)

Runs on every event. Extracts:

- **Ticket references:** regex `[A-Z]+-\d+` (Jira) or `#\d+` (GitHub)
- **Person mentions:** `@username` patterns + known team member name list
- **Date/deadline references:** `dateparser` library over natural language date expressions; all dates normalized to absolute ISO 8601
- **Technology mentions:** curated keyword list (JWT, GraphQL, REST, Redis, Postgres, etc.) + fuzzy match (Levenshtein distance ≤ 2 for typos)
- **Decision marker phrases:** flag the event as `decision_candidate = true` if any of these appear:

```python
DECISION_MARKERS_TEXT = [
    "we decided", "we've decided", "agreed to", "going with",
    "let's go with", "we will use", "closing in favor of",
    "won't fix", "decided not to", "moving forward with"
]

DECISION_MARKERS_SPEECH = [  # for meeting transcripts
    "so let's just", "ok let's move forward",
    "alright so we're saying", "i think we all agree",
    "so we're going with", "let's call it"
]
```

Output of Pass 1: structured `entity_refs` + `decision_candidate` boolean.

### Pass 2 — LLM extraction (only on decision candidates)

Runs only when `decision_candidate = true`. Uses Claude Sonnet with structured output (JSON mode, temperature=0).

**Prompt:**
```
Extract all decisions from the following {source_type} content.
A decision is a concluded choice, not a suggestion or open question.

For each decision, extract:
- description: what was decided (one clear sentence)
- rationale: why (null if not stated — do not infer)
- confidence: high (explicit agreement), medium (strong indicator), low (uncertain)
- decision_maker: who announced or made the decision
- scope: what does this apply to
- reversible: true if presented as tentative, false if presented as final
- quoted_text: exact quote from the source that supports this decision

If no decisions are present, return { "decisions": [] }.
Do not invent decisions. Do not infer rationale that is not stated.

Content:
{content}
```

Validate output against schema before accepting. Malformed output → retry once → if still malformed, drop and log. Never pass unvalidated LLM output to the brain store.

---

## Source-Specific Extraction Strategies

The extraction unit differs per source. This matters more than the extraction model.

### Slack

**Extraction unit: full thread, not individual messages.**

Decisions emerge across thread arcs, not in single messages:
```
Root:    "What should we use for session tokens?"
Reply 1: "Long-lived tokens are simpler"
Reply 2: "Compliance flagged long-lived tokens last quarter"
Reply 3: "Ok we're going with short-lived JWTs, compliance requires it"  ← decision
Reply 4: 👍 (3 people)
```

Extracting message 3 alone loses the rationale (compliance, from message 2). The full thread gives the LLM context to fill in `rationale`.

**Reaction signals** (metadata, not text): 👍 reactions from 2+ people on a message containing a decision marker → confidence modifier +0.15. Used in confidence scoring, not in the LLM prompt.

**Channel context:** extract channel name and use as a confidence modifier:
- `#decisions`, `#architecture`, `#adr` → +0.2 to confidence
- `#engineering`, `#backend` → +0.1
- `#random`, `#general` → no modifier

### GitHub PRs

Three extraction zones with different signal density:

| Zone | Trust | Strategy |
|---|---|---|
| PR description | High | Extract decisions directly |
| Review comments | Medium | Extract debates and rejections ("this won't work because...") |
| Merge event | High (implicit) | Treat as confirmation of PR description decisions |
| Closing comment | High if present | Extract rationale if present |

Review comments are the most valuable zone and the most underused. A reviewer saying "don't use this approach because X, try Y instead" followed by the author responding "switching to Y" is a complete decision with rationale across two comment threads.

Extract review comment threads as units (comment + reply chain), not individual comments.

### Jira / Linear

Status transitions are **implicit decisions** that must be mapped explicitly:

```python
STATUS_DECISION_MAP = {
    "Won't Fix":   "decided not to implement {ticket_title}",
    "Duplicate":   "{ticket_title} is handled by {linked_ticket}",
    "Accepted":    "{ticket_title} is in scope and prioritized",
    "Rejected":    "decided not to pursue {ticket_title}",
    "Deferred":    "{ticket_title} deferred to future sprint"
}
```

The rationale is almost never in the transition itself — it's usually in the last comment before the transition. Extract the most recent comment before each status change as the candidate rationale source.

Priority changes → implicit decision about relative importance. Capture as a low-confidence Decision node with `description: "PROJ-412 deprioritized relative to PROJ-398"`.

### Meeting Transcripts

The noisiest source. Decision density is low; volume is high.

**Extraction unit:** paragraph/segment with sliding context window.

```
Segment N-2 (context)
Segment N-1 (context)
Segment N   (candidate, contains decision marker)
```

Window size: 3 segments (current + 2 prior). The rationale usually precedes the decision announcement by 1-2 speaker turns.

**Speech-specific decision markers** (separate list from text markers — informal speech patterns are different):
```
"so let's just", "ok let's move forward with", "alright so we're saying",
"i think we all agree", "does everyone agree", "so we're going with"
```

Speaker attribution must be preserved. "Alice: let's go with JWT" is more informative than just "let's go with JWT" — the speaker's role affects confidence scoring.

### Agent Logs

No LLM extraction needed. Parse the structured schema directly (ADR-004). Decisions are explicitly labeled. Highest confidence by design.

```python
def extract_from_agent_log(log: AgentLog) -> ExtractionResult:
    decisions = [
        Decision(
            description=d.description,
            rationale=d.rationale,
            confidence="high",  # agent logs are always high confidence
            decision_maker=log.agent_id,
            scope=log.codebase,
            reversible=(d.confidence != "high"),
            quoted_text=d.description  # the log IS the quote
        )
        for d in log.decisions
    ]
    return ExtractionResult(decisions=decisions, ...)
```

---

## Confidence Scoring

Four signals combined into a final confidence score:

| Signal | Weight | High | Medium | Low |
|---|---|---|---|---|
| Linguistic markers | 0.4 | "decided", "agreed", "we will" | "let's", "plan to" | "maybe", "could", "idea:" |
| Social confirmation | 0.3 | 👍 ×2+ or senior confirms | Single agreement | No response |
| Source authority | 0.2 | #decisions channel, ADR | Design discussion | General chat |
| Rationale presence | 0.1 | Rationale stated | Partial rationale | No rationale |

**Score → confidence label:**
- ≥ 0.7 → `high` — stored as Decision node, full weight in query ranking
- 0.4–0.69 → `medium` — stored, deprioritized in query ranking
- < 0.4 → `low` — stored as candidate, not surfaced unless explicitly queried

---

## Coreference Resolution (Scoped)

Full coreference resolution is expensive and out of scope for Phase 1-2. Pragmatic approach: scope context by source.

- **Slack:** always process the full thread together. "It" in reply 4 refers to something in the same thread — the LLM resolves it naturally with full thread context.
- **Meetings:** sliding window (3 segments) handles 90%+ of within-turn references.
- **Cross-document coreference** ("the JWT discussion from last week"): don't resolve at extraction time. The graph linker handles this — entity tags connect related nodes across sources and time.

The extractor's responsibility is faithful extraction within the document boundary. Cross-document connections are the linker's responsibility.

---

## Quality Measurement

### POC Eval Setup

Before deploying to trusted users:

1. Collect 20-30 real Slack threads + GitHub PRs from actual projects (with team member permission)
2. Manually label: decisions made, rationale, confidence levels
3. Run extractor, compare against labels
4. Measure:
   - **Precision:** of extracted decisions, what % are real decisions (not suggestions/noise)
   - **Recall:** of labeled decisions, what % did the extractor find
   - **Rationale accuracy:** when rationale is extracted, does it match the label

**POC targets:** Precision > 0.75, Recall > 0.65

Below 0.75 precision → brain fills with noise → users lose trust in query answers.
Below 0.65 recall → important decisions are silently missing → users learn not to trust "no information" responses.

### Production Signal

The signal that extraction quality is failing in production: a user queries the brain for a known decision and gets "insufficient information" — when the decision was in an ingested Slack thread.

Track as `query_answered_rate` for queries where the user follows up with "that decision was definitely discussed." Every follow-up of this type is a recall failure. Log and review weekly.

---

## Open Questions

- At what volume of events does Pass 2 (LLM extraction) become a latency bottleneck, and what is the queue strategy when extraction lags ingestion?
- Should low-confidence decisions be surfaced in query results at all, or only in response to direct requests for candidate decisions?
- How do we handle extraction from non-English sources? (Deferred post-Phase 4, but worth noting as a constraint on the phrase list approach.)
