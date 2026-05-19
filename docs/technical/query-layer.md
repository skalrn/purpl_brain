# Technical Spec — Query Layer

**Status:** Draft  
**Version:** 0.1  
**Last Updated:** 2026-05-15  

---

## Overview

The query layer translates natural language input from humans or agents into grounded, cited answers. It combines vector similarity search with graph traversal — neither alone is sufficient. Every answer must be traceable to a specific source chunk; answers without grounding are not returned.

---

## Pipeline

```
Natural language query
        │
        ├──── embed raw query immediately (no LLM, parallel with intent parsing)
        │
        ▼
1. Intent Parser (Haiku — fast/cheap)
   → mode, filters, entity_refs, question_type
        │
        ├──────────────────────────────┐
        ▼                             ▼
2. Vector Search                Graph Traversal     ← parallel
   (top-K semantic candidates)  (relational candidates)
        │                             │
        └──────────────┬──────────────┘
                       ▼
3. Candidate Ranking + Context Budget Trim (6K token limit)
                       │
                       ▼
4. Answer Generation (Sonnet) — inline citation instructions
                       │
                       ▼
5. Citation Validator — verifies every cited chunk exists in context
```

---

## Stage 1 — Intent Parsing

**Model:** Claude Haiku (fast, cheap — intent parsing is a small structured task)

**Output schema:**
```json
{
  "mode": "project | temporal | expertise | agent-resume | impact",
  "project_ids": ["proj-a"],
  "time_range": { "from": "ISO 8601", "to": "ISO 8601" },
  "domain_tags": ["auth", "payments"],
  "entity_refs": {
    "pr": ["#234"],
    "ticket": ["PROJ-412"],
    "session_id": null
  },
  "question_type": "current-state | why-decided | what-changed | what-affects"
}
```

**Latency optimization:** Embed the raw query immediately (embedding model, no LLM). Fire vector search using the raw embedding before intent parsing completes. Intent parsing result applies filters to the already-running search. Saves ~400ms per query.

---

## Stage 2 — Retrieval Strategy by Mode

### Project-scoped (standard)

```
vector search (filter: project_id) → top-K=10 chunks
    ↓
for each chunk: graph expansion (3 parallel patterns) →
    decision chain: decisions shared across events
    author activity: recent events by the same person
    ticket linkage: events co-referencing the same tickets
    ↓
score neighbors: (parent_similarity × 0.7) + recency_bonus
    ↓
merge, deduplicate, rank
```

Graph expansion is what separates this from plain RAG. A chunk about "JWT token handling" might score low on semantic similarity to "auth module decisions" but is linked in the graph via `affects → Concept("auth")`. Graph expansion pulls in causally related content that vector search misses.

### Temporal ("what changed in the last 5 days")

Dedicated diff code path — do not use vector search.

```
graph query: all nodes WHERE valid_from IN [T-N, now], filtered by project_id
    ↓
group by node type: { decisions[], tickets[], prs[], agent_sessions[] }
    ↓
for each changed Decision: fetch prior version via `supersedes` edge
    ↓
assemble delta: { created[], changed[], superseded[] }
    ↓
generate structured changelog summary
```

Standard RAG finds content *about* recent events; this path finds content that *changed*. Distinct code path, not a variant of the standard retrieval.

### Expertise-scoped (specialist cross-product query)

Cannot dump all-project top-K into one context window — explodes size and degrades quality.

```
for each project namespace in project_ids (or all if empty):
    vector search (filter: domain_tag IN query.domain_tags) → top-3 chunks
    summarize into project_brief (~200 tokens, short LLM call)
    ↓
assemble: [project_brief_A, project_brief_B, ...] + top-2 raw chunks per project as evidence
    ↓
final answer generation from briefs + evidence
```

Token budget per project: 200 (brief) + 2×500 (raw chunks) = 1,200 tokens. Four projects = 4,800 tokens — fits within budget with room for prompt template.

### Agent-resume

Pure graph traversal. No vector search.

```
graph lookup: AgentSession WHERE session_id=X OR (task_id=Y, ORDER BY timestamp DESC, LIMIT 1)
    ↓
traverse: AgentSession → decisions[] via authored_by edges
    ↓
fetch current state: associated ticket, open PRs for same module
    ↓
diff: decisions from session vs. current ticket/PR state (has anything changed since session end?)
    ↓
answer: prior decisions + drift since session ended
```

The drift check is what makes agent-resume useful. Without it you get a log. With it you get: "the agent decided X, but since the session ended, PR #89 was merged touching the same module."

