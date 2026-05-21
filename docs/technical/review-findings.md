# Technical Review Findings — 2026-05-20

Comprehensive review of the purpl_brain codebase prior to the M3/M4 beta cut. Findings are grouped by severity. Each finding has an ID that the companion remediation plan (`remediation-plan.md`) refers to.

Severity tiers:

- **Critical** — silent data loss, security exposure, broken core promise, or system-down risk. Block beta.
- **High** — observable degradation, real-world failure modes the dev environment hides, or a documented spec promise that is not implemented.
- **Medium** — observability gaps, latency / efficiency wins, polish, and small correctness issues.
- **Eval gap** — coverage hole. We don't know if these behaviours work because no test exercises them.

---

## Critical

### C1 — Python SDK posts to `/query` instead of `/brain/query`

- **Files:** `packages/python/purpl_brain/tools_langgraph.py:37,102`; `packages/python/purpl_brain/tools_adk.py:49,129`
- **Issue:** Both wrappers call `client.post("/query", ...)`. The query route is registered behind the `/brain` prefix, so the actual path is `/brain/query`. Every LangGraph and ADK agent gets a 404 on `brain_query` and `brain_analyze_impact`. The two non-MCP paths to the brain are non-functional.
- **Fix:** Change both call sites to `client.post("/brain/query", ...)`. Add an integration test that runs the LangGraph and ADK wrappers end-to-end against a live API.

### C2 — StreamWorker never xacks on exception; `drainPending` unconditionally acks on retry

- **File:** `apps/api/src/lib/stream-worker.ts:108-130` (live loop) and `:68-101` (drain)
- **Issue:** When `processMessage` throws in the live loop the catch block logs and continues with no `xack`. The message stays in the consumer's pending-entries list (PEL) forever. On the next restart, `drainPending` retries it; if it fails again the code unconditionally `xack`s it (line 93) and the message is dropped permanently. So every transient failure either leaks PEL entries indefinitely or silently destroys the message on the next restart.
- **Fix:** Track per-message attempt count in a Redis hash (`retry:attempts:{stream}:{id}`). After N attempts, copy the payload to a dead-letter stream (`events:dead`) before acking. Live-loop failures must ack (or XCLAIM-defer); never leave PEL entries unbounded.

### C3 — Anthropic SDK pinned to `^0.24.0`, which predates current model IDs and prompt-caching types

- **Files:** `apps/api/package.json:53`; `apps/api/src/lib/llm.ts:24,28,64,133`
- **Issue:** SDK 0.24 shipped mid-2024. The model IDs in use (`claude-sonnet-4-6`, `claude-haiku-4-5-20251001`) didn't exist when it was published. Every `cache_control` call uses `as unknown as Anthropic.Messages.TextBlockParam[]` because the SDK's type for `TextBlockParam` doesn't include `cache_control`. We are shipping against types we know to be wrong.
- **Fix:** Bump `@anthropic-ai/sdk` to the latest minor (>= 0.40 — covers caching, streaming, model IDs). Remove the `as unknown as` casts.

### C4 — Anthropic calls violate every prompt-caching rule in `llm-cost-controls.md`

- **File:** `apps/api/src/lib/llm.ts:58-72,125-146`; `apps/api/src/services/query-engine.ts:299-310`
- **Issue:** Only the system prompt gets a `cache_control` breakpoint. The query engine then concatenates a 12K-token retrieved-context block into a plain user message string — that block is re-charged at full price on every query. Missing pieces: (1) second `cache_control` breakpoint on retrieved context, (2) 1-hour TTL on the extractor system prompt (per cost-controls spec), (3) sliding breakpoint for multi-turn sessions, (4) verification of `cache_read_input_tokens > 0`.
- **Fix:** Extend `chat()` / `chatStream()` signature to accept structured content blocks. Query engine passes retrieved chunks as a separate content block with cache_control on the last block. Use 1h TTL for extractor (bursty). Add an eval that asserts `cache_read_input_tokens > 0` after warm-up.

