# Purpl Brain — Honest Project Review

**Date:** 2026-05-17
**Reviewer:** Senior eng review, no political constraints
**Scope:** Product premise, architecture, implementation, evals

---

## 1. Verdict

**Continue with significant pivots.** The underlying problem (context reconstruction for human-agent teams) is real, and the implementation is further along than most solo projects at this stage — there is a working pipeline, real evals with pass criteria, and a coherent architecture. But the project as currently scoped is on a collision course with three incumbents (Glean, Notion AI, GitHub's own context features) without a defensible wedge, and the most important technical claim in the docs — sub-5-second p95 query latency — is contradicted by your own `eval/latency-eval.json` which reports **p95 = 73,980 ms** on Ollama. The single most important reason to keep going is the "AI agent as first-class write-back actor" angle (`POST /brain/agent-log`), which is genuinely under-served by every competitor named in `vision.md`. Pivot the positioning around that, narrow the ICP brutally, and stop trying to be Glean.

---

## 2. Product Premise Evaluation

### Is the problem real and painful enough?

Yes, but you are pricing it correctly only for one of your four personas. "Context reconstruction" is painful for the Floating Specialist (Priya) and the AI Agent. It is *annoying* for the Context Switcher (Alex) and the Tech Lead (Jordan), neither of whom will champion an internal tool purchase over an existing one. The 45–90 minute reconstruction figure in `personas.md` is plausible but unsourced — there is no evidence anyone has measured this on real teams.

The strongest signal in the docs is in `vision.md`:

> "The world is shifting toward small teams or solo developers managing multiple AI-assisted codebases in parallel."

That's the only persona where the pain is acute, the budget is real, and no incumbent dominates. Everything else is a stretch.

### Is the "AI agents as first-class actors" bet sound?

This is the most defensible part of the entire concept. None of Glean, Notion AI, Cursor, Copilot, Tettra, or Guru treats agent decision trails as ingested signals. ADR-004 captures the right insight: the schema (`agent-log`) routes through the same extraction pipeline as Slack/Jira, so agent decisions are queryable alongside human ones. The implementation in `brain.ts:185-254` actually delivers this — the agent log gets flattened into `raw_content`, enters Redis Streams, hits the normalizer and extractor, lands in Neo4j and Qdrant. That is real.

The risk is that this becomes a feature of agent runtimes themselves (Cursor memory, Claude Projects, Devin's memory layer) before it becomes a product. You have an 18-month window at best. The MCP server in ADR-002 is the right hedge — if the brain is consumable via MCP, it survives whichever agent runtime wins.

**Recommendation:** Lead with agent write-back, not "shared working memory." The latter is generic; the former is unique.

### Is the ICP well-defined?

No. The PRD lists four personas without ranking. The vision doc hints at "solopreneur with 3 projects" (referenced in roadmap M5) but the PRD targets "small teams running multiple products in parallel." These are different buyers with different budgets and different pain shapes. The closer-to-real ICP, given what is actually built, is:

> **Solo or 2-3 person teams running multiple AI-assisted codebases, who are already paying $20-100/mo for Cursor/Claude.**

They will pay $20/mo for agent memory that survives session boundaries. They will not pay enterprise Glean prices. Everyone else is aspirational until you have ten of them.

### Most dangerous assumption

That extraction quality (precision/recall targets of 0.75/0.65 in `entity-extraction.md`) is sufficient. It is not. A query that returns a confidently wrong decision destroys trust faster than a query that returns nothing. The `eval-extraction.ts` thresholds are too lenient — see Eval section.

Second-most-dangerous: that users will trust drift alerts (`drift-detector.ts`) without a feedback loop in production. The anomaly engine spec calls for user feedback and false-positive auto-tuning; the implementation has none of that. Two noisy alerts will train every user to ignore them forever.

### Competitive landscape

| Competitor | What they do | Where Purpl Brain has a gap |
|---|---|---|
| Glean | Enterprise search across SaaS tools | Glean is closed to agents, $30+/seat/mo, sales-led. Purpl Brain cannot win enterprise but can win SMB self-serve. |
| Notion AI / Q&A | Search a curated knowledge base | Human-curated only; no events, no agent trails. Purpl Brain is event-driven. |
| GitHub Copilot Workspace / Spaces | Repo-scoped agent memory | Same-repo only, no cross-repo, no Slack/Jira. Purpl Brain has multi-source ambition. |
| Mem.ai | Personal knowledge graph | Single-user, manual capture. Purpl Brain is team and event-driven. |
| Cursor Rules / Project Memory | In-IDE persistent context | Cursor-only, no Slack, no other agents. |
| Tettra / Guru | Wiki with AI | Manual curation. Same gap as Notion. |
| Linear/Jira AI | Ticket summaries | Single-source. No cross-tool synthesis. |

**Real differentiation, ranked:**

1. Agent write-back loop (`/brain/agent-log`) — unique
2. Cross-source synthesis with citations (Slack + GitHub + Jira + meetings) — Glean does this for enterprise; nobody does it for solo/small-team
3. Drift detection across surfaces — genuinely novel at this price point

**Things that are NOT differentiation, despite being claimed:**

- "Natural language query with citations" — every RAG product does this
- "Knowledge graph" — Glean has one, Notion AI implicitly has one
- "Temporal versioning" — claimed in architecture.md but only minimally implemented (`valid_from`/`valid_to` exist on Decision nodes, but `temporal-engine.ts` is 161 lines and likely shallow)

---

## 3. Architecture Evaluation

### Does Qdrant + Neo4j justify its operational complexity for the current scale?

**No, not for Phase 1-3 scale, but yes if Phase 3 deliverables (drift detection, multi-source linking) actually need graph traversal.**

Look at what `query-engine.ts` actually does:

- Line 42-52: vector search filtered by `project_id`
- Line 54-74: graph expansion that does exactly one query — `MATCH (e:Event)-[:AUTHORED_BY]->(p:Person), OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(e), OPTIONAL MATCH (e)-[:REFERENCES]->(t:Ticket)`

That is a 1-hop join with three OPTIONAL MATCHes. It is not a graph traversal — it's an enrichment lookup that could be done with metadata stored on Qdrant payloads at write time. Today, the only thing Neo4j is doing that Qdrant cannot is:

- Person identity resolution (`resolveOrCreateActorPerson`) — could be Postgres
- Decision nodes with valid_from/valid_to — could be Postgres
- DriftAlert -[:CHALLENGES]-> Decision — could be Postgres

You are paying the operational cost of Neo4j without using its graph traversal capability. The architecture docs talk about `impact_analysis` BFS with depth 3, `affects` and `implements` edges — none of that is in the implementation. `query-engine.ts` does a single OPTIONAL MATCH and stops.

**Verdict:** Either build the BFS impact analysis described in `anomaly-engine.md` (which is a real graph problem), or replace Neo4j with Postgres + Qdrant. Pick one. Carrying Neo4j for "future graph queries" is unjustified operational debt.

### Are the ADR decisions sound given what was actually built?

- **ADR-001 (hybrid store):** The decision is sound but premature. Qdrant alone would have been enough for Phase 1-2. The Neo4j migration from Kuzu happened (per `system-design-decisions.md`), so you've already absorbed the cost.
- **ADR-002 (MCP server):** Right call. Deferred to Phase 4, but `apps/mcp` exists, so partially in flight.
- **ADR-003 (event-driven):** Correct. Redis Streams is the right primitive for this scale.
- **ADR-004 (agent decision trails):** The strongest decision in the project. Implementation matches the spec.

### Most significant production risks

1. **The pipeline is not crash-safe.** `normalizer.ts:131-138` ack-on-failure semantics are correct (leaves message in stream), but `extractor.ts:181-184` and `drift-detector.ts:262-266` both ACK on JSON parse failure. There is no dead-letter queue. A poison message will be silently dropped.
2. **No retry budget on LLM calls.** `chat()` in `lib/llm.ts` makes a single call to Anthropic/Ollama. A transient 429 or 500 throws. The extractor (line 95-113) has one fallback path but it calls the same LLM with the same prompt — that won't help on rate-limit failures.
3. **Embedding model lock-in to Ollama.** `embed.ts` is 24 lines and hard-codes Ollama at `localhost:11434`. There is no fallback to a cloud embedding model. If the worker box loses Ollama, ingestion stops cold.
4. **The "atomic write to both stores" claim in `system-design-decisions.md` is false.** `brain-writer.ts:189-192` calls `writeToNeo4j` then `writeToQdrant` sequentially with no transaction. If Qdrant fails after Neo4j commits, the brain has a Decision node with no embeddable chunk. There is no compensating action.
5. **Identity resolution is racy.** `resolveOrCreateActorPerson` in `neo4j.ts:323-369` uses MERGE, which is not atomic across concurrent transactions in Neo4j community edition without a uniqueness constraint. The `github_login` MERGE needs a `CREATE CONSTRAINT FOR (p:Person) REQUIRE p.github_login IS UNIQUE` — I don't see migration code that creates these constraints.

### Over-engineering vs under-engineering

**Over-engineered for current scale:**
- Two graph databases (Kuzu→Neo4j) tried before Phase 2 was done
- Per-event Anthropic prompt caching infrastructure for a system that runs ~hundreds of events/day at most
- MCP server skeleton in `apps/mcp` before any real customer exists
- CDK deployment infra (`apps/cdk`) when there are zero users

**Under-engineered:**
- No backpressure / queue depth metrics anywhere — workers `console.log` and that's it
- No tracing / spans across the worker chain (normalizer → extractor → brain-writer → drift-detector). When a query returns a stale answer, you cannot trace it back to which worker dropped or delayed the event.
- The `query-engine.ts` "graph expansion" is a placeholder. It does not implement the spec in `query-layer.md` (intent parsing via Haiku, parallel embed + intent, recency bonus, 6K-token budget trim with priority order). It does a vector search and appends graph metadata. That is plain RAG with a side dish.
- No streaming responses from the LLM to the client. Given 30-60s latencies, this is the single biggest UX miss.

---

## 4. Implementation Quality

### Genuinely well-implemented

- **Idempotency on webhooks.** `webhooks.ts:135` checks `PROCESSED_SET` before enqueueing. The HMAC verification (`verifySignature`) uses `timingSafeEqual` — correct.
- **The agent-log endpoint** (`brain.ts:185-254`) cleanly funnels structured logs through the same canonical pipeline as human signals. This matches ADR-004 exactly. Good.
- **Two-pass extraction.** `normalizer.ts:22-70` and `extractor.ts:74-114` actually implement the rule-based filter → LLM call pattern from `entity-extraction.md`. The marker regexes have been iterated — `slackDecisionCandidate` separates Slack patterns from GitHub. This is the kind of detail that suggests the developer actually ran the evals and tuned.
- **Transcript parser.** `transcript-parser.ts` handles VTT, SRT, and plain text. The speaker extraction regex (`/^([A-Z][^:\n]{1,40}):\s+(.+)$/`) is a sensible compromise.
- **Citation validation.** `query-engine.ts:95-98` extracts `[N]` references and validates them against in-scope chunks. Lightweight but the right shape.
- **Eval scripts have actual pass thresholds** (precision ≥ 0.75, recall ≥ 0.65, p95 < 5s) and exit non-zero on failure. Most solo projects skip this.

### Brittle, incomplete, or technically risky

- **`raw_content` field overloaded.** `brain-writer.ts:84` writes `e.raw_content = $url` (the source URL, not the actual content). This is a bug. Search a Decision via `MATCH (e:Event) RETURN e.raw_content` and you get a URL. Compare to `lib/document-chunker.ts` which generates real chunks. Inconsistent.
- **Source detection by event_id prefix everywhere.** `brain-writer.ts:50-55`, `query-engine.ts:123-133`, `drift-detector.ts:208`. The same `result.event_id.startsWith("slack_") ? ... : ...` ladder is duplicated four times. Should be a field on the canonical event. (It already is — `event.source`. The code ignores it and reverse-engineers from the event_id.) That is technical debt waiting to compound when you add a new source.
- **`drift-detector.ts:167-172`** has a fragile "is this GitHub?" check that hard-codes "seed_" and "gh_" prefixes alongside the same prefix-ladder. The comment says "Remove this guard when GitHub issues/commits are added in M5" but the guard is still there.
- **Chunk dedup absent for re-ingest.** `webhooks.ts:175` does `srem(PROCESSED_SET, docEvent.source_id)` before re-enqueueing a doc, but old chunks in Qdrant from the previous version of the file are never deleted. Re-pushing a doc 5 times means 5x duplicate chunks in vector search. This will degrade query quality silently.
- **`flattenToText` in transcript-parser.ts:119-123** joins with `\n` not `\n\n`, so the chunker (`document-chunker.ts:26` which prefers `\n\n` paragraph breaks) falls through to sentence breaks every time on transcript content. Chunks will straddle speakers.
- **`vttTimestampToIso`** at line 18-32 of transcript-parser.ts uses `setHours(d.getHours() + h, d.getMinutes() + m, ...)`. That additive mutation will overflow weirdly (adding 1 hour 70 minutes 30 seconds to a base date doesn't normalize what you'd expect). Should compute total seconds and add as Date arithmetic.
- **Project ID derivation** in `webhooks.ts:144`: `String(repo?.full_name ?? "unknown").replace("/", "_")` — only replaces the first `/`. Repos like `org/sub/repo` (does not exist on GitHub but could appear in self-hosted) would break. Cosmetic but indicative.
- **`ingest.ts:44`** uses `Date.now()` in `sourceId`, defeating idempotency: posting the same doc twice yields two different source_ids since the timestamp differs. The 409 check on `PROCESSED_SET` will never fire for the same payload twice — it relies on title equality, but the timestamp is suffixed. Actually re-reading: `sourceId = doc_${project_id}_${title}_${Date.now()}` — so timestamps differ, meaning every ingest creates a new source_id. The 409 check at line 46 will only catch if the *exact same* sourceId is reused, which is impossible. **This dedup is broken.**

### Security gaps (specific)

1. **`POST /brain/agent-log` has no auth.** `brain.ts:161` literally says `// TODO: add API key auth before production deployment (open for beta)`. Right now anyone with the URL can inject arbitrary "decisions" into your brain. This is the single most important security gap.
2. **`POST /brain/ingest/document`, `/brain/ingest/transcript`, `/brain/ingest/crawl-docs`, `/brain/query`** — all unauthenticated. Same problem.
3. **`SESSION_SECRET` defaults to `"purpl-brain-dev-secret-change-in-production"`** (`apps/api/src/index.ts:22`). If deployed without env var override, sessions are forgeable. A startup-time assertion (`if (NODE_ENV === "production" && !SESSION_SECRET) throw`) would prevent this.
4. **Neo4j password defaults to `"password"`** (`neo4j.ts:6`). Same problem — silent dev default that ships to prod.
5. **API key for Person is `uuidv4()`** (`auth.ts:119`) stored as a plain property on the Person node. Not hashed. If Neo4j is breached, every API key is exposed. Should be HMAC'd or hashed (Argon2/bcrypt) before storage; the bearer key is only known at creation.
6. **No CORS allowlist for non-UI origins.** `index.ts:16-19` sets origin to `UI_BASE_URL` with credentials. If `UI_BASE_URL` is `*` or unset in some environment, this breaks badly.
7. **`crawlRepoDocs`** accepts a `github_token` in the request body (`ingest.ts:101`). Tokens in request bodies leak in logs. Should be header-only.
8. **No rate limiting anywhere.** A misbehaving agent can saturate `/brain/agent-log` and run up the Anthropic bill via the LLM extraction step.
9. **Webhook signature verification is opt-in for Jira and Fireflies.** Lines 197-203 of `webhooks.ts`: `if (secret) { ... }` — if `JIRA_WEBHOOK_SECRET` is unset, all Jira webhooks are accepted. Should be fail-closed: refuse webhooks if no secret is configured.
10. **GitHub OAuth callback** doesn't validate the `state` parameter explicitly. `@fastify/oauth2` should handle this but the code path doesn't assert it.

### Missing error handling / resilience

- No timeouts on `fetch` calls in `github-doc-crawler.ts`, `auth.ts`, `webhooks.ts:resolveJiraEmail`. GitHub hanging means the worker hangs.
- No circuit breaker around Ollama. If it's slow, every ingestion event waits.
- Workers (`normalizer.ts`, `extractor.ts`, `brain-writer.ts`, `drift-detector.ts`) all have an infinite `while(true)` with `await redis.xreadgroup`. No graceful shutdown handler. SIGTERM kills mid-write.
- Qdrant write failures are uncaught — `qdrant.upsert(COLLECTION, { points })` in `brain-writer.ts:183` will throw and the message will be reprocessed forever (or ACKed on next pass; behavior depends on whether the throw happens before the ACK call — it happens before, so it will retry forever). No retry budget.

### Technical debt that will compound

1. **The source-from-event_id prefix pattern.** Already duplicated 4 places. Adding Linear or Notion will mean editing all 4.
2. **`Decision` type in `packages/types/src/index.ts` does not match the spec in `entity-extraction.md`.** The doc lists `decision_maker`, `scope`, `reversible` fields that don't exist in the type. The spec says the schema is the contract; the contract has drifted.
3. **`QueryMode = "project" | "temporal"` in types** but the spec calls for `project | temporal | expertise | agent-resume | impact`. Three modes are vaporware. Either remove them from docs or implement them.
4. **`temporal-engine.ts` is 161 lines.** I didn't read it deeply but at that size it cannot be implementing the rich diff pipeline `query-layer.md` describes (graph query for nodes WHERE valid_from IN [T-N, now], group by node type, fetch prior version via supersedes edge, etc.). It's almost certainly a stub.
5. **No migrations framework.** `migrate-m5-person-schema.ts` and `migrate-phase2-schema.ts` exist as ad-hoc scripts. There is no migration table tracking what has been applied. Re-running them is unsafe.

---

## 5. Eval Coverage Assessment

### What is well-covered

- **Extraction precision/recall.** `eval-extraction.ts` is a real eval — it reads from Redis streams, joins to a labeled scaffold, computes TP/FP/FN, and surfaces failure modes (rule-based-miss vs llm-miss vs hallucination). The `newMarkersMatch` simulation pass is impressive — it shows projected recall after marker additions before re-running the pipeline. This is mature.
- **Citation grounding.** `eval-citations.ts` validates URL format, non-empty quoted text, and word-overlap support score. The check that `citation_warning === false` catches the most common LLM failure mode.
- **End-to-end smoke tests.** `eval-docs.ts` and `eval-transcript.ts` ingest → wait → query → assert. These would fail loudly if any stage of the pipeline broke.

### What is NOT covered (important behaviors with no eval)

1. **Drift detector precision/recall.** `eval-drift.ts` exists but I didn't open it. Even if it tests "did we detect this contradiction," there is no false-positive measurement on truly innocent updates. Drift FP rate is the single biggest product risk per `anomaly-engine.md`.
2. **Agent write-back round-trip.** No eval ingests an agent log, queries for "what did the agent decide last session," and validates the answer matches. This is the Phase 2 exit criterion and the strongest differentiation — and it's not protected by a regression test.
3. **Cross-source synthesis.** The Phase 3 exit criterion ("a single query returns synthesized answer grounded in both a GitHub PR comment and a Slack thread") has no dedicated eval. `eval-query.ts` has Slack-sourced and Jira-sourced queries but does not assert that a single answer is grounded in chunks from multiple sources.
4. **Latency on Anthropic provider.** `eval/latency-eval.json` reports `"provider": "ollama"` with p95 = 74s. There is no equivalent run on Anthropic. The 5s p95 target in PRD and query-layer.md is unmeasured.
5. **Identity resolution.** No eval asserts that two different source mentions of the same person resolve to the same `person_id`. The whole @mention story in `system-design-decisions.md` depends on this and there's no regression coverage.
6. **Idempotency.** Re-sending the same GitHub webhook 5 times should result in 1 ingested event. No test asserts this.
7. **Concurrent ingestion.** No eval drives parallel webhooks to detect race conditions in `resolveOrCreateActorPerson` MERGE statements.
8. **Cache invalidation on doc re-push.** `webhooks.ts:175` does `srem` to allow re-ingest, but no eval asserts the new content replaces old content in query results (vs. coexisting).
9. **Permission isolation.** No eval verifies that a query for `project_id=A` cannot return chunks from `project_id=B`. This is a security regression waiting to happen.

### Are pass thresholds meaningful?

- **Extraction: precision ≥ 0.75, recall ≥ 0.65.** Too lenient. At 0.75 precision, 1 in 4 surfaced decisions is wrong. For a tool whose pitch is "trusted, cited context," 1-in-4 wrong is brand-damaging. Target should be precision ≥ 0.90, recall ≥ 0.70 before you put this in front of paying users.
- **Query accuracy ≥ 80% (correct + partial + no-info).** The "partial" grade counts as a pass. If 40% of answers are partial, the eval still passes. Re-grade: correct alone ≥ 70%, partial ≤ 20%.
- **Citation: 0 fabricated.** Good threshold. Hard. Honest.
- **Latency p95 < 5s.** Currently failing by 15x on Ollama, untested on Anthropic. Either change the target or measure on Anthropic and report honestly.
- **Demo eval: every scenario passes.** Brittle — adds one slow LLM and breaks. Should split into "correctness" (must pass) and "performance" (informational).

### What a rigorous eval suite looks like

Compared to what exists:

| Behavior | Current | Should be |
|---|---|---|
| Extraction precision/recall | Labeled scaffold of ~N PRs from one repo | Labeled scaffold across 3 repos + 1 Slack workspace + 1 Jira project, with a held-out test set |
| Citation accuracy | Word overlap ≥ 0.15 with claim | Word overlap + LLM judge ("does this citation support this claim?") |
| Drift FP rate | Detection-only | Add 50 known-non-contradictions and assert detector returns ≤ 5 |
| Agent round-trip | None | Ingest agent log → query → assert reference to specific decision |
| Cross-source synthesis | None | Specific queries requiring chunks from 2+ sources; assert citations span sources |
| Latency | Ollama only | Both providers, p50/p95/p99, cached vs cold |
| Permission isolation | None | Inject project A & B; query A; assert no B citations |
| Concurrent ingestion | None | Drive 100 parallel webhooks; assert no duplicate Person nodes |
| Migration safety | None | Run migration → reseed → assert old data still queryable |

---

## 6. Prioritized Improvement Backlog

### Critical (would block production / first paying user)

1. **Add auth to all `/brain/*` write endpoints.** `agent-log`, `ingest/document`, `ingest/transcript`, `ingest/crawl-docs`, `query`. API key middleware that looks up the Person by `api_key` (already in Neo4j). 4-6 hours.
2. **Fail-closed webhook signatures.** Refuse Jira and Fireflies webhooks if no secret is configured. 1 hour.
3. **Assert env-var presence at startup in production.** `SESSION_SECRET`, `NEO4J_PASSWORD`, `ANTHROPIC_API_KEY` must throw if NODE_ENV=production and missing. 1 hour.
4. **Hash API keys at rest.** Argon2 the key before storing on Person; return bearer once on creation. 3 hours.
5. **Fix document idempotency.** Remove `Date.now()` from `sourceId` in `ingest.ts:44`. Use a content hash. 2 hours.
6. **Add Neo4j uniqueness constraints** for `Person.github_login`, `Person.email`, `Decision.decision_id`, `Event.event_id`. Wrap MERGE in retry-on-constraint-violation. 4 hours.
7. **Build a dead-letter queue.** A poison message that fails JSON parse should land in `events:dead` with the error, not be silently ACKed. 4 hours.
8. **Latency truth-telling.** Run `eval-latency.ts` on Anthropic Sonnet. Publish the real number. If it's still >10s, stream responses to the UI. 1 day for streaming.

**Critical total: ~2.5 days of work.**

### Important (should do before first user beyond yourself)

9. **Stop reverse-engineering source from event_id prefix.** Use `event.source` field. Refactor the four prefix-ladders into one helper. 2 hours.
10. **Delete old Qdrant chunks on doc re-ingest.** Currently re-pushing a doc duplicates chunks. Match on `source_id` payload field and delete-then-upsert. 3 hours.
11. **Write an eval for agent-log round-trip.** Ingest a synthetic agent log; query; assert decision is cited. This is the differentiation — protect it. 3 hours.
12. **Write an eval for project_id isolation.** Two projects, same content, query one — must not return chunks from the other. 2 hours.
13. **Raise extraction precision target to 0.90.** Improve the system prompt or add an LLM judge for borderline decisions. 1-2 days of iteration.
14. **Implement intent parsing (Haiku) per query-layer.md.** Without it, "what changed in the last 5 days" is just RAG. 1 day.
15. **Implement actual temporal diff in `temporal-engine.ts`** per the spec. The Cypher is in the doc; write it. 1 day.
16. **Add graceful shutdown handlers** to all workers (`SIGTERM` drain). 2 hours.
17. **Stream LLM responses** in `query-engine.ts` — even at 30s latency, a streaming response feels live. 4 hours.
18. **Drift detector false-positive eval** with 50 labeled non-contradictions. 1 day to build, ongoing maintenance.

### Nice-to-have

19. **Replace Neo4j with Postgres** if you don't build BFS impact analysis in the next 2 weeks. 2-3 days but reduces ops cost permanently.
20. **OpenTelemetry tracing** across the worker chain. 1 day.
21. **A real migrations framework** (kysely-migrations or pure-Cypher with a `Migration` node). 1 day.
22. **Move source-specific event fields out of the canonical event** into a `payload` subobject (slack_*, jira_*, document_*, meeting_*). The current flat type is fine at 5 sources, breaks at 10. 4 hours.
23. **Implement MCP server** for real. The skeleton exists; the differentiation is real. 2-3 days.
24. **Self-serve onboarding** (Phase 4 M5) is essential for the solo/SMB ICP. Without it, no one will try the product. 1 week.

---

## 7. Strategic Recommendation

### Continue, but with these specific pivots

**The single highest-leverage thing to build next: a polished, hosted demo of the agent write-back loop.**

Not a chat UI. Not enterprise features. Not Slack ingestion. Build this:

1. A developer running Claude Code or Cursor finishes a session.
2. The agent emits a structured decision log to Purpl Brain via `POST /brain/agent-log` (already implemented).
3. The same developer, days later in a new session, queries the brain via MCP (`brain_query`) and gets back a cited summary of prior decisions.
4. Bonus: the new session's contradictions of prior decisions are detected and surfaced (drift detector — already implemented).

This is a 30-second demo that no incumbent can show. Glean can't. Notion can't. Cursor can't. It is the proof of the "AI agents are first-class actors" thesis and it is the only place Purpl Brain has clean blue water.

**Everything else is supporting infrastructure for that demo.** Slack and Jira ingestion are valuable but they put you in Glean's market and you will lose that fight. GitHub ingestion is sufficient for the human side of context (PRs, issues, ADRs — already covered).

### Specific positioning pivot

Stop calling this "shared working memory for human-agent teams." It pattern-matches to Notion/Glean.

Start calling it: **"Persistent memory for AI coding agents. Agents emit their decisions; you and your next agent inherit them."**

Same product, completely different mental category. The buyer is a developer paying $20-100/mo for Cursor and Claude. The price point is $10-30/mo. The wedge is agent continuity. Slack/Jira/team features come later as expansion revenue.

### What to scrap (or aggressively defer)

- Multi-product graph (Phase 4 M4) — interesting for enterprise, not for the ICP that will actually pay
- Meeting transcript attachment vision processing (Phase 4 M3) — high cost, weak signal
- Slack DM-based anomaly digests — UI-only is fine for v1
- Anomaly digest batching with severity scoring matrix — over-engineered relative to user need; ship a simple "here are alerts" list first
- The `floating specialist` persona (Priya) — beautiful in the docs, not your buyer in 2026

### Evidence from the codebase supporting this pivot

- `apps/mcp` exists as a skeleton — you already started here
- The `agent-log` endpoint is the most polished route in `brain.ts`
- The drift detector is configured exactly right to catch agent-vs-agent and agent-vs-human contradictions (`drift-detector.ts:111-124`)
- The two-pass extraction works well on the structured agent log format (per ADR-004, no LLM needed at all for agent logs — pure schema parsing — yet `brain.ts:208-215` flattens them through the LLM path, which is wasteful but functional)

### If you instead decide to scrap

The salvageable IP would be:
- The ingestion pipeline architecture (Redis Streams → 4 workers → hybrid store) — clean, generic, reusable
- The two-pass extraction pattern with the regex marker lists in `normalizer.ts:22-70` — these are real, hard-won signal
- The eval harness (`eval-extraction.ts` is genuinely good)
- The agent-log schema and round-trip path

If you did scrap, the right successor product to build with the same problem area would be: **a Cursor/Claude Code plugin that captures agent decisions automatically (no manual emission), stores them locally in SQLite, and exposes them via MCP.** No team features, no Slack, no graph database. That product could ship in 3-4 weeks and would be sticky.

---

## Closing

The work is real. The architecture is more ambitious than the use case requires today. The ICP is too broad and the positioning is generic. The agent write-back loop is the actual differentiation; lean into it, narrow the scope, ship the security/auth gaps, and re-target the latency claim before showing this to anyone who matters.

The most important sentence in the entire docs corpus is in `vision.md`:

> "No existing tool treats AI agents as first-class actors that both read and write context."

That is the product. Build that product. The rest is decoration.