### Impact analysis

Pure graph traversal from a starting node. No vector search.

```
BFS from starting_node
following edges: affects, implements, references (outbound)
depth_limit: 3 (configurable, default 3)
    ↓
score by hop distance: 1=direct, 2=indirect, 3=transitive
    ↓
return ranked list with dependency_path per affected node
```

Depth limit is mandatory. Without it, a well-connected graph returns everything. Three hops is the default: direct dependencies (1), their dependencies (2), transitive effects (3). Beyond 3 hops, signal-to-noise collapses.

---

## Stage 3 — Candidate Ranking and Context Budget

**Token budget:** 6,000 tokens of context (leaves room for prompt template and output).

**Priority order when budget is tight:**

| Priority | Type | Drop policy |
|---|---|---|
| 1 (never drop) | Exact entity matches (PR #234 named in query) | Never |
| 2 (drop last) | High-similarity chunks (score > 0.85) | Last |
| 3 (drop first) | Graph-expanded neighbors | First |

**Recency bonus:** chunks from the last 7 days get +0.1 added to their score. Tiebreaker only — does not override similarity.

Dropped chunks must also be removed from the citation list. The prompt only includes chunk numbers for chunks that made it through budget trim. The LLM cannot cite what it cannot see.

---

## Stage 4 — Answer Generation and Citation Contract

**Model:** Claude Sonnet

**Prompt contract:**

```
You are answering a question based solely on the numbered sources below.

Rules (strictly enforced):
- Every factual claim must cite at least one source inline: [1], [2], etc.
- Do not make any claim not directly supported by a numbered source.
- If the sources do not contain enough information to answer, say exactly:
  "The brain does not have sufficient information to answer this question.
   The closest available context is: [cite what is available]."
- Never infer or extrapolate beyond what the sources state.
- At the end, list every source you cited:
  [N] <type> | <actor> | <timestamp> | <url>

Sources:
[1] Slack thread #architecture (alice, 2026-05-10): "..."
[2] PR #234 review comment (bob, 2026-05-14): "..."
...

Question: {query}
```

The explicit "if insufficient, say so" instruction is critical. Without it, the LLM attempts an answer anyway and fabricates supporting detail.

---

## Stage 5 — Citation Validation

Post-generation validation before returning the answer:

1. Extract all `[N]` references from the generated answer
2. Verify each N corresponds to a source in the context (chunk number exists)
3. Verify the cited chunk contains at least one key term from the associated claim (loose substring match)

If validation fails:
- Flag the answer with `citation_warning: true`
- In POC: return the answer with a warning banner in the UI
- Post-POC: retry with a stricter prompt before returning

Validation catches hallucinated citations — cases where the LLM cites `[3]` for a claim but source 3 says something different. This is the most common failure mode.

---

## Latency Budget

| Step | Estimated time | Notes |
|---|---|---|
| Embed raw query | ~80ms | Runs immediately, parallel with intent |
| Intent parsing (Haiku) | ~400ms | Parallel with vector search |
| Vector search (Qdrant) | ~100ms | Returns while intent parsing finishes |
| Graph expansion (multi-hop, Neo4j) | ~150ms | 3 parallel traversal patterns: decision chain, author activity, ticket linkage |
| Ranking + budget trim | ~30ms | In-memory |
| Answer generation (Sonnet) | 2,000–3,500ms | Largest variable |
| Citation validation | ~80ms | Regex + chunk lookup |
| **Total** | **~2.8–4.3s** | Fits p95 < 5s target |

Answer generation is the only step that cannot be parallelized. Stream the response to the UI — user sees content arriving at ~1s even if full answer takes 4s.

---

## Scaling Path

| Phase | Approach | Threshold |
|---|---|---|
| Phase 1–2 | All retrieval in-process (Neo4j local, Qdrant local) | < 10 projects, < 100K nodes |
| Phase 3 | Qdrant cloud, Neo4j Community (current); Neo4j Enterprise if scale demands | > 10 projects or complex multi-hop queries |
| Phase 4 | Caching layer for repeated queries; async pre-computation for common patterns | > 100 queries/day |

---

## Open Questions

- Should temporal queries ("what changed") also include a semantic pass over the delta to surface the *significance* of changes, not just list them?
- At what point does per-project summarization (expertise-scoped mode) need to move to a dedicated summarization service vs. inline LLM calls?
- Should the citation validator be synchronous (blocks response) or async (returns answer with delayed validation result)?
