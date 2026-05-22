---
sidebar_position: 6
---

# Query Layer

## Pipeline

Every query — from an agent calling `brain_query` or a human typing into the chat UI — flows through five stages:

```
Natural language query
        │
        ├──── embed raw query immediately (no LLM, parallel with intent parsing)
        │
        ▼
1. Intent Parser (Claude Haiku)
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
                       ▼
4. Answer Generation (Claude Sonnet) — inline citation instructions
                       ▼
5. Citation Validator — verifies every cited chunk exists in context
```

The raw query is embedded immediately, before intent parsing completes. Vector search starts on the raw embedding in parallel with the intent parse. The intent parse result applies filters to the already-running search. This saves approximately 400ms per query.

## The four retrieval modes

**Project-scoped (standard)**

The default mode for most queries. Vector search in Qdrant (filter: `project_id`, top-K=10), followed by graph expansion in Neo4j with three patterns run in parallel: decision chain (decisions shared across events), author activity (recent events by the same person), ticket linkage (events co-referencing the same tickets).

Graph expansion is what separates this from plain RAG. A chunk about "JWT token handling" might score low on semantic similarity to "auth module decisions" but is linked in the graph via `AFFECTS → Concept("auth")`. Graph expansion pulls in causally related content that vector search misses.

**Temporal ("what changed in the last 5 days")**

Dedicated diff code path — does not use vector search. Queries Neo4j for all nodes with `valid_from` in the specified range, groups by node type, fetches prior versions via `SUPERSEDES` edges, and assembles a structured delta: `{ created[], changed: [{before, after}], superseded[] }`.

Standard RAG finds content *about* recent events. This path finds content that *changed*. They are distinct code paths, not variants of each other.

**Expertise-scoped (cross-project)**

Cannot dump all-project top-K into one context window — the token explosion degrades quality. Instead: for each project namespace, run a vector search filtered by domain tags and summarize the top-3 results into a ~200-token project brief. The final answer is generated from the collection of briefs plus 2 raw chunks per project as evidence.

Token budget: 200 (brief) + 2×500 (raw chunks) = 1,200 tokens per project. Four projects = 4,800 tokens, leaving room for the prompt template.

**Agent-resume**

Pure graph traversal. No vector search. Looks up the agent session by `session_id` or `(task_id, most recent)`, traverses to the decisions authored in that session, fetches the current state of associated tickets and PRs, and diffs: what has changed in the codebase since the session ended?

The diff is what makes agent-resume useful. Without it, the agent gets a log of prior decisions. With it, the agent gets: "the agent decided X, but since the session ended, PR #89 was merged touching the same module — you may need to revisit X."

## Context budget

Token budget: 6,000 tokens of retrieved context (leaves room for the prompt template and output).

Priority order when the budget is tight:

| Priority | Type | Drop policy |
|---|---|---|
| 1 (never drop) | Exact entity matches (PR #234 named in query) | Never |
| 2 (drop last) | High-similarity chunks (score > 0.85) | Last |
| 3 (drop first) | Graph-expanded neighbors | First |

Chunks that do not make the budget are also removed from the citation list. The LLM only gets citation numbers for chunks it can actually see. This prevents the most common failure mode: the LLM citing a source number that maps to a chunk it was not given.

Recency bonus: chunks from the last 7 days get +0.1 added to their score. Tiebreaker only.

## The citation contract

Every answer is generated under a strict citation contract:

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
```

The "if insufficient, say so" instruction is not optional. Without it, the LLM attempts an answer and fabricates supporting detail. The explicit fallback instruction is what keeps the brain from hallucinating context when it has none.

## Citation validation

Post-generation, before returning the answer:

1. Extract all `[N]` references from the generated text
2. Verify each N corresponds to a source chunk that made it through the budget trim
3. Verify the cited chunk contains at least one key term from the associated claim (loose substring match)

If validation fails: `citation_warning: true` is set in the response. In the UI, this renders as a warning banner. The answer is still returned — the warning signals that a human should verify the citations before acting on the answer.

Citation validation catches hallucinated citations — cases where the LLM cites `[3]` for a claim but source 3 says something different. This is the most common failure mode in grounded RAG systems.

## Latency targets

| Step | Estimated time |
|---|---|
| Embed raw query | ~80ms |
| Intent parsing (Claude Haiku) | ~400ms (parallel with vector search) |
| Vector search (Qdrant) | ~100ms |
| Graph expansion (Neo4j) | ~150ms (3 patterns in parallel) |
| Ranking + budget trim | ~30ms |
| Answer generation (Claude Sonnet) | 2,000-3,500ms |
| Citation validation | ~80ms |
| **Total (p95)** | **~2.8-4.3s** |

Answer generation is the only step that cannot be parallelized. The response is streamed to the UI — the user sees content arriving at approximately 1s even if the full answer takes 4s.