### C5 — Brain-writer creates duplicate Decision nodes on retry/replay

- **File:** `apps/api/src/workers/brain-writer.ts:99-129`
- **Issue:** `Decision` nodes are created with `CREATE` and a fresh `uuidv4()` per call. The `Event` MERGE is idempotent but the decision is not. Any reset/replay produces N duplicate decisions for every replayed event, inflating `decision_count`, breaking drift detection (multiple `Decision` rows for the same event_id), and corrupting eval scoring.
- **Fix:** Derive `decision_id = sha256(event_id + ":" + quoted_text.slice(0, 200)).hex` and `MERGE` on it. Replace `CREATE (d:Decision ...)` with `MERGE (d:Decision {decision_id: $decision_id}) ON CREATE SET ...`.

### C6 — `processed:event_ids` is a single global Redis SET shared across every project and tenant

- **File:** `apps/api/src/lib/redis.ts:14`; usage throughout webhooks/ingest
- **Issue:** All sources and all tenants share one unnamespaced Redis SET. A `delivery_id` collision (or any source that reuses an opaque integer) causes silent event drops across tenants. The set's TTL is also only renewed on the GitHub path, so it ratchets the entire global set on every GitHub webhook.
- **Fix:** Replace the global set with per-event Redis keys: `processed:{source}:{project_id}:{external_id}` set with `SET key 1 NX EX 2592000`. Drops the global lifecycle entirely.

### C7 — Idempotency check is TOCTOU (SISMEMBER then SADD allows duplicate enqueues)

- **Files:** `apps/api/src/routes/webhooks.ts:135-153,225-271,306-360`; `apps/api/src/routes/ingest.ts:59-90`; `apps/api/src/routes/brain.ts:134-186,250,306`; `apps/api/src/workers/extractor.ts:62-103`
- **Issue:** Every dedup site checks `SISMEMBER` first, then `SADD` after. Two concurrent webhook deliveries with the same `delivery_id` both see "not present", both `xadd` to the stream, both `sadd`. The result is two paid LLM extraction calls and two duplicate Decision nodes per replay. The GitHub `X-GitHub-Delivery` retry semantics make this a recurrent failure mode, not a theoretical one.
- **Fix:** Replace the two-step check with a single atomic `SET key 1 NX EX 2592000`. If the return is `OK` we are first to process; if `null` it's a duplicate.

### C8 — No `MAXLEN` on any Redis Stream → OOM on extractor stall

- **File:** `apps/api/src/lib/redis.ts:7-12`; every `xadd` call site
- **Issue:** `events:raw`, `events:normalized`, `events:extracted`, `events:drift` have no `MAXLEN`. If the extractor stalls (LLM outage, queue backpressure), sustained ingestion fills Redis without bound until it OOMs. Redis OOM takes down auth, dedup, all workers — full system outage.
- **Fix:** Every `xadd` call must include `MAXLEN ~ 100000`. Wrap `xadd` in a helper in `apps/api/src/lib/redis.ts` so the cap can't be forgotten.

### C9 — Embedding-model sentinel can be overwritten by workers starting before the API

- **Files:** `apps/api/src/index.ts:65-78`; `apps/api/src/workers/brain-writer.ts:268-274`; `apps/api/src/lib/qdrant.ts:59-68`
- **Issue:** `stampEmbeddingModel` unconditionally overwrites the sentinel point. The check that compares stored vs. current model only runs on API startup. If a worker boots first with a mismatched `EMBEDDING_MODEL` env, it silently stamps the wrong model and corrupts all retrieval — Qdrant points and live queries use different embedding spaces, cosine scores become meaningless.
- **Fix:** `stampEmbeddingModel` must call `checkEmbeddingModel` first and refuse to overwrite a non-null sentinel. On mismatch, fail loudly (exit non-zero) so the operator notices before bad data accumulates.

### C10 — `event_type` hardcoded to `"ingested"` for every Event node

