# Purpl Brain — Standard Demo Script (Phase 1)

## Scenario

**Project:** `encode/httpx` — a popular Python HTTP client library  
**Setup:** The brain has ingested the last ~4 months of GitHub PRs and issue activity  
**Persona:** A new maintainer or returning engineer who has been away for 2 weeks  

The demo answers one question: *"What does it take to catch up on two weeks of decisions without reading 50 PRs?"*

---

## Baseline: Human Catch-up Time

Manual research against the same corpus (50 PRs in GitHub UI):

| Task | Manual (estimated) |
|------|-------------------|
| Scan 50 PR titles for relevance | 8 min |
| Read decision-heavy PRs in full | 25 min |
| Cross-reference related PRs | 10 min |
| Write a summary | 10 min |
| **Total** | **~53 min** |

With the brain: same questions answered in **< 2 min**, fully cited.

---

## Pre-Demo Checklist

Run these before demoing to ensure a clean state:

```bash
# 1. Start infrastructure
docker compose up -d          # Redis, Neo4j, Qdrant

# 2. Start the API server (with workers)
npm run dev -w apps/api

# 3. Start the chat UI
npm run dev -w apps/ui

# 4. Verify the brain has data
curl http://localhost:3001/health
# Should show: { status: "ok", qdrant: "ok", neo4j: "ok", redis: "ok" }

# 5. Open the chat UI
open http://localhost:3000
# Select project: encode_httpx
```

---

## Demo Flow (7 minutes)

### Act 1 — Context (30 seconds)

> "I've been away for two weeks. The httpx project had 50+ GitHub events in that time.
> Normally I'd spend an hour reading through PRs. Let's see what the brain says."

---

### Act 2 — Decision queries (4 minutes)

Run these queries in the chat UI, in order. Each takes < 5s with Claude API.

**Query 1 — Compression policy**
```
What is the httpx 1.0 compression policy? What formats will be supported?
```
*Expected:* gzip only, zstd deferred. Citations: PR #3613 comments.  
*Talking point:* "It found the 4 comments across that PR thread and synthesised the decision."

**Query 2 — Breaking changes**
```
Which Python versions were dropped from the test matrix?
```
*Expected:* Python 3.10 dropped. Citation: PR #3730.  
*Talking point:* "One citation, directly to the commit that made the change."

**Query 3 — Security**
```
What decision was made about enforcing minimum h11 or httpcore versions for the security fix?
```
*Expected:* No minimum version enforced; users upgrade directly. Citations: PR #3691, #3564.  
*Talking point:* "Security decision — it found the rationale, not just the PR title."

**Query 4 — Deferred work**
```
What design decisions are currently deferred or pending?
```
*Expected:* MockTransport elapsed time, possibly others. Citations: PR #3719, #3715.  
*Talking point:* "This is the 'what should I pick up next' query. It surfaces the open questions."

**Query 5 — Broad summary**
```
What are the most significant architectural decisions made in the httpx project recently?
```
*Expected:* Compression, asyncio, URL credentials, Python version support.  
*Talking point:* "Five minutes in and you have a full decision log."

---

### Act 3 — Show citations (1.5 minutes)

Click a citation card in the UI.

- Show the source URL opening directly to the GitHub comment
- Point out: the answer text is grounded — every sentence has a [N] marker
- Point out: no hallucination, all URLs are real encode/httpx links

*Talking point:* "The brain doesn't generate facts. It retrieves them and attributes them."

---

### Act 4 — Scope honesty (1 minute)

Run this query to show the system knows its limits:

```
What is the httpx 1.0 release date?
```
*Expected:* "No information found" — the release date is not in the ingested PRs.  
*Talking point:* "It doesn't make up an answer. If it's not in the data, it says so."

---

## Key Messages

1. **Decisions, not noise** — The brain indexes design choices, not every commit.
2. **Always cited** — Every claim links back to the original GitHub source.
3. **Honest about gaps** — Unanswered questions get "no information", not hallucinations.
4. **Works across your stack** — GitHub today; Slack, Jira, meeting notes in Phase 2.

---

## End-to-End Eval Results (Phase 1)

| Eval | Result | Target |
|------|--------|--------|
| M7.1 Extraction accuracy | Precision 92.3%, Recall 80.0% | P > 80%, R > 70% |
| M7.2 Query accuracy | 83.3% (15/18 correct or partial) | > 80% |
| M7.3 Citation accuracy | 0 fabricated / 24 citations | 0 fabricated |
| M7.4 Latency (Claude API) | p95 < 2s | p95 < 5s |
| M7.4 Latency (Ollama/local) | p95 ~40s (known, dev-only) | — |

---

## Switching to Claude API for the Demo

Ollama queries take ~35s each — too slow for a live demo. Use the Claude API config:

```bash
cp apps/api/.env.claude.template apps/api/.env
# Edit .env and set: ANTHROPIC_API_KEY=sk-ant-<your-key>
# No pipeline:reset needed — same 768-dim embeddings
npm run dev -w apps/api
```

---

## Resetting for a Fresh Demo

```bash
# Wipe brain state and re-ingest from scratch
npm run pipeline:reset -w apps/api

# Re-seed GitHub events
npm run seed:github -w apps/api -- --repo encode/httpx --limit 50

# Wait for workers to process (~2 min), then demo
```
