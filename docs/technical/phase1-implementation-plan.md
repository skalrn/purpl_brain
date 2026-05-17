# Phase 1 Implementation Plan

**Status:** ✅ Phase 1 Complete (2026-05-17)  
**Target duration:** 6–8 weeks  
**Exit criterion:** A developer returning after a 2-week absence queries the brain about a real repo and correctly understands current PR state, key decisions made, and open questions — all cited to specific GitHub sources.

---

## Scope Boundary

**In:**
- GitHub as the sole ingestion source (PRs, Issues, commit messages, review comments)
- Vector store + graph DB brain (Qdrant + Kuzu)
- Entity extraction: rule-based Pass 1 + LLM Pass 2 for decision candidates
- Natural language query interface (minimal web chat UI)
- Project-scoped queries only
- Temporal diff queries ("what changed in the last N days")
- Citation validation

**Out (explicitly deferred):**
- Slack, Jira, Linear, meetings ingestion
- Agent write-back loop
- Proactive anomaly detection
- Multi-product graph
- Expertise-scoped queries
- MCP server
- Auth / multi-user access control

---

## Build Order

Build in this sequence. Each milestone is a usable, testable increment — not a phase gate.

```
Week 1–2:  Milestone 1 — Ingestion pipeline (GitHub → canonical event → brain store)
Week 2–3:  Milestone 2 — Entity extraction (rule-based + LLM decision extraction)
Week 3–4:  Milestone 3 — Brain store (Qdrant + Kuzu, dual-write, graph linking)
Week 4–5:  Milestone 4 — Query layer (RAG + 1-hop graph expansion, citation assembly)
Week 5–6:  Milestone 5 — Chat UI + citation validator
Week 6–7:  Milestone 6 — Temporal diff query ("what changed")
Week 7–8:  Milestone 7 — Eval + calibration (extraction quality, query accuracy)
```

---

## Milestone 1 — GitHub Ingestion Pipeline

**Goal:** Raw GitHub events → normalized canonical events in a queue, ready for processing.

### Tasks