- **File:** `apps/api/src/workers/brain-writer.ts:73-86`
- **Issue:** The canonical `event_type` carried on the `CanonicalEvent` (`pr_merged`, `slack_message`, `agent_log`, `meeting_transcript`, ...) is dropped at the Neo4j write site. The graph loses the distinction needed for filtering, persona-scoped queries, and analytics. Also: `event_type` is absent from `ExtractionResult` in the shared types.
- **Fix:** Add `event_type: EventType` to `ExtractionResult` (`packages/types/src/index.ts`). Propagate it through `extractor.ts` and write it on the Event node.

### C11 — Cross-project drift detection (ICP B promise) is not implemented

- **Files:** `docs/product/personas.md:64-92`; `apps/api/src/workers/drift-detector.ts:43-99`
- **Issue:** The ICP-B persona promises a cross-project drift view — "a decision in project A may contradict a decision in project B that the same person/org owns". `stageA` filters Qdrant by `project_id`. No detector path ever produces a cross-project `DriftAlert`. The feature in the product doc has no code path.
- **Fix:** Add a second drift pass scoped via `MEMBER_OF`: for each event, also search Qdrant against other projects the actor (or their org) belongs to. Surface alerts with a `cross_project: true` flag so the UI can render them differently.

---

## High

### H1 — Agent log bypasses normalizer/extractor → `ticket_refs`, `person_mentions`, `concept_tags` always empty

- **File:** `apps/api/src/routes/brain.ts:281-305`
- **Issue:** `POST /brain/agent-log` writes directly to `STREAMS.EXTRACTED` with hardcoded `ticket_refs: []` and `person_mentions: []`. So an agent that wrote "Implemented PROJ-412 by adopting the approach @alice suggested" produces no Ticket node, no Person mention link. `brain_analyze_impact` cannot traverse from the agent decision to the ticket it affects.
- **Fix:** Either route agent logs through `STREAMS.NORMALIZED` (gets free ticket/mention extraction from the normalizer), or extract `ticket_refs` and `person_mentions` inline at the agent-log handler using the same regex helpers the normalizer uses.

### H2 — Transcript chunks all carry the same timestamp

- **File:** `apps/api/src/routes/brain.ts:155-184`
- **Issue:** Every chunk written with `timestamp: baseDate`. The VTT/SRT parser produces per-segment timestamps but the route ignores them. `findPriorVersion` and any other temporal logic can't order decisions within a single meeting — they all collide at the meeting start time.
- **Fix:** When the parser has segment timestamps, set `timestamp` to the timestamp of the first segment in that chunk. Falls back to `baseDate` only for plain-text input with no time codes.

### H3 — Extraction failures silently dropped (no DLQ, no retry, no metric)

- **File:** `apps/api/src/workers/extractor.ts:215-233`
- **Issue:** `extractDecisions` returns `[]` on JSON parse failure after one retry. The message is acked. There is no record, no retry queue, no metric. We can't tell extraction failures apart from "no decisions found" — both look identical downstream.
- **Fix:** On terminal extraction failure: write the failing message to `events:dead` with the failure reason, increment a metric, log at warn level. Surface failed event count on the dashboard.

### H4 — Drift detector races brain-writer on `events:extracted`

- **Files:** `apps/api/src/workers/brain-writer.ts:240-249`; `apps/api/src/workers/drift-detector.ts:148-157`
- **Issue:** Both consume the same `events:extracted` stream. If the drift detector processes event B before the brain-writer has indexed event A (the existing contradicting decision), Stage A's Qdrant search returns nothing and the drift goes undetected. Behaviour depends on which worker happens to xreadgroup first — intermittent and silent.
- **Fix:** Brain-writer emits to a new `events:brain_written` stream (with `{event_id, project_id, has_decisions}`) after a successful Qdrant upsert. Drift detector reads `events:brain_written` instead of `events:extracted`. Guarantees the new event is fully indexed before drift comparison runs.

### H5 — Web client re-implements intent parsing in client-side regex

