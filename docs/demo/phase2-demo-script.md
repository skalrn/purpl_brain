# Purpl Brain — Demo Script (Phase 2)

## Scenario

**Project:** `encode/httpx` — a popular Python HTTP client library  
**Setup:** The brain has ingested GitHub PRs, Slack channel history, Jira issues, and a meeting transcript  
**Persona:** A senior engineer returning after 2 weeks away

The demo answers two questions:
1. *"What decisions were made while I was away — across every source?"*
2. *"Is anyone on the team already pushing back on those decisions?"*

Phase 1 answered question 1 from GitHub alone. Phase 2 answers both, across all channels.

---

## What's New in Phase 2

| Capability | Phase 1 | Phase 2 |
|------------|---------|---------|
| Ingestion sources | GitHub PRs only | GitHub + Slack + Jira + meeting transcripts |
| Drift detection | — | Flags messages that challenge settled decisions |
| Cross-source query | — | Single query spans all sources, cites each |
| Drift resolution | — | Engineer marks alerts as keep / under_review / reopen |

---

## Baseline: Manual Multi-Source Catch-up

| Task | Manual (estimated) |
|------|--------------------|
| Scan 50 GitHub PRs | 8 min |
| Read Slack backlog (2 weeks) | 20 min |
| Check Jira for new issues | 10 min |
| Review meeting notes | 5 min |
| Cross-reference for conflicts | 15 min |
| **Total** | **~58 min** |

With the brain: same coverage in **< 3 min**, fully cited, with conflict detection.

---

## Pre-Demo Checklist

```bash
# 1. Start infrastructure
docker compose up -d          # Redis, Neo4j, Qdrant

# 2. Start workers + API
npm run dev -w apps/api
npm run worker:normalizer -w apps/api
npm run worker:extractor -w apps/api
npm run worker:brain-writer -w apps/api
npm run worker:drift -w apps/api

# 3. Seed all sources (if starting fresh)
npm run seed:github -w apps/api -- --repo encode/httpx --limit 50
npm run seed:slack -w apps/api -- --project encode_httpx
npm run seed:jira -w apps/api -- --project encode_httpx

# 4. Ingest the meeting transcript
curl -X POST http://localhost:3001/brain/ingest/transcript \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "encode_httpx",
    "title": "httpx weekly sync",
    "text": "Team agreed to keep the transport API public but add a stability warning. No retry logic in core — use tenacity. Auth stays synchronous for 1.0.",
    "participants": ["tomchristie", "adriangb", "florimondmanca"]
  }'

# 5. Start UI
npm run dev -w apps/ui

# 6. Verify data
curl http://localhost:3001/health
curl "http://localhost:3001/brain/drift-alerts?project_id=encode_httpx" | jq '.alerts | length'
# Should be > 0 (pending drift alerts)

# 7. Switch to Claude API for live demo (Ollama is too slow)
# Edit apps/api/.env: set ANTHROPIC_API_KEY, comment out OPENAI_BASE_URL
```

---

## Demo Flow (~10 minutes)

### Act 1 — Context (30 seconds)

> "I've been away two weeks. The project is active — GitHub PRs, Slack threads, Jira tickets, a sync meeting. 
> Normally catching up takes an hour. Let's see what the brain says, across all of those."

---

### Act 2 — Multi-source decision queries (4 minutes)

Run in the chat UI. Each query draws from whichever source has the answer.

**Query 1 — Compression (GitHub + Slack)**
```
What is the httpx compression policy, and is there any pushback on it?
```
*Expected:* Gzip-only for 1.0 (GitHub PRs). At least one Slack message questions whether zstd should be added now that CPython 3.13 ships it natively.  
*Talking point:* "One query, two sources. The decision came from GitHub. The dissent came from Slack. It surfaced both."

**Query 2 — Jira: authentication API**
```
What decision was made about the httpx public authentication API surface?
```
*Expected:* Auth stays synchronous for the 1.0 public API, even though the underlying transport is async. Source: Jira HTTPX-101.  
*Talking point:* "This decision existed only in Jira. It's now queryable alongside GitHub decisions."

**Query 3 — Jira: retry policy**
```
Where should retry logic live in httpx — in the core client or elsewhere?
```
*Expected:* Retry is explicitly not part of the core client. Use tenacity or a middleware layer. Source: Jira HTTPX-102.  
*Talking point:* "Before this, you'd have to know to search Jira. Now it answers the same way regardless of where the decision was recorded."

**Query 4 — Cross-source drift awareness**
```
Are there signals suggesting the asyncio.get_event_loop decision should be revisited?
```
*Expected:* The asyncio decision was made in GitHub (use `asyncio.create_task()`). A Slack message and a Jira comment both question whether that's safe given third-party library compatibility.  
*Talking point:* "This is the question a decision-aware system should be able to answer. Not just 'what was decided' — but 'is it still holding?'"

