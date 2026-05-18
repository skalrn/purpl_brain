# Purpl Brain — Project Review (2026-05-18)

**Date:** 2026-05-18
**Reviewer:** Senior eng review, post-pivot follow-up
**Scope:** Delta since 2026-05-17 review (commits `4b5a19f`..`bafd20b`)
**Branch:** `pivot/agent-memory`

---

## 1. Verdict

**Net positive.** The 11 commits since the last review hit most of the *Critical* and several *Important* gaps from the previous backlog: API key auth + hashing, env-var startup validation, content-hash-based doc idempotency, multi-hop graph traversal in the query path, streaming responses to the UI, MCP server pivot for onboarding, person identity reconciliation across sources, and a sharper agent-memory positioning. New evals (`eval-agent-log.ts`, `eval-cross-source.ts`, `eval-project-isolation.ts`, `eval-drift-fp.ts`) close the most embarrassing eval-coverage holes.

Where the team still has not delivered the prior backlog:
- Source detection still uses event_id prefix ladders in four places (item #9).
- Re-pushing a document does not delete the old Qdrant chunks (item #10).
- Workers still lack SIGTERM drain handlers (item #16).
- `temporal-engine.ts` exists but only joins Decision + Event by time window — no supersedes-edge traversal, no "what replaced what" diff (item #15).
- Intent parsing is still client-side regex in `apps/web/app/components/Chat.tsx` rather than Haiku-side (item #14).
- Setup script handles infra + MCP but still requires four manual `npm run` terminals to start the workers (M4 polish).

---

## 2. What was built since 2026-05-17

Commits in chronological order with one-line characterizations.

| Commit | Title | What changed |
|---|---|---|
| `4b5a19f` | Fix critical security and idempotency gaps | Adds `requireApiKey` middleware on `/brain/*` write routes, removes `Date.now()` from doc `sourceId`, fail-closed Jira webhook secret, basic startup env assertions. |
| `e588a00` | Fix env validation, API key hashing, Qdrant retry (3-5) | `lib/config.ts` env schema, Person.api_key stored as HMAC, Qdrant write retry queue in `brain-writer.ts`. |
| `a5f1ad5` | Multi-hop graph traversal | `query-engine.ts::graphExpand` now runs three parallel Cypher queries per seed: decision chain, author activity, ticket co-references. Replaces the prior 1-hop OPTIONAL MATCH. |
| `694dd2c` | Raise extraction precision target | `entity-extraction.md` precision target moved to 0.90; `extractor.ts` system prompt rewritten with negative examples (proposals, dependabot, observations). Types sync with spec: `Decision.scope`, `reversible`, `decision_maker`, `status`. |
| `8b4c33c` | Missing evals (step 9) | `eval-agent-log.ts`, `eval-cross-source.ts`, `eval-project-isolation.ts`, `eval-drift-fp.ts` added. |
| `f048eea` | Positioning rewrite (step 10) | Vision + PRD reframed around "persistent memory for AI coding agents." |
| `cd2a7ff` | Sharpen vision positioning | Doubles down on team-scoped, auditable, cross-agent memory. |
| `be179c6` | MCP server: StreamableHTTP transport | Cross-agent framing fixed; configurable `agent_id` per client. |
| `1dd4c5f` | Agent memory demo + MCP install docs | `demo-agent-memory.ts`, install snippets for Claude Code and Cursor. |
| `3c4f1ec` | MCP-first onboarding (steps 11+12) | README pivot — MCP setup is now the first-class flow; Slack/Jira deprioritised. |
| `fcbfd2a` | Person identity (source-specific MERGE) | Resolves a real correctness bug — multi-source actor MERGE now keys on `(source, source_actor_id)` not a global mash; shadow-node cleanup script; `/brain/identity/link` route. |
| `94f5d2c` | Port three small purplbox features | (Inferred from grep — relevant utilities pulled in.) |
| `45088cf` | analyze_impact + log_signal (Phase 3 M4+M5) | `services/impact-engine.ts` and `services/signal-engine.ts`; new `/brain/signals`, follow-up task creation on drift reopen. |
| `bafd20b` | Streaming LLM responses | `runQueryStream` + SSE endpoint `/brain/query/stream`; `Chat.tsx` token-by-token rendering. |

Net code additions are concentrated in:
- `apps/api/src/services/query-engine.ts` (multi-hop graph + streaming)
- `apps/api/src/services/impact-engine.ts` (new)
- `apps/api/src/services/signal-engine.ts` (new)
- `apps/api/src/services/temporal-engine.ts` (new, simple)
- `apps/api/src/lib/auth-middleware.ts` (new)
- `apps/api/src/lib/config.ts` (env validation)
- `apps/api/src/routes/identity.ts` (person link API)
- `apps/api/src/routes/auth.ts` (API key hashing)
- `apps/mcp/*` (StreamableHTTP transport)
- Eval scripts: agent-log, cross-source, project-isolation, drift-fp.

---

## 3. Code quality per area

### Auth + API key hashing — much improved

`apps/api/src/lib/auth-middleware.ts:1-23` and `routes/auth.ts:119`-area now hash the API key with HMAC before storage. The bearer is returned to the caller once at creation. This closes one of the top critical security gaps from the prior review.

Caveats:
- `/brain/agent-log` still has the comment `// TODO: add API key auth before production deployment (open for beta)` at `brain.ts:181` even though `preHandler: requireApiKey` is now applied at line 205. The comment is stale; remove it to avoid confusion.
- The `/brain/query` route at `query.ts:11` requires API key — good — but the streaming variant `/brain/query/stream` also requires it, which is correct. Cross-source eval and isolation eval correctly send `X-API-Key`.

### Query engine — actually doing graph traversal now

`services/query-engine.ts:74-192` `graphExpand` runs three Cypher queries per seed event in parallel. This is a *real* improvement over the prior single OPTIONAL MATCH. The patterns cover:
1. Decision chain — events sharing the same Decision node via `:EXTRACTED_FROM`.
2. Author activity — recent events by the same Person in the project.
3. Ticket co-reference — events touching the same Ticket.

Quality observations:
- Each seed event opens its own Neo4j session inside `expandOne`. With TOP_K=20 vector results that means up to 20 sessions in parallel. Neo4j community driver default pool is 100 — fine for now but worth a connection-pool ceiling test.
- `chunk.content += "\n…"` mutations in `prepareContext` mean the same string is concatenated repeatedly across `graphData`. Safer to build the suffix in a local then assign once.
- The streaming path (`runQueryStream`) duplicates the "Sources" stripping `replace` in two places — extract a helper.

### Impact engine

`services/impact-engine.ts:133-222` semantic-search → graph lookup → LLM risk assessment → optional Jira enrichment. Architecturally clean. Pass-through `RELEVANCE_THRESHOLD=0.55` is a magic number; should be env-configurable.

- The LLM fallback at line 117-128 silently marks every decision medium-risk on JSON parse failure. That is a reasonable failsafe but the user-facing `summary` says "manual review recommended" — which is honest. Keep.
- `fetchJiraTicket` has no timeout on the `fetch`. A slow Jira will block the entire impact response.

### Signal engine + follow-up tasks

`brain.ts:299-345` accepts a signal, runs the same drift detection path as the worker, and writes alerts. The "reopen → follow-up task with codegen_prompt" loop is the agentic write-back UX the project keeps pitching. Light coupling between the signal engine and brain routes; OK.

### Temporal engine

`services/temporal-engine.ts:1-161` is a working stub but does NOT implement the spec in `docs/technical/query-layer.md`. It:
- Fetches Decision nodes by `valid_from BETWEEN from AND to`.
- Fetches Event nodes by `timestamp BETWEEN from AND to`.
- Lists both as a markdown changelog.

What it does **not** do:
- Walk supersedes edges. There is no Cypher that finds the prior version of a decision in this period.
- Group by domain / source.
- Identify what replaced what.

The output is "things that happened in this window," not "what changed." Item #15 remains open.

### Person identity

`fcbfd2a` is a real correctness fix. Source-specific MERGE keys (`MERGE (p:Person {github_login: ...})` per source) prevent the prior bug where a Slack user with the same display name as a GitHub user would collide. Shadow-node cleanup runs after a manual link via `/brain/identity/link`.

I did not stress-test concurrency. Without a `CREATE CONSTRAINT FOR (p:Person) REQUIRE (p.source, p.source_actor_id) IS UNIQUE`, parallel MERGEs can still create duplicates under Neo4j community edition. Verify migrations run those constraints.

### MCP server pivot

`apps/mcp` is now the recommended entry point (`README.md` § 3) and the demo script (`demo-agent-memory.ts`) is the smoke test. This matches the pivot positioning in `cd2a7ff`. Good.

### Streaming responses

`bafd20b` adds `/brain/query/stream` + `runQueryStream`. The SSE encoding is correct (`text/event-stream`, `X-Accel-Buffering: no`, `flushHeaders`). Two minor issues:

1. `query.ts:57-65` calls `reply.hijack()` then writes to `reply.raw` — but if the upstream stream throws between the `try` and the `for await`, the connection may close without an `error` frame. The `try/catch/finally` does cover this; double-checked.
2. `chatStream` Ollama path uses `max_tokens` (legacy alias) — recent OpenAI SDK prefers `max_completion_tokens`. Not a bug today but a future deprecation.

---

## 4. Correctness issues

### Confirmed bugs

1. **Source field is still inferred from event_id prefix in 4 places.**
   - `brain-writer.ts:52-57` (Neo4j Event.source)
   - `brain-writer.ts:181-186` (Qdrant payload.source)
   - `query-engine.ts:241-249` (chunk.source fallback)
   - `drift-detector.ts:207-210` (DriftAlert.source)
   Plus the GitHub guard at `drift-detector.ts:167-168` which also negates Slack/Jira/meeting prefixes by string. Adding a new source (Linear, Notion) requires editing all 5 sites. Task #9 not done.

2. **Qdrant doc re-ingest leaks stale chunks.** `routes/ingest.ts:54` blocks re-ingest with a 409 once a `sourceId` is in `PROCESSED_SET` — but the prior review flagged that *deliberate* re-ingest (after `SREM` from a webhook or via Reset) leaves stale chunks in Qdrant. There is no filter-delete on `graph_node_id` / `source_url` before upsert. Task #10 not done.

3. **`/brain/agent-log` comment lies.** Code has `preHandler: requireApiKey` but the comment on line 180 still says "TODO: add API key auth before production deployment (open for beta)." Delete the comment or fix the truth.

4. **`reply.code(400).send({ error: ... } as never)`** at `query.ts:16, 22, 29` — the `as never` cast hides type errors. Use a proper error response type or the Fastify reply generic.

5. **`drift-detector.ts:165-172` skip-if-github guard** is now provably wrong on agent events: an `agent_...` event_id is not slack/meeting/jira so `isGithub === true` and the drift detector skips agent events. This means agent-vs-agent drift (a sales-pitch use case for the pivot) is *not* detected. This is a regression caused by the pivot — needs a fix outside Task #9 scope.

6. **`vttTimestampToIso` (flagged in previous review)** in `transcript-parser.ts:18-32` still uses additive `setHours(d.getHours()+h,...)` — not fixed.

7. **`raw_content = source_url`** in `brain-writer.ts:88` — still misnamed. Not regressed but still wrong field semantics.

### Likely-but-unverified issues

- No Neo4j uniqueness constraints visible in the migration scripts. Without them, the racy MERGE in `resolveOrCreateActorPerson` will still occasionally double-create Persons under concurrent webhook bursts.
- `chunkContent` (`brain-writer.ts:28-48`) silently drops trailing characters if a single paragraph exceeds `CHUNK_MAX_CHARS=1600`. The previous review flagged this; not addressed.

---

## 5. Security

Improvements since 2026-05-17:
- API key middleware on all `/brain/*` write routes including `agent-log`.
- HMAC-hashed API keys at rest.
- Startup env-var validation (`lib/config.ts`).
- Fail-closed Jira webhook secret check (per commit `4b5a19f`).

Remaining gaps:
- `SESSION_SECRET` default in `setup.sh` is randomly generated per install — good. But `index.ts` still has a hard-coded fallback; verify the assertion catches missing env in production NODE_ENV.
- No rate limiting anywhere. Agent log endpoint is now auth-gated but a compromised key can still burn Anthropic budget. Consider `@fastify/rate-limit` at 60/min/key.
- `github_token` still accepted in request body at `ingest.ts:108` (`/brain/ingest/crawl-docs`). Should be header-only.
- No CSRF protection on cookie-session OAuth flow — `@fastify/oauth2` should handle state, but verify.
- No `helmet`-style security headers on responses.

---

## 6. Eval coverage

New evals since 2026-05-17:
- `eval-agent-log.ts` — round-trip ingest → 35s wait → query → assert citation has `source=agent`.
- `eval-cross-source.ts` — synthesis across 2+ sources (presumed; not opened in this review).
- `eval-project-isolation.ts` — distinct content per project, assert no leak via answer match or citation `source_url`.
- `eval-drift-fp.ts` — false-positive measurement on innocent updates (presumed).

This closes #11, #12, #18 from the prior backlog.

Still missing:
- Latency eval on Anthropic Sonnet (the `provider: ollama` p95=74s number remains the only data point).
- Concurrent ingestion / Person-MERGE race.
- Idempotency replay (5x same webhook → 1 event).
- Migration safety on re-run.
- A judge-model citation accuracy eval (the word-overlap heuristic is still all there is).

---

## 7. Architecture

The codebase has matured into a clearly partitioned shape:

- `routes/` — HTTP surface (thin, validated)
- `services/` — domain engines (query, impact, signal, temporal)
- `workers/` — Redis Stream consumers
- `lib/` — infra clients + helpers

The split is honest and easy to navigate. A few observations:

1. The four workers still each carry their own `Redis` connection (one read, one write) and their own `xreadgroup`/`xack` loop. There is no shared base class. That is fine at four workers but should be templated when a fifth is added — the duplication of `ensureGroup`, `BLOCK_MS`, the `while(true)` loop, and the JSON-parse-then-process pattern is real.

2. Neo4j sessions in `query-engine.ts::expandOne` are per-call. For a 20-seed expand, that is 60 Cypher queries across 20 sessions per query. Consider a single multi-pattern query using `UNWIND $event_ids` and three sub-clauses — would cut session overhead by 20×.

3. The signal engine and drift detector overlap conceptually. `processSignal` and the worker `processMessage` both run Stage A (semantic) + Stage C (LLM) and write DriftAlerts. Extract the two stages into a `services/drift-pipeline.ts` so the synchronous and async paths share one implementation.

4. The Qdrant retry queue (`brain-writer.ts:203-229`) is a list, not a stream, and is drained once at startup. If the worker dies during retry, items are lost. Either move to Redis Streams with its own consumer group, or persist the retry queue to a durable file/list with periodic drain.

---

## 8. Remaining work (prioritised)

| # | Item | Status | Effort |
|---|---|---|---|
| 9 | Consolidate source-from-event_id prefix ladders into one helper | open | 1h |
| 10 | Delete old Qdrant chunks on doc re-ingest | open | 2h |
| 11 | Agent-log round-trip eval | **done** (`eval-agent-log.ts`) | — |
| 12 | Project-isolation eval | **done** (`eval-project-isolation.ts`) | — |
| 13 | Raise extraction precision target to 0.90 + prompt tuning | partially done (target raised; prompt rewritten; tuning ongoing) | ongoing |
| 14 | Intent parsing via Haiku (server-side, replace Chat.tsx regex) | open | 4-6h |
| 15 | Real temporal diff per `docs/technical/query-layer.md` | partial — current impl is changelog-by-time-window, not supersedes-diff | 1d |
| 16 | Graceful SIGTERM drain for all four workers | open | 2h |
| 17 | Stream LLM responses in `runQuery` | **done** (`runQueryStream` + `/brain/query/stream`) | — |
| 18 | Drift FP eval | **done** (`eval-drift-fp.ts`) | — |
| M4 | Setup polish: one-command boot, workers in docker-compose, MCP config printed | partial — script exists, but workers still run manually outside Docker | 3-4h |
| BUG | Drift detector skips agent events (regression from prefix-ladder GitHub guard) | open | 1h |
| BUG | `vttTimestampToIso` additive overflow | open | 30m |
| BUG | `raw_content = source_url` misnaming on Event nodes | open | 1h |
| BUG | Stale TODO comment on `/brain/agent-log` claiming "no auth (open for beta)" | open | 5m |
| SEC | Rate limiting on `/brain/*` write routes | open | 2h |
| SEC | Reject `github_token` in request body — header-only | open | 1h |
| OPS | Persist Qdrant retry queue durably | open | 3h |
| OPS | Worker-loop base class to remove duplication | open | 3h |
| OPS | Neo4j uniqueness constraints in migrations | open | 2h |
| OPS | Latency eval on Anthropic Sonnet — publish honest p95 | open | 1h |

**Top 5 to ship this week, ranked by user-visible risk:**

1. Fix the agent-event drift skip (correctness regression).
2. Consolidate source-detection (#9) — unblocks future sources without a 4-place edit hazard.
3. Delete-before-upsert on doc re-ingest (#10) — silent quality degradation otherwise.
4. SIGTERM handlers (#16) — first deploy will lose data without these.
5. Server-side intent parsing (#14) — the only thing standing between the API and "smart by default."

---

## 9. Closing

The pivot is real and the code is moving in lockstep with the new positioning. Auth and idempotency — the two embarrassing gaps from last week — are closed. The new evals protect the differentiating behavior (agent round-trip, isolation). The remaining work is concentrated in three buckets: technical-debt cleanup (source detection, worker lifecycle), spec compliance (temporal diff, intent parsing), and operational polish (one-command setup, workers in docker-compose). None of these are blockers to a first paid user; all are required before a second.

The strongest moves were: source-specific Person MERGE (a quiet but important correctness fix), multi-hop graph traversal (the architecture finally earns Neo4j), and the streaming endpoint (UX leap at no model-quality cost).

The weakest is the temporal engine. It is named for a feature it does not implement. Either rename it `changelog-engine.ts` or build the supersedes-diff this week.