- **File:** `apps/web/app/components/Chat.tsx:39-88`
- **Issue:** `detectTemporal` parses the query in the browser, forces `mode: "temporal"` and synthesises a `time_range`, then routes to the non-streaming endpoint. The server intent parser is bypassed and streaming is mutually exclusive with intent classification.
- **Fix:** Delete client-side regex. Always send the raw query to the server (streaming endpoint). Server intent-parser returns the chosen mode in the SSE `done` event so the UI can render it.

### H6 — CDK MeteringStack rewrites `http://` to `https://` but the ALB has no TLS listener

- **File:** `apps/cdk/lib/metering-stack.ts:53-54`
- **Issue:** The Lambda's outbound metering POST is forced to `https://`. The ALB only exposes port 80. Result: every metering request is connection-refused and Marketplace always reports zero seats consumed.
- **Fix:** Either (a) add an HTTPS listener (443) with an ACM cert to the ALB, or (b) drop the `https://` rewrite and stay on internal `http://`. (a) is correct for AWS Marketplace and required for M6.

### H7 — `DEV_API_KEY` comparison is not constant-time

- **File:** `apps/api/src/lib/auth-middleware.ts:25-32`
- **Issue:** `raw === DEV_API_KEY` is plain `===` — exposes timing oracle. Less urgent than H8 because the dev path is gated on `NODE_ENV === "development"`, but still a fast-fix.
- **Fix:** Use `crypto.timingSafeEqual(Buffer.from(raw), Buffer.from(DEV_API_KEY))`. Handle the length-mismatch case so the function still returns a constant-ish result.

### H8 — Fireflies webhook secret comparison is non-constant-time

- **File:** `apps/api/src/routes/webhooks.ts:287`
- **Issue:** `sig !== secret` is `!==`. Vulnerable to timing analysis. Compare GitHub which already uses `timingSafeEqual` correctly.
- **Fix:** Use `timingSafeEqual` exactly like the GitHub path.

### H9 — Jira webhook token in query string → logged in every access log

- **File:** `apps/api/src/routes/webhooks.ts:196-202`
- **Issue:** `?token=` appears in the Fastify access log line (and downstream CloudWatch). Secret is in cleartext in log retention. Anyone with logs-read can replay webhooks.
- **Fix:** Accept the token via an HTTP header (`X-Jira-Webhook-Token`). Reject requests that put it in the query string. Update Jira webhook config and rotate the secret on deploy.

### H10 — `assertProjectMember` returns `true` when `req.actor?.person_id` is undefined

- **File:** `apps/api/src/routes/brain.ts:55-99` (and the corresponding lib code in `auth-middleware.ts:74-75`)
- **Issue:** The "safe fallback" comment is the wrong direction — if any future code path calls `assertProjectMember` before authentication has populated `req.actor`, every membership check silently passes. Should fail closed.
- **Fix:** When `person_id` is missing and `dev_bypass` is false, return 401 (or 404 to avoid resource disclosure). Never silently pass.

### H11 — `linkPersonIdentities` can merge Person nodes across projects

- **File:** `apps/api/src/routes/identity.ts:36-68`; `apps/api/src/lib/neo4j.ts:972-1081`
- **Issue:** `requireProjectMember` validates membership in project A, but `linkPersonIdentities` matches Person nodes globally. A user in project A can supply `slack_user_id` of someone whose events are only in project B and merge those identities — collapsing two real people across tenants.
- **Fix:** Constrain the candidate `MATCH` to people who have at least one Event in the caller's project(s): add `AND EXISTS { MATCH (e:Event {project_id: ...})-[:AUTHORED_BY]->(p) WHERE p IN callerProjects }`.

### H12 — No payload indexes on Qdrant — every query is a full-scan post-filter

- **File:** `apps/api/src/lib/qdrant.ts:40-48`
- **Issue:** `ensureCollection` creates the collection with no payload schema. There is no index on `project_id`, `has_decisions`, `source_id`, or `graph_node_id`. Qdrant filters these by post-scan. Latency grows linearly with collection size. Already noticeable at ~50k chunks; catastrophic at 500k.
- **Fix:** After collection creation call `qdrant.createPayloadIndex(COLLECTION, { field_name: "project_id", field_schema: "keyword" })` and equivalents for `source_id` (keyword), `graph_node_id` (keyword), `has_decisions` (bool). Add these to `ensureCollection`.