**Query 5 — Summary**
```
What are the most significant architectural decisions made in this project?
```
*Expected:* Compression, asyncio, URL credentials, Python version support, auth API, retry policy placement.  
*Talking point:* "Five minutes in. Decisions from GitHub, Jira, and a meeting — surfaced together."

---

### Act 3 — Drift alerts (3 minutes)

This is the feature that doesn't exist in any other tool.

**Step 1 — Show active alerts via API**

```bash
curl "http://localhost:3001/brain/drift-alerts?project_id=encode_httpx" | jq '.alerts[] | {source, content: .content[:80], decision: .decision_summary[:60]}'
```

*Talking point:* "The brain detected these automatically. No one had to flag them. A Slack message or Jira ticket came in, the system compared it to the settled decisions, and it raised an alert."

Walk through one alert:
- Source: `slack` or `jira`
- Content: the message that challenges a decision
- Decision: the original decision it challenges (from GitHub)
- Status: `pending`

**Step 2 — Resolve an alert**

Pick the gzip/zstd drift alert. Show the alert ID, then resolve it:

```bash
# Get the alert ID from the previous call
ALERT_ID="<paste alert_id from above>"

curl -X POST "http://localhost:3001/brain/drift-alerts/$ALERT_ID/resolve" \
  -H "Content-Type: application/json" \
  -d '{"resolution": "under_review"}'
```

*Expected response:* `{ "ok": true }`

*Talking point:* "The engineer just triaged this in 10 seconds. The decision isn't being reversed — it's being flagged for the next planning meeting. The graph now reflects that. Any future query about the compression policy will know it's under review."

---

### Act 4 — Citations across sources (1.5 minutes)

Run a query that should pull from multiple sources:

```
What is the current status of the gzip compression decision?
```

Point out in the citations panel:
- At least one citation with `source: github` (the original decision PR)
- At least one citation with `source: slack` or `source: jira` (the challenge)
- Each citation has a URL, actor name, and timestamp

*Talking point:* "GitHub cites GitHub. Slack cites Slack. The provenance is preserved — you can click through to the exact comment in either tool."

---

### Act 5 — Scope honesty (30 seconds)

```
What decisions were made about GraphQL support in httpx?
```

*Expected:* "No information found."

*Talking point:* "Still says no info when it genuinely has none. The new sources don't introduce hallucination — they just expand what it knows."

---

## Key Messages

1. **All your channels, one query interface** — GitHub, Slack, Jira, meetings. One question spans all of them.
2. **Decisions stay settled until something challenges them** — The drift detector catches conflicts before they ship as bugs.
3. **Every answer is cited by source** — Not "someone decided this" but "tomchristie wrote this in Jira HTTPX-102 on May 14."
4. **Engineers resolve, the brain tracks** — Marking a drift alert as under_review is a 10-second operation that updates the knowledge graph.

---

## End-to-End Eval Results (Phase 2)

| Eval | Result | Target |
|------|--------|--------|
| M7.1 Extraction accuracy | Precision 92.3%, Recall 80.0% | P > 80%, R > 70% |
| M6 Query accuracy (22 queries) | 81.8% correct or partial | > 80% |
| M7.3 Citation accuracy | 0 fabricated / 24 citations | 0 fabricated |
| M7.4 Latency (Claude API) | p95 < 2s | p95 < 5s |
| M2+M4 Drift recall | 100% (4/4 signals caught) | ≥ 80% |
| M2+M4 Drift precision | 89% | ≥ 70% |
| Sources covered | GitHub, Slack, Jira, meetings | All four |

---

## Resetting for a Fresh Demo

```bash
# Wipe all brain state
npm run pipeline:reset -w apps/api

# Re-seed all sources
npm run seed:github -w apps/api -- --repo encode/httpx --limit 50
npm run seed:slack -w apps/api -- --project encode_httpx
npm run seed:jira -w apps/api -- --project encode_httpx

# Workers process events automatically (~2-3 min for full pipeline)
# Drift alerts appear in Neo4j once drift-detector processes events
```

---

## Switching Between LLM Backends

```bash
# Claude API (recommended for live demos — p95 < 2s)
# Edit apps/api/.env:
#   ANTHROPIC_API_KEY=sk-ant-<your-key>
#   Comment out: OPENAI_BASE_URL

# Ollama (local, no API cost — p95 ~40s, too slow for live demo)
# Edit apps/api/.env:
#   OPENAI_BASE_URL=http://localhost:11434/v1
#   OPENAI_API_KEY=ollama
#   LLM_MODEL=qwen2.5:14b
```