**1.1 — Webhook listener**
- FastAPI endpoint: `POST /webhooks/github`
- Validate GitHub HMAC-SHA256 signature (reject unsigned events)
- Parse event type from `X-GitHub-Event` header
- Enqueue raw event to Redis Streams: `XADD events:raw * ...`
- Return 200 immediately (don't block on processing)

**1.2 — Event normalization**
- Consumer reads from `events:raw`
- Map GitHub event types to canonical schema:

```python
EVENT_TYPE_MAP = {
    "pull_request.opened":     "pr_opened",
    "pull_request.closed":     "pr_merged",  # if merged=true
    "pull_request.closed":     "pr_closed",  # if merged=false
    "pull_request_review.submitted": "pr_review",
    "issues.opened":           "issue_created",
    "issues.edited":           "issue_updated",
    "issue_comment.created":   "comment",
    "push":                    "commit"
}
```

- Extract: `event_id` (GitHub delivery ID), `source_id` (PR/issue number), `actor`, `timestamp`, `raw_content`, `url`
- Write canonical event to Redis Streams: `XADD events:normalized *`

**1.3 — Idempotency**
- Check `event_id` against Redis SET `processed:event_ids` before processing
- If already processed: discard, return
- After processing: `SADD processed:event_ids {event_id}`
- TTL on the set: 30 days (GitHub re-delivery window)

**1.4 — Fallback polling**
- GitHub API polling job: runs every 15 minutes
- Fetches events since last poll timestamp per repo
- Enqueues to same `events:raw` stream with `source: "poll"` tag
- Only runs if webhook delivery log shows missed events (check via GitHub API)

### Deliverable
Webhook receives a GitHub PR event → normalized event appears in `events:normalized` stream within 2 seconds. Idempotent: sending the same event twice produces one normalized event.

---

## Milestone 2 — Entity Extraction

**Goal:** Normalized events → structured entities (decisions, action items, entity refs).

### Tasks

**2.1 — Pass 1: Rule-based extractor**
- Regex for ticket refs: `[A-Z]+-\d+` and `#\d+`
- `@username` mentions + configurable team member list
- Date expressions via `dateparser` library → normalized to ISO 8601
- Technology keyword list (start with ~50 common terms; extend based on project)
- Decision marker phrase matching → sets `decision_candidate = true`

**2.2 — Pass 2: LLM decision extractor**
- Runs only if `decision_candidate = true`
- Client: Anthropic SDK, model: `claude-haiku-4-5`
- Structured output via JSON mode + schema validation (Pydantic)
- Prompt: see entity-extraction.md
- Retry once on malformed output; log and skip on second failure
- Async — does not block ingestion queue consumer

**2.3 — Source-specific preprocessing**
- GitHub PR: concatenate description + all review comments (sorted by created_at) as extraction unit
- GitHub Issue: title + body + all comments as extraction unit
- GitHub commit: message only (low decision signal; extraction is Pass 1 only)

**2.4 — Confidence scoring**
- Compute confidence score from linguistic markers + rationale presence
- (Social confirmation and source authority signals added in Phase 3 with Slack)
- Map score to `high | medium | low`

**2.5 — Extraction output queue**
- Write `ExtractionResult` to Redis Streams: `XADD events:extracted *`
- Consumed by brain store writer (Milestone 3)

### Deliverable
A merged GitHub PR with a decision in its description → `ExtractionResult` with at least one Decision object, confidence scored, and `quoted_text` populated.

### Eval checkpoint
Before moving to Milestone 3: run Pass 2 against 10 real GitHub PRs with manually labeled decisions. Verify precision > 0.75. Tune the prompt if below threshold.

---

## Milestone 3 — Brain Store

**Goal:** Extracted entities → nodes and edges in Qdrant + Kuzu, dual-write with retry.

### Tasks

**3.1 — Qdrant setup**
- Run Qdrant locally via Docker
- Collection: `brain_chunks`
- Vector dimension: 1536 (text-embedding-3-large) or 1024 (voyage-3) — evaluate both in M7
- Payload fields: `chunk_id`, `graph_node_id`, `project_id`, `source`, `source_url`, `actor`, `timestamp`, `content`, `confidence`

**3.2 — Kuzu setup**
- Kuzu embedded (Python package, no separate server)
- Node tables: Event, Decision, Ticket, PullRequest, Person, Concept, Codebase, AgentSession
- Edge tables: implements, references, contradicts, supersedes, affects, authored_by, tagged_with
- Temporal fields: `valid_from`, `valid_to` on Decision nodes (bi-temporal for decisions only; other nodes are append-only)

**3.3 — Brain store writer**
- Consumes from `events:extracted`
- For each ExtractionResult:
  1. Create graph nodes in Kuzu (graph write first — source of truth)
  2. Chunk content by semantic boundaries (target: 400–600 tokens per chunk)
  3. Embed chunks via OpenAI/Voyage API (batch where possible)
  4. Write chunks + vectors to Qdrant with `graph_node_id` in payload
  5. If Qdrant write fails: log to `retry:vector_writes` queue
- Background retry job: re-embeds and re-writes failed vector chunks

**3.4 — Graph linker**
- After node creation: resolve entity refs from ExtractionResult
  - Ticket refs → find or create Ticket node, create `implements` or `references` edge
  - Person mentions → find or create Person node, create `authored_by` edge
  - Concept tags → find or create Concept node, create `tagged_with` edge
  - PR refs → find or create PullRequest node, create `references` edge
- Concept-to-module mapping: load from project config file (`module_map.json`)

**3.5 — Temporal versioning for decisions**
- When a Decision node is updated: set `valid_to = now` on existing node, create new node with `valid_from = now`
- Create `supersedes` edge: new → old
- "Current" decision = Decision node with `valid_to IS NULL`

### Deliverable
A GitHub PR event flows end-to-end: webhook → normalized → extracted → graph nodes created → vector chunks indexed in Qdrant. Verify with a Kuzu query returning the Decision node and a Qdrant nearest-neighbor search returning the relevant chunk.

---

## Milestone 4 — Query Layer

**Goal:** Natural language query → grounded answer with citations.

### Tasks

**4.1 — Query API endpoint**
- `POST /brain/query`
- Request: `{ query: str, project_id: str, mode: "project" | "temporal" }`
- Response: `{ answer: str, citations: Citation[], latency_ms: int }`

**4.2 — Intent parser**
- Model: `claude-haiku-4-5` (fast)
- Extracts: mode, time_range, entity_refs, question_type
- Runs in parallel with vector search (fire embedding immediately, don't wait for intent)

**4.3 — Hybrid retrieval (project-scoped)**
- Embed raw query → vector search in Qdrant (filter: `project_id`, top-K=10)
- For each result: Kuzu lookup of graph node → fetch 1-hop neighbors
- Score neighbors: `parent_similarity × 0.7`
- Merge, deduplicate, rank by score
- Trim to 6,000-token budget (priority order: exact entity match > high similarity > graph neighbor)

**4.4 — Temporal diff retrieval**
- Separate code path for `question_type = "what-changed"`
- Kuzu query: Decision/Ticket/PR nodes with `valid_from` in time range
- Fetch prior versions via `supersedes` edges
- Assemble delta struct: `{ created[], changed[], superseded[] }`

**4.5 — Answer generation**
- Model: `claude-sonnet-4-6`
- Prompt: citation contract (see query-layer.md)
- Stream response to caller

**4.6 — Citation validator**
- Post-generation: extract `[N]` references
- Verify each N exists in context
- Verify cited chunk contains key terms from associated claim
- Flag `citation_warning: true` if validation fails

### Deliverable
`POST /brain/query` with "what decisions were made in the auth module?" returns an answer citing at least one real Decision node from the ingested GitHub PRs, with source URL and timestamp.

---

## Milestone 5 — Chat UI

**Goal:** Minimal web interface for querying the brain. Not a polished product.

### Tasks

**5.1 — Basic chat interface**
- Next.js (or plain HTML + Tailwind if Next.js is overhead)
- Single page: project selector, query input, streamed response area, citation list
- Citation cards: expandable, show source type icon, actor, timestamp, deep link URL

**5.2 — Project setup flow**
- Form: GitHub repo URL, project name, module_map.json upload
- On submit: register project, trigger initial historical ingest (last 90 days of PRs/issues)
- Show ingestion progress indicator

**5.3 — Streaming**
- Use Server-Sent Events (SSE) to stream the answer token by token
- Citations appear after the answer is complete

### Deliverable
A browser-accessible chat UI where a user can type a question, see the answer stream in, and click citations to open the original GitHub source.

---

## Milestone 6 — Temporal Diff Query

**Goal:** "What changed in the last 5 days?" returns a structured, accurate changelog.

### Tasks

**6.1 — Delta assembly**
- Given time range: query Kuzu for all nodes with `valid_from` in range
- Group by type: decisions, tickets, PRs
- For each changed Decision: fetch prior version via `supersedes` edge
- Build delta: `{ created[], changed: [{before, after}], superseded[] }`

**6.2 — Delta summarization**
- LLM call: summarize delta into a human-readable changelog
- Each item cited to its source node
- Format: structured bullet list, not prose (easier to scan)

**6.3 — UI integration**
- Recognize temporal queries in the chat UI ("last 5 days", "this week", "since Monday")
- Route to temporal diff handler
- Display as a structured changelog, not a chat-style answer

### Deliverable
Query "what changed in the last week?" against a repo with multiple recent PRs and decisions → structured, cited changelog of actual changes.

---

## Milestone 7 — Eval and Calibration

**Goal:** Verify the system meets Phase 1 exit criterion before trusted user testing.

### Tasks

**7.1 — Extraction eval** ✅ PASS
- 20-30 GitHub PRs with manually labeled decisions
- Run extractor, compute precision and recall
- Target: precision > 0.75, recall > 0.65 → **Result: P=92.3%, R=80.0%**
- Calibration: expanded EXTRACTION_SYSTEM_PROMPT with decision taxonomy + 5 few-shot examples

**7.2 — Query accuracy eval** ✅ PASS
- 18 test queries against encode/httpx with known ground-truth answers
- Auto-graded with word overlap scoring + human review
- Target: > 80% correct or partially correct → **Result: 83.3% (15/18)**
- Fixes: brain-writer raw_content indexing, context budget tuning, drainPending ACK fix

**7.3 — Citation accuracy eval** ✅ PASS
- 15 queries producing 24 citations verified
- Target: 0 fabricated citations → **Result: 0 fabricated**
- All source_url values are valid GitHub URLs; all quoted_text substantive; citation_warning=false on all

**7.4 — Latency measurement** ✅ PASS (Claude API) / ⚠ Known fail (Ollama)
- 36 queries measured
- Target: p95 < 5000ms
- **Result: p95 ~40s on Ollama (expected — local 4B model, dev-only)**
- **Result: p95 < 2s on Claude API / Bedrock (meets target)**
- QUERY_TOP_K and QUERY_CONTEXT_BUDGET are env-driven for tuning per provider

**7.5 — Demo scenario prep** ✅ PASS
- Standard demo defined: encode/httpx, 5 demo queries, 2-week absence scenario
- Baseline: ~53 min manual catch-up → < 2 min with brain (cited)
- Demo script: `docs/demo/demo-script.md`
- End-to-end verified: `eval:demo` script passes all 5 scenario checks

---

## Technology Checklist

| Component | Technology | Notes |
|---|---|---|
| API server | FastAPI (Python) | Async, good ML ecosystem |
| Event queue | Redis Streams | Lightweight for POC |
| Vector store | Qdrant (Docker) | Self-hosted, no account needed |
| Graph DB | Kuzu (Python package) | Embedded, zero ops |
| Embedding model | `text-embedding-3-large` | Evaluate vs. voyage-3 in M7 |
| LLM (extraction) | Claude Haiku | Fast, cheap for structured tasks |
| LLM (query) | Claude Sonnet | Full quality for answer generation |
| Chat UI | Next.js or plain HTML | Minimal — not a product focus |
| Auth | None (Phase 1) | Single-user POC |
| Deployment | Local + ngrok | For GitHub webhook receipt |

---

## Phase 1 Exit Criterion

A developer who has been away from a real GitHub repository for 2 weeks queries the brain:

1. "What is the current state of the [feature] work?"
2. "What decisions were made while I was away and why?"
3. "What changed in the last 14 days?"

All three answers are:
- Factually accurate (verified against actual GitHub history)
- Cited to specific sources (PR, issue, or review comment with URL and timestamp)
- Returned in under 5 seconds

When this criterion is met, Phase 1 is complete. Phase 2 (agent write-back loop) begins.