### H13 — Neo4j missing indexes on hot-path filter properties

- **File:** `apps/api/src/scripts/migrate-neo4j-constraints.ts:9-44`
- **Issue:** No index on `Event.project_id`, `Event.timestamp`, `Event.source`, `Decision.project_id`, `Decision.status`, `DriftAlert.resolution`, `FollowUpTask.project_id`. No uniqueness constraint on `Project.project_id`. Most queries in `query-engine.ts` and `neo4j.ts` filter on these.
- **Fix:** Add the indexes listed in the remediation plan to the migration script.

### H14 — `inferSourceFromEventId` defaults unknown prefixes to `"github"` → new sources silently skip drift

- **File:** `apps/api/src/lib/event-source.ts:14-21`
- **Issue:** Any source whose event_id prefix doesn't match a branch is classified as `"github"`. The drift detector explicitly skips github events. New sources go undetected for drift purposes.
- **Fix:** Default to a new `"unknown"` source. Drift detector treats unknown as eligible. Log a warning when classification falls through so we notice new prefixes early.

### H15 — `ExtractionResult` type drops `source` and `event_type`

- **File:** `packages/types/src/index.ts:107-121`
- **Issue:** The downstream writer has to re-infer source from the event_id string prefix and hardcodes `event_type: "ingested"`. The type system actively erases required information.
- **Fix:** Add `source: EventSource` and `event_type: EventType` fields. Producers (`extractor.ts`, `agent-log` handler) fill them in. C10 falls out for free.

### H16 — `chatJSON` invalidates system-prompt cache by appending JSON instruction at call time

- **File:** `apps/api/src/lib/llm.ts:90-111`
- **Issue:** When `systemMsg` is undefined, a 60-character fallback system prompt is constructed — below the 2,048-token minimum for Sonnet caching. Plus, dynamic concatenation of the JSON instruction differs each call site, fragmenting the cache.
- **Fix:** Hoist the JSON-instruction system prompt to a stable module-level constant. Make it the same string every time. Pass it as the structured `system` block so caching applies.

### H17 — Web UI stores API key in component state after fetching from `/auth/me`

- **File:** `apps/web/app/components/Chat.tsx:98-103,123,144`
- **Issue:** Key fetched from `/auth/me` and stored in React state. Defeats the httpOnly cookie protection — any XSS reads `window.__REACT_INTERNAL_INSTANCE__` and exfiltrates the key.
- **Fix:** Don't return the key to the browser. Server-side proxy the brain requests so the cookie carries auth on every call and the JS never sees the key.

### H18 — CORS config inconsistent between streaming and non-streaming routes

- **Files:** `apps/api/src/index.ts:28-31`; `apps/api/src/routes/query.ts:88-95`
- **Issue:** Global CORS accepts a single origin (env `WEB_ORIGIN`). The streaming route checks a comma-separated list. The two diverge for any deploy with more than one origin.
- **Fix:** Consolidate on the global CORS plugin with a comma-separated list. Streaming route no longer sets its own headers.

### H19 — `docker-compose.demo.yml` sets `NODE_ENV: demo` → dev-bypass disabled, demo 401s

- **File:** `docker-compose.demo.yml:69-83`; `apps/api/src/lib/auth-middleware.ts:25`
- **Issue:** `auth-middleware` only bypasses on `NODE_ENV === "development"`. The demo compose sets `demo`, so the seeded `DEV_API_KEY` is rejected on every call and the demo is effectively broken.
- **Fix:** Either change compose to `NODE_ENV=development` (and accept the implications), or introduce a `DEMO_MODE=true` flag the middleware honours explicitly. The second is preferred — keeps NODE_ENV honest.

### H20 — Release pipeline has no eval gate

