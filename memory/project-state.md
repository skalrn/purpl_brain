---
name: project-state
description: Current build state, what's working, what's next, and key decisions made
metadata:
  type: project
---

## What's built (as of 2026-05-16)

All 6 Phase 1 milestones are complete and working end-to-end.

### Stack
- **Monorepo:** npm workspaces — `apps/api` (Fastify + TypeScript), `apps/web` (Next.js), `packages/types` (shared types)
- **Infra (Docker Compose):** Redis, Qdrant, Neo4j. Ollama runs natively on host (not in Docker).
- **LLM:** Gemma4:latest via Ollama for local dev. Switch to Anthropic via `LLM_PROVIDER=anthropic` in `.env`.
- **Embeddings:** nomic-embed-text:v1.5 via Ollama (already pulled).
- **Graph DB:** Neo4j (replaces Kuzu from original plan — Kuzu is Python-only).

### Pipeline (all working)
```
GitHub webhook → events:raw → [normalizer] → events:normalized → [extractor] → events:extracted → [brain-writer] → Neo4j + Qdrant
```

### Workers (each runs in its own terminal)
- `cd apps/api && npm run dev` — Fastify API on port 3001
- `cd apps/api && npm run worker:normalizer` — reads events:raw, enriches, writes events:normalized
- `cd apps/api && npm run worker:extractor` — LLM decision extraction, writes events:extracted
- `cd apps/api && npm run worker:brain-writer` — writes to Neo4j + Qdrant
- `cd apps/web && npm run dev` — Next.js UI on port 3000

### Key files
- `apps/api/src/routes/webhooks.ts` — GitHub webhook, HMAC verification, Redis enqueue
- `apps/api/src/workers/normalizer.ts` — Pass 1 rule-based enrichment
- `apps/api/src/workers/extractor.ts` — Gemma4 decision extraction
- `apps/api/src/workers/brain-writer.ts` — dual write Neo4j + Qdrant
- `apps/api/src/services/query-engine.ts` — RAG + Neo4j graph expansion + answer generation
- `apps/api/src/services/temporal-engine.ts` — time-range changelog queries
- `apps/api/src/lib/llm.ts` — unified LLM wrapper (Ollama/Anthropic switchable)
- `apps/api/src/lib/embed.ts` — nomic-embed-text embeddings via Ollama
- `apps/web/app/components/Chat.tsx` — chat UI with temporal query auto-detection
- `apps/web/app/components/CitationCard.tsx` — expandable citation cards
- `apps/web/app/components/Changelog.tsx` — temporal diff panel

### Working test
- GitHub repo: `skalrn/purplbox`
- Project ID in UI: `skalrn_purplbox`
- ngrok: `https://cleft-machine-thesaurus.ngrok-free.dev` (may change on restart)
- Query "what decisions were made about the event queue?" returns correct answer with citations
- Query "what changed last 7 days" returns changelog panel

### Known issues / deferred
- **Duplicate citations:** old events indexed before brain-writer fix have duplicate chunks in Qdrant. Fix: delete `brain_chunks` collection and re-ingest. Low priority until self-use phase.
- **Latency ~30s locally:** Gemma4 on CPU. Switch to `LLM_PROVIDER=anthropic` or run on GPU for real use.
- **No auth:** single-user, no access controls. Phase 4 work.
- **No historical ingest:** only events since webhook was set up. Historical backfill not built yet.
- **Contradiction/supersedes detection:** deferred to Phase 3 anomaly engine.

## What's next

**Milestone 7 — Self-use and calibration (Deepak is the first user)**
- Connect real repos (beyond purplbox test repo)
- Query daily instead of going to GitHub
- Log what's wrong: wrong answers, missing context, bad citations
- Tune extraction prompt if precision is low
- Fix latency (switch to Anthropic API or GPU)

**After self-use validation → beta (5-10 known contacts)**
- Add per-project basic auth (currently no access controls)
- Write data handling doc (what goes to Anthropic API, deletion policy)
- Set up stable VM (Hetzner CX42, ~$20/month) instead of ngrok

**Phase 2 after beta signal:**
- Agent write-back loop (`POST /brain/agent-log`)
- The Phase 2 agent hasn't been named yet — needs a decision before Phase 1 exit

## Key decisions made during build

- Switched from Python to Node/TypeScript (Deepak knows Node, not Python)
- Switched from Kuzu to Neo4j (Kuzu is Python-only, Neo4j has JS driver)
- Using Redis Streams directly, not BullMQ (architecture docs already specify Streams semantics)
- Ollama (local) for dev, Anthropic API for production — switchable via `LLM_PROVIDER` env var
- Gemma4:latest for both extraction and query (already pulled, 9.6GB)
- nomic-embed-text:v1.5 for embeddings (already pulled, 274MB)
- Contradiction detector deferred — too early without real data patterns
- Temporal query built now (not deferred) — needed for Phase 1 exit criterion Q3

## Cost estimates
- Local dev: $0 (all Ollama)
- Production (real beta, 25 repos, 2000 queries/month): ~$76/month (Hetzner $20 + Claude API $56)