- **File:** `.github/workflows/release.yml`
- **Issue:** Triggers on push to `release-*`, builds images, pushes to GHCR. No `typecheck`, no `eval:*` run. A broken main can ship to `beta-latest`.
- **Fix:** Add `npm run typecheck` and a curated short eval suite (extraction, query, MCP) as a required job before the image build.

### H21 — Workers have no health-check endpoints

- **Files:** `docker-compose.yml`; `apps/api/src/workers/*.ts`
- **Issue:** The API has `/health` but workers expose nothing. A wedged worker shows as "running" forever — ECS / docker compose can't restart it. Stalled extractor → pipeline silently halts.
- **Fix:** Each worker exposes a tiny HTTP server on a fixed port (3010, 3011, ...) returning 200 if the main loop made progress in the last N seconds, 503 otherwise. Wire to docker compose `healthcheck`.

### H22 — `POST /brain/signals` is fully synchronous

- **File:** `apps/api/src/routes/brain.ts:375-383`; `apps/api/src/services/signal-engine.ts`
- **Issue:** Every other ingest route enqueues to Redis and returns. Signals hold the HTTP connection open through embed + Qdrant search + Neo4j writes (~1-3 s). Hot agents calling this from a chain block themselves.
- **Fix:** Enqueue to a new `events:signals` stream and return immediately. A `signal-worker` consumes it and runs `processSignal`. Caller receives a `signal_id` they can poll if needed.

### H23 — `assembleContext` truncation breaks citation validator

- **File:** `apps/api/src/services/query-engine.ts:199-211,218-221`
- **Issue:** Chunks past the context budget are dropped from the prompt but the full chunk array is what `validateCitations` checks. The LLM can cite a chunk it never saw and `validateCitations` returns true.
- **Fix:** Only chunks that fit in the budget reach the validator. Trim the array before passing to `buildCitations` (return the trimmed list from `assembleContext`).

### H24 — Parallel embed + intent-parse optimisation not implemented

- **File:** `apps/api/src/services/query-engine.ts:232-260`; `apps/api/src/routes/query.ts:34-72`
- **Issue:** The route awaits `parseQueryIntent` then `embed` sequentially. The query-layer spec calls for these to run in parallel — ~400ms saved per query.
- **Fix:** Run both in `Promise.all`.

### H25 — `signal-engine` writes DriftAlert without LLM confirmation (Stage A only)

- **File:** `apps/api/src/services/signal-engine.ts:69-87`
- **Issue:** Any signal with cosine >= 0.6 creates a `DriftAlert` immediately with `confirmed_by_llm: false`. No Stage C confirmation. The MCP tool `brain_log_signal` is a noise machine.
- **Fix:** Reuse the drift detector's Stage C confirmation prompt before writing the alert. Set `confirmed_by_llm: true` only on confirmed cases. Skip writes on Stage-C-negative cases.

---

## Medium

### M1 — No metrics anywhere

Pipeline lag, worker error rate, LLM latency, cache hit rate are invisible. Fix: thin Prometheus exporter on each process; metrics for `stream_lag`, `worker_processed_total`, `worker_errors_total`, `llm_latency_ms`, `llm_cache_read_tokens`.

### M2 — `findPriorVersion` is O(N) unbatched

- **File:** `apps/api/src/services/temporal-engine.ts:294-303`
- **Issue:** N embed calls + N Qdrant searches + N Neo4j sessions per temporal query.
- **Fix:** Batch embeddings via `embedBatch`, single Qdrant search with `points` array, single Neo4j session.

### M3 — Anomaly engine spec defines 7 detectors; only semantic drift is implemented

- **Files:** `docs/technical/anomaly-engine.md`; `apps/api/src/workers/drift-detector.ts`
- **Fix:** Stub the missing detector files and document phasing in `anomaly-engine.md`. Track each in the milestone list.

### M4 — Source-specific extraction strategies not implemented

Slack thread context/reactions, meeting sliding window, Jira status-to-decision mapping — all dropped at the extractor.

### M5 — `expertise` and `agent-resume` query modes silently degrade to `project`

- **Files:** `packages/types/src/index.ts:127`; `apps/api/src/routes/query.ts:34-72`
- **Fix:** Either implement, or return 400 when those modes are requested, so callers get a deterministic signal instead of a silently wrong answer.

### M6 — `reset-pipeline.ts` has no `--confirm` flag and defaults to `encode_httpx`

- **File:** `apps/api/src/scripts/reset-pipeline.ts:51,98`
- **Fix:** Require `--confirm <project_id>` matching the target. Remove the hardcoded default project.

### M7 — Citation actor.type always `"human"` even for agent-source citations

- **File:** `apps/api/src/services/query-engine.ts:320-321`
- **Fix:** Carry `actor_type` through the Qdrant payload; map it back on citation construction.

### M8 — Slack listener calls `users.info` on every message with no caching

- **File:** `apps/api/src/workers/slack-listener.ts:94-97`
- **Fix:** TTL cache in Redis keyed by `slack:user:{user_id}` for 1 hour.

### M9 — `assembleContext` priority-order spec not implemented

- **File:** `apps/api/src/services/query-engine.ts:199-211`
- **Fix:** Sort chunks by retrieval rank × decision-boost × recency before applying the budget so exact-match chunks aren't trimmed.

### M10 — Citation key-term overlap validation spec not implemented

- **File:** `apps/api/src/services/query-engine.ts:213-221`
- **Fix:** Require at least 30 % key-term overlap between the cited claim and the chunk text before accepting the citation.

### M11 — `obfuscate.mjs` is security theatre

- **File:** `apps/api/scripts/obfuscate.mjs`
- **Fix:** Drop it. JS obfuscation isn't a security control; it slows down prod debugging.

### M12 — `docker-compose.demo.yml` pre-seeds with a dev-key that won't auth

- **Files:** `docker-compose.demo.yml`; `apps/api/src/scripts/seed-demo.ts`
- **Fix:** Couples to H19 — fix demo auth, then verify seed key works.

### M13 — Drift detector uses first-seen Qdrant score per event_id instead of max

- **File:** `apps/api/src/workers/drift-detector.ts:74-96`
- **Fix:** Track `max(score)` across chunks per event_id.

### M14 — `SESSION_SECRET` has no minimum-length validation

- **File:** `apps/api/src/lib/config.ts`
- **Fix:** Reject `<32` chars at startup. Document recommended generation command.

---

## Eval gaps

| ID | What's not tested | Why it matters |
|----|-------------------|----------------|
| E1 | Prompt-caching efficacy: no test asserts `cache_read_input_tokens > 0` after warm-up. | We have no way to know caching is working in CI; silent invalidation goes unnoticed. |
| E2 | Python SDK end-to-end: no eval invokes LangGraph or ADK wrappers. | C1 went uncaught. |
| E3 | Webhook idempotency under concurrent delivery: no eval sends the same `delivery_id` twice in parallel. | C7 will not be caught by a sequential test. |
| E4 | Stream-worker crash recovery: no eval kills a worker mid-batch and verifies the message is processed exactly once. | C2 directly. |
| E5 | Decision-node uniqueness on replay: no eval runs `reset-pipeline` twice and verifies `decision_count` is unchanged. | C5 directly. |
| E6 | Agent-log ticket/person extraction: no eval verifies that `PROJ-412` in rationale produces a Ticket node. | H1 directly. |
| E7 | Transcript per-segment timestamp preservation: no eval verifies monotonically increasing `valid_from` across chunks of one meeting. | H2 directly. |
| E8 | MCP end-to-end core promise: no eval seeds via MCP tool A then recalls via MCP tool B in a fresh client with no shared context. | The product's core promise. |
| E9 | Drift detector ordering vs brain-writer: no eval seeds two contradicting events and verifies the alert is created regardless of consumer order. | H4 directly. |
| E10 | Web XSS: `href={citation.source_url}` not filtered for `javascript:` schemes. | Stored XSS via crafted URL. |
| E11 | Release pipeline gate: no eval runs before image push. | H20. |

