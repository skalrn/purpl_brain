# Remediation Plan — Technical Review 2026-05-20

Companion to `review-findings.md`. Every finding referenced here is described there in full; this file is the execution plan.

**Sequencing principles**

1. Critical before High before Medium.
2. Dependency-correct: shared type fixes land before the workers that read them; idempotency primitives land before the workers that depend on them.
3. Each milestone is independently shippable — the system is never left in a broken intermediate state.
4. Effort is wall-clock estimated for one Claude Sonnet pair-coding session; total plan is roughly 16-18 working days.

**Conventions**

- "Done criterion" is the single check that proves the milestone is complete. If the check passes, the milestone ships.
- "Blocked by" lists prior milestone IDs that must merge first.
- All file paths are absolute from the repo root.

---

## Milestone index

| ID | Title | Severity covered | Effort |
|----|-------|------------------|--------|
| R0 | Shared-types fix: add `source` and `event_type` to `ExtractionResult` | C10, H15 | 1.5h |
| R1 | Python SDK URL fix + e2e eval | C1, E2 | 2h |
| R2 | Anthropic SDK bump + remove `as unknown as` casts | C3 | 2h |
| R3 | Idempotency primitives: namespaced keys + atomic SET NX | C6, C7, E3 | 4h |
| R4 | Stream caps + xadd helper | C8 | 2h |
| R5 | StreamWorker DLQ + retry tracking | C2, H3, E4 | 6h |
| R6 | Decision idempotency: deterministic decision_id | C5, E5 | 3h |
| R7 | Brain-writer → drift-detector ordering via `events:brain_written` | H4, E9 | 4h |
| R8 | Prompt-caching: structured content blocks + retrieved-context breakpoint | C4, H16, E1 | 6h |
| R9 | Embedding-sentinel guard | C9 | 2h |
| R10 | Cross-project drift pass | C11 | 6h |
| R11 | Auth hardening: constant-time compares, fail-closed membership | H7, H8, H10, H17 | 4h |
| R12 | Webhook secret out of query string | H9 | 1h |
| R13 | Identity link scoped to caller projects | H11 | 3h |
| R14 | Qdrant payload indexes + Neo4j indexes | H12, H13 | 3h |
| R15 | Source classifier: explicit `unknown` default | H14 | 1h |
| R16 | Agent-log: extract ticket_refs and person_mentions | H1, E6 | 3h |
| R17 | Transcript per-segment timestamps | H2, E7 | 3h |
| R18 | CDK ALB HTTPS listener | H6 | 4h |
| R19 | Web client: delete client-side intent parsing | H5 | 3h |
| R20 | CORS consolidation | H18 | 1h |
| R21 | Demo mode flag (decouples from NODE_ENV) | H19, M12 | 2h |
| R22 | Release pipeline gate: typecheck + curated eval | H20, E11 | 4h |
| R23 | Worker health-check endpoints | H21 | 4h |
| R24 | Signals queue: async + Stage C confirmation | H22, H25 | 5h |
| R25 | Query engine: parallel embed+intent, citation correctness | H23, H24 | 4h |
| R26 | Web XSS hardening (citation URL filter) | E10 | 2h |
| R27 | MCP end-to-end eval | E8 | 4h |
| R28 | Medium-tier bundle 1: metrics + temporal-engine batching | M1, M2 | 8h |
| R29 | Medium-tier bundle 2: extractor strategies, query mode gating, citation polish | M3, M4, M5, M7, M9, M10, M13 | 10h |
| R30 | Medium-tier bundle 3: ops/cleanup | M6, M8, M11, M14 | 4h |

---

## R0 — Shared-types fix: add `source` and `event_type` to `ExtractionResult`

- **Findings:** C10, H15
- **Effort:** 1.5h
- **Blocked by:** none — foundation work
- **Goal:** Make the types carry the canonical `source` and `event_type` so downstream writers don't have to re-infer or hardcode them.

**Files to change**

- `packages/types/src/index.ts`
- `apps/api/src/workers/extractor.ts`
- `apps/api/src/workers/normalizer.ts`
- `apps/api/src/routes/brain.ts` (agent-log handler)
- `apps/api/src/workers/brain-writer.ts`

**Implementation notes**

In `packages/types/src/index.ts` extend the `ExtractionResult` interface:

```ts
export interface ExtractionResult {
  event_id: string;
  source: EventSource;        // NEW — was being re-inferred downstream
  event_type: EventType;      // NEW — was being hardcoded to "ingested"
  project_id: string;
  source_id?: string;
  source_url: string;
  raw_content: string;
  actor: Actor;
  operator?: Actor;
  timestamp: string;
  decisions: Decision[];
  ticket_refs: string[];
  person_mentions: string[];
  concept_tags: string[];
  decision_candidate: boolean;
}
```

In `extractor.ts` (around line 268), populate from the incoming `NormalizedEvent`:

```ts
const result: ExtractionResult = {
  event_id: event.event_id,
  source: event.source,          // NEW
  event_type: event.event_type,  // NEW
  project_id: event.project_id,
  // ...rest unchanged
};
```

In `brain.ts` agent-log handler (around line 289), set explicitly:

```ts
const extractionResult: ExtractionResult = {
  // ...
  source: "agent",
  event_type: "agent_session",
  // ...
};
```

In `brain-writer.ts:73-86`, replace the hardcoded values:

```ts
event_type: result.event_type,
source: result.source,
```

Remove the `inferSourceFromEventId(result.event_id)` call at line 47 (writer side only — `event-source.ts` itself stays for now; R15 will rename its fallback).

**Done criterion**

- `npm run typecheck` passes from a clean tree.
- New Cypher inspection script run from terminal: `MATCH (e:Event) RETURN DISTINCT e.event_type` returns the full set of event types, not just `"ingested"`.

---

## R1 — Python SDK URL fix + e2e eval

- **Findings:** C1, E2
- **Effort:** 2h
- **Blocked by:** none
- **Goal:** LangGraph and ADK agents successfully call `brain_query` and `brain_analyze_impact`.

**Files to change**

- `packages/python/purpl_brain/tools_langgraph.py`
- `packages/python/purpl_brain/tools_adk.py`
- `packages/python/tests/test_brain_tools_e2e.py` (NEW)
- `packages/python/Makefile` or `pyproject.toml` (test target)

**Implementation notes**

Two edits per file, both changing `/query` to `/brain/query`:

- `tools_langgraph.py:37` and `:102`
- `tools_adk.py:49` and `:129`

Add an e2e test in `packages/python/tests/test_brain_tools_e2e.py` that spins up the API (assumes `BRAIN_API_URL` env points at a live brain), invokes both wrappers, and asserts a 200 response shape:

```python
import os, pytest
from purpl_brain import BrainClient
from purpl_brain.tools_langgraph import make_brain_tools as lg_tools
from purpl_brain.tools_adk import make_brain_tools as adk_tools

PROJECT = os.environ.get("BRAIN_TEST_PROJECT", "skalrn_purpl_brain")

@pytest.mark.e2e
def test_langgraph_brain_query():
    client = BrainClient()
    tools = {t.name: t for t in lg_tools(client)}
    result = tools["brain_query"].invoke({"query": "what storage do we use?", "project_id": PROJECT})
    assert "Sources" in result or "No relevant" in result

@pytest.mark.e2e
def test_adk_brain_analyze_impact():
    client = BrainClient()
    tools = {f.__name__: f for f in adk_tools(client)}
    out = tools["brain_analyze_impact"]("switch from Neo4j to JanusGraph", PROJECT)
    assert "overall_risk" in out
```

**Done criterion**

- `pytest -m e2e packages/python/tests/test_brain_tools_e2e.py` returns 2 passed against a live local brain.

---

## R2 — Anthropic SDK bump

- **Findings:** C3
- **Effort:** 2h
- **Blocked by:** none (R8 builds on this)
- **Goal:** SDK supports current model IDs and native `cache_control` types so we can drop the `as unknown as` casts.

**Files to change**

- `apps/api/package.json`
- `apps/api/src/lib/llm.ts`

**Implementation notes**

Bump `@anthropic-ai/sdk` to the most recent minor that supports `cache_control` typing and the `claude-sonnet-4-6` / `claude-haiku-4-5-20251001` model IDs (>= 0.40). Run `npm install`.

In `llm.ts:64` and `:133`, drop the casts:

```ts
system: system
  ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
  : undefined,
```

If the SDK exports a stricter type that complains about `cache_control` on a plain string-system path, add the typed import: `import type { Messages } from "@anthropic-ai/sdk";` and annotate the array as `Messages.TextBlockParam[]`.

**Done criterion**

- `npm run typecheck` passes with no `as unknown as` in `llm.ts`.
- A one-off integration test calling `chat()` against Anthropic with the new SDK returns a 200 and the response shape is unchanged.

---

## R3 — Idempotency primitives: namespaced keys + atomic SET NX

- **Findings:** C6, C7, E3
- **Effort:** 4h
- **Blocked by:** none
- **Goal:** Replace the global `processed:event_ids` SET and the SISMEMBER+SADD pattern with per-event atomic keys.

**Files to change**

- `apps/api/src/lib/redis.ts`
- `apps/api/src/routes/webhooks.ts` (3 dedup sites)
- `apps/api/src/routes/ingest.ts`
- `apps/api/src/routes/brain.ts` (transcript + agent-log)
- `apps/api/src/workers/extractor.ts` (LINKED_PR_SET)
- `apps/api/tests/eval-idempotency-concurrent.ts` (NEW)

**Implementation notes**

In `redis.ts`, replace `PROCESSED_SET` with helpers:

```ts
const DEDUP_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

/**
 * Atomic claim: returns true if we are first to process this id,
 * false if another caller already claimed it.
 * Replaces the TOCTOU SISMEMBER+SADD pattern.
 */
export async function claimIdempotencyKey(
  source: string,
  projectId: string,
  externalId: string
): Promise<boolean> {
  const key = `processed:${source}:${projectId}:${externalId}`;
  const result = await redis.set(key, "1", "EX", DEDUP_TTL_SEC, "NX");
  return result === "OK";
}

export async function releaseIdempotencyKey(
  source: string,
  projectId: string,
  externalId: string
): Promise<void> {
  await redis.del(`processed:${source}:${projectId}:${externalId}`);
}
```

Every call site replaces this:

```ts
const already = await redis.sismember(PROCESSED_SET, deliveryId);
if (already) return reply.code(200).send({ status: "duplicate" });
// ... do work ...
await redis.sadd(PROCESSED_SET, deliveryId);
```

with this:

```ts
const claimed = await claimIdempotencyKey("github", projectId, deliveryId);
if (!claimed) return reply.code(200).send({ status: "duplicate" });
// ... do work ...
// No release call — the SET NX EX is the durable record
```

For the GitHub doc re-crawl path (`webhooks.ts:175`) that currently calls `srem` to invalidate, call `releaseIdempotencyKey` instead.

For `LINKED_PR_SET` in `extractor.ts`, the same pattern applies — convert each `${owner}/${repo}/pull/${prNum}` to a namespaced key.

Add `apps/api/src/scripts/eval-idempotency-concurrent.ts`: fires 10 parallel POSTs with the same `X-GitHub-Delivery` and asserts exactly one xadd lands in `events:raw`.

**Done criterion**

- The concurrent eval passes: 10 parallel deliveries → exactly 1 stream entry.
- `KEYS processed:*` returns per-event keys; `EXISTS processed:event_ids` returns 0.

---

## R4 — Stream caps + xadd helper

- **Findings:** C8
- **Effort:** 2h
- **Blocked by:** none
- **Goal:** Bound the memory footprint of every Redis Stream.

**Files to change**

- `apps/api/src/lib/redis.ts`
- Every site that calls `redis.xadd(STREAMS....)` (12 sites): webhooks, ingest, brain routes, extractor, brain-writer, drift-detector, slack-listener.

**Implementation notes**

Add a wrapper in `redis.ts`:

```ts
const STREAM_MAXLEN = parseInt(process.env.STREAM_MAXLEN ?? "100000");

/**
 * xadd wrapper that enforces the configured MAXLEN cap.
 * Use this instead of redis.xadd directly so the cap can't be forgotten.
 */
export async function xaddCapped(
  client: Redis,
  stream: string,
  fieldName: string,
  value: string,
  extraFields: Record<string, string> = {}
): Promise<string | null> {
  const extra: string[] = [];
  for (const [k, v] of Object.entries(extraFields)) extra.push(k, v);
  return client.xadd(
    stream,
    "MAXLEN", "~", STREAM_MAXLEN.toString(),
    "*",
    fieldName, value,
    ...extra
  );
}
```

Replace every `redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event))` with `xaddCapped(redis, STREAMS.RAW, "event", JSON.stringify(event))`. Same for streams `NORMALIZED`, `EXTRACTED`, `DRIFT`.

Add an ESLint custom rule (or a grep step in CI) that rejects direct `.xadd(` calls outside `redis.ts`.

**Done criterion**

- `grep -r "\.xadd(" apps/api/src` returns matches only in `redis.ts`.
- `XLEN events:raw` after 200k synthetic events stays under 110k.

---

## R5 — StreamWorker DLQ + retry tracking

- **Findings:** C2, H3, E4
- **Effort:** 6h
- **Blocked by:** R4 (uses `xaddCapped`)
- **Goal:** No message is ever lost silently. Transient failures retry; persistent failures land in `events:dead` with the failure reason.

**Files to change**

- `apps/api/src/lib/stream-worker.ts`
- `apps/api/src/lib/redis.ts` (add `STREAMS.DEAD`)
- `apps/api/src/scripts/eval-worker-crash-recovery.ts` (NEW)

**Implementation notes**

In `redis.ts` add `DEAD: "events:dead"` to `STREAMS`.

In `stream-worker.ts` add a max-attempts constant and per-message retry tracking:

```ts
const MAX_ATTEMPTS = parseInt(process.env.WORKER_MAX_ATTEMPTS ?? "5");
const ATTEMPT_TTL_SEC = 60 * 60 * 24 * 7;

protected async incrementAttempt(messageId: string): Promise<number> {
  const key = `retry:attempts:${this.stream}:${messageId}`;
  const count = await this.redis.incr(key);
  if (count === 1) await this.redis.expire(key, ATTEMPT_TTL_SEC);
  return count;
}

protected async clearAttempt(messageId: string): Promise<void> {
  await this.redis.del(`retry:attempts:${this.stream}:${messageId}`);
}

protected async deadLetter(messageId: string, value: string, reason: string): Promise<void> {
  await xaddCapped(this.redis, STREAMS.DEAD, "payload", value, {
    origin_stream: this.stream,
    origin_id: messageId,
    reason,
    failed_at: new Date().toISOString(),
  });
}
```

Replace the live-loop catch block (`stream-worker.ts:123-127`):

```ts
try {
  await this.processMessage(id, value);
  await this.clearAttempt(id);
} catch (e) {
  const attempts = await this.incrementAttempt(id);
  const reason = e instanceof Error ? e.message : String(e);
  if (attempts >= MAX_ATTEMPTS) {
    console.error(`[${this.name}] ${id} exhausted after ${attempts} attempts → DLQ: ${reason}`);
    await this.deadLetter(id, value, reason);
    await this.redis.xack(this.stream, this.group, id);
    await this.clearAttempt(id);
  } else {
    console.warn(`[${this.name}] ${id} attempt ${attempts}/${MAX_ATTEMPTS} failed: ${reason}`);
    // Do NOT xack — message stays in PEL and XCLAIM/drainPending will retry
  }
}
```

Update `drainPending` (`:68-101`) to use the same tracking — never unconditionally ack. Use `xpending` + `xclaim` to recover messages whose attempt count is below the cap, and DLQ the rest:

```ts
private async drainPending(): Promise<void> {
  // XPENDING to discover stuck messages, XCLAIM with min-idle to take ownership,
  // then process exactly like the live loop.
  while (!this.shuttingDown) {
    const pending = await this.redis.xpending(this.stream, this.group, "IDLE", 60000, "-", "+", this.batchSize) as Array<[string, string, number, number]>;
    if (pending.length === 0) break;
    const ids = pending.map((p) => p[0]);
    const claimed = await this.redis.xclaim(this.stream, this.group, this.consumer, 60000, ...ids, "JUSTID") as string[];
    for (const id of claimed) {
      // Re-read via xrange
      const [entry] = await this.redis.xrange(this.stream, id, id) as [string, string[]][];
      if (!entry) continue;
      const [, fields] = entry;
      const value = fields[fields.indexOf(this.fieldName) + 1];
      if (!value) { await this.redis.xack(this.stream, this.group, id); continue; }
      // Reuse the same per-message try/catch as the live loop
      try {
        await this.processMessage(id, value);
        await this.redis.xack(this.stream, this.group, id);
        await this.clearAttempt(id);
      } catch (e) {
        const attempts = await this.incrementAttempt(id);
        if (attempts >= MAX_ATTEMPTS) {
          await this.deadLetter(id, value, String(e));
          await this.redis.xack(this.stream, this.group, id);
          await this.clearAttempt(id);
        }
      }
    }
  }
}
```

Note: subclasses must NOT ack inside `processMessage` for the new pattern (today brain-writer/drift-detector/extractor all ack inline). Remove those `xack` calls in those files — the base class now owns acking.

For H3 — extractor's silent drop on parse failure: throw an `ExtractionFailure` error instead of returning `[]`. The base class catches and DLQs after MAX_ATTEMPTS, which gives us the metric H3 asks for (count of messages in `events:dead`).

Add `apps/api/src/scripts/eval-worker-crash-recovery.ts`: pushes 100 messages, SIGKILLs the worker at message ~30, restarts it, asserts all 100 are processed exactly once and none are duplicated in Neo4j.

**Done criterion**

- Crash-recovery eval passes.
- After 5 deliberate `processMessage` exceptions on the same id, `XLEN events:dead` increments and the original PEL entry is acked.

---

## R6 — Decision idempotency

- **Findings:** C5, E5
- **Effort:** 3h
- **Blocked by:** R0
- **Goal:** Re-running ingestion never creates duplicate Decision nodes.

**Files to change**

- `apps/api/src/workers/brain-writer.ts`
- `apps/api/src/scripts/eval-decision-idempotency.ts` (NEW)

**Implementation notes**

In `brain-writer.ts`, derive a deterministic `decision_id` and switch from `CREATE` to `MERGE`:

```ts
import { createHash } from "crypto";

function deriveDecisionId(eventId: string, quotedText: string): string {
  return createHash("sha256")
    .update(`${eventId}:${quotedText.slice(0, 200)}`)
    .digest("hex");
}

// Inside writeToNeo4j, decisions loop:
for (const decision of result.decisions) {
  const decisionId = deriveDecisionId(result.event_id, decision.quoted_text);
  await session.run(
    `MATCH (e:Event {event_id: $event_id})
     MERGE (d:Decision {decision_id: $decision_id})
     ON CREATE SET
       d.project_id = $project_id,
       d.event_id = $event_id,
       d.quoted_text = $quoted_text,
       d.summary = $summary,
       d.rationale = $rationale,
       d.confidence = $confidence,
       d.codegen_prompt = $codegen_prompt,
       d.status = "confirmed",
       d.valid_from = $valid_from,
       d.valid_to = null
     ON MATCH SET
       d.summary = $summary,
       d.rationale = $rationale,
       d.confidence = $confidence
     MERGE (d)-[:EXTRACTED_FROM]->(e)`,
    {
      event_id: result.event_id,
      project_id: result.project_id,
      decision_id: decisionId,
      quoted_text: decision.quoted_text,
      summary: decision.summary,
      rationale: decision.rationale ?? "",
      confidence: decision.confidence,
      codegen_prompt: decision.codegen_prompt ?? null,
      valid_from: result.timestamp,
    }
  );
}
```

Note: existing rows already have UUID `decision_id`s — those will not collide with sha256 hex strings, so the migration is non-destructive. A separate cleanup migration to dedup historical duplicates is out-of-scope for this milestone (track in M3 backlog).

Add `eval-decision-idempotency.ts`: seeds a project, counts `MATCH (d:Decision) RETURN count(d)`, runs `pipeline:reset` + re-ingest, counts again, asserts unchanged.

**Done criterion**

- Eval passes. Decision count stable across two reset/re-ingest cycles.

---

## R7 — Brain-writer → drift-detector ordering via `events:brain_written`

- **Findings:** H4, E9
- **Effort:** 4h
- **Blocked by:** R5 (drift-detector ack pattern change), R6 (so MERGE drives a "first-write" signal cleanly)
- **Goal:** Drift detector never races the brain-writer.

**Files to change**

- `apps/api/src/lib/redis.ts` (add `BRAIN_WRITTEN`)
- `apps/api/src/workers/brain-writer.ts`
- `apps/api/src/workers/drift-detector.ts`

**Implementation notes**

Add to `STREAMS` in `redis.ts`: `BRAIN_WRITTEN: "events:brain_written"`.

In `brain-writer.ts` after the successful Qdrant upsert in `processMessage`:

```ts
await xaddCapped(writer, STREAMS.BRAIN_WRITTEN, "ref", JSON.stringify({
  event_id: result.event_id,
  project_id: result.project_id,
  source: result.source,
  has_decisions: result.decisions.length > 0,
  timestamp: result.timestamp,
  raw_content_sample: result.raw_content.slice(0, 2000), // drift-detector needs the text
  actor: result.actor,
}));
```

In `drift-detector.ts`, change `STREAMS.EXTRACTED` → `STREAMS.BRAIN_WRITTEN` and `fieldName: "result"` → `"ref"`. The payload shape changes too — adjust `processMessage` accordingly. Skip events where `has_decisions === false` is irrelevant to drift purposes (drift Stage A only matches against has_decisions chunks; the new event itself doesn't need decisions to challenge an existing one).

The consumer group is new — pick `group: "drift-detector-bw"` so it starts from the latest BRAIN_WRITTEN entry rather than replaying historical EXTRACTED data through the new stream.

**Done criterion**

- Eval E9: seed two contradicting events 100ms apart in random order, verify a DriftAlert is created in every run across 20 trials.

---

## R8 — Prompt-caching: structured content blocks + retrieved-context breakpoint

- **Findings:** C4, H16, E1
- **Effort:** 6h
- **Blocked by:** R2 (SDK bump)
- **Goal:** Cache the system prompt AND the retrieved context. Verify `cache_read_input_tokens > 0` in CI.

**Files to change**

- `apps/api/src/lib/llm.ts`
- `apps/api/src/services/query-engine.ts`
- `apps/api/src/workers/extractor.ts`
- `apps/api/src/scripts/eval-prompt-cache.ts` (NEW)

**Implementation notes**

Extend `chat()` to accept a structured user-content option. New signature:

```ts
export type ContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral"; ttl?: "5m" | "1h" } };

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  /** TTL applied to the system-prompt cache_control marker. */
  systemCacheTtl?: "5m" | "1h";
  /** If set, the last block in this array gets a cache_control breakpoint. */
  cachedUserContext?: ContentBlock[];
}

export async function chat(
  model: string,
  messages: Message[],
  options: LLMOptions = {}
): Promise<string> {
  const { temperature = 0, maxTokens = 1024, systemCacheTtl = "5m", cachedUserContext } = options;

  if (PROVIDER === "anthropic") {
    const system = messages.find((m) => m.role === "system")?.content;
    const userMessages = messages.filter((m) => m.role !== "system");

    // Build user-message content blocks.
    // If cachedUserContext is present, prepend it as separate blocks BEFORE the
    // final user turn. The last block of cachedUserContext gets cache_control.
    const finalUser = userMessages[userMessages.length - 1];
    const priorUsers = userMessages.slice(0, -1);

    let finalContent: ContentBlock[] | string = finalUser.content;
    if (cachedUserContext && cachedUserContext.length > 0) {
      const ctxBlocks = cachedUserContext.map((b, i) => ({
        ...b,
        cache_control: i === cachedUserContext.length - 1 ? { type: "ephemeral" as const } : undefined,
      }));
      finalContent = [...ctxBlocks, { type: "text", text: finalUser.content }];
    }

    const response = await anthropicClient.messages.create({
      model,
      max_tokens: maxTokens,
      system: system
        ? [{ type: "text", text: system, cache_control: { type: "ephemeral", ttl: systemCacheTtl } }]
        : undefined,
      messages: [
        ...priorUsers.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        { role: finalUser.role as "user" | "assistant", content: finalContent },
      ],
    });

    // OBSERVABILITY: log cache stats so eval can scrape
    console.log(JSON.stringify({
      evt: "llm.cache",
      model,
      input: response.usage.input_tokens,
      cache_read: response.usage.cache_read_input_tokens ?? 0,
      cache_create: response.usage.cache_creation_input_tokens ?? 0,
    }));

    return response.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  }
  // ... ollama path unchanged
}
```

Apply the same pattern to `chatStream()`.

In `query-engine.ts`, change the `prepareContext` userMessage build to pass the retrieved context as a separate cached block. Replace lines 302-307:

```ts
const userMessage = `Question: ${request.query}\n\nAnswer the question using only the context above. Cite every claim with [N].`;
const cachedUserContext: ContentBlock[] = [
  { type: "text", text: `Retrieved context:\n${context}` },
];
return { chunks, context, userMessage, cachedUserContext, startMs };
```

And in `runQuery` / `runQueryStream` pass `cachedUserContext` through `LLMOptions`.

In `extractor.ts`, the system prompt is large and stable but calls are bursty. Pass `systemCacheTtl: "1h"`.

In `llm.ts` `chatJSON` (H16 fix): hoist the JSON instruction string to a module constant and prepend it to the system block consistently — never concatenate dynamically:

```ts
const JSON_INSTRUCTION = "\n\n---\n\nRespond with valid JSON only. No markdown, no explanation, no code fences.";

export async function chatJSON<T>(model: string, messages: Message[], options: LLMOptions = {}): Promise<T> {
  const augmented = messages.map((m) =>
    m.role === "system" ? { ...m, content: m.content + JSON_INSTRUCTION } : m
  );
  if (!augmented.some((m) => m.role === "system")) {
    augmented.unshift({ role: "system", content: JSON_INSTRUCTION.trimStart() });
  }
  const raw = await chat(model, augmented, options);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(cleaned) as T;
}
```

Add `apps/api/src/scripts/eval-prompt-cache.ts`: makes 3 identical queries back-to-back, scrapes `llm.cache` log lines, asserts `cache_read_input_tokens > 0` on calls 2 and 3.

**Done criterion**

- `eval-prompt-cache` passes; cached-read tokens > 50% of input tokens on the second call.

---

## R9 — Embedding-sentinel guard

- **Findings:** C9
- **Effort:** 2h
- **Blocked by:** none
- **Goal:** A misconfigured worker can't silently corrupt the embedding-model sentinel.

**Files to change**

- `apps/api/src/lib/qdrant.ts`
- `apps/api/src/workers/brain-writer.ts`

**Implementation notes**

In `qdrant.ts`, replace `stampEmbeddingModel` with a check-first version:

```ts
export async function stampEmbeddingModel(embeddingModel: string): Promise<void> {
  const check = await checkEmbeddingModel(embeddingModel);
  if (!check.ok) {
    throw new Error(
      `Embedding model mismatch: collection stamped with ${check.stored}, ` +
      `current process configured with ${embeddingModel}. Refusing to overwrite. ` +
      `Fix EMBEDDING_MODEL env or migrate the collection.`
    );
  }
  if (check.stored === embeddingModel) return; // already correct, no-op
  // Sentinel does not exist yet — safe to stamp
  const vector = new Array<number>(VECTOR_SIZE).fill(0);
  vector[0] = 1;
  await qdrant.upsert(COLLECTION, {
    wait: true,
    points: [{ id: SENTINEL_ID, vector, payload: { _sentinel: true, embedding_model: embeddingModel } }],
  });
}
```

`brain-writer.ts:270` already calls `stampEmbeddingModel` — now it throws on mismatch, the worker exits non-zero, ECS / docker compose surfaces the failure.

**Done criterion**

- Manual test: stamp with model A, restart worker with `EMBEDDING_MODEL=modelB`, worker exits non-zero with the clear error message.

---

## R10 — Cross-project drift pass

- **Findings:** C11
- **Effort:** 6h
- **Blocked by:** R7 (uses the new `events:brain_written` stream)
- **Goal:** The cross-project drift promise from `personas.md` has a code path.

**Files to change**

- `apps/api/src/workers/drift-detector.ts`
- `apps/api/src/lib/neo4j.ts` (helper for resolving actor org-mates)
- `packages/types/src/index.ts` (add `cross_project: boolean` to `DriftAlert`)
- `apps/api/src/scripts/eval-cross-project-drift.ts` (NEW)

**Implementation notes**

Add `cross_project?: boolean` to `DriftAlert`. Default false on existing call sites.

In `drift-detector.ts`, after the in-project `stageA` call, add a second pass:

```ts
async function stageACrossProject(text: string, currentProjectId: string, actorPersonId: string, excludeEventIds: string[]) {
  const vector = await embed(text.slice(0, EMBED_MAX_CHARS));
  // Find other projects the actor is a member of
  const session = getSession();
  let otherProjectIds: string[] = [];
  try {
    const r = await session.run(
      `MATCH (:Person {person_id: $person_id})-[:MEMBER_OF]->(proj:Project)
       WHERE proj.project_id <> $current
       RETURN collect(proj.project_id) AS pids`,
      { person_id: actorPersonId, current: currentProjectId }
    );
    otherProjectIds = (r.records[0]?.get("pids") as string[]) ?? [];
  } finally { await session.close(); }
  if (otherProjectIds.length === 0) return [];

  const results = await qdrant.search(COLLECTION, {
    vector,
    limit: TOP_K * 4,
    filter: {
      must: [
        { key: "project_id", match: { any: otherProjectIds } },
        { key: "has_decisions", match: { value: true } },
      ],
    },
    with_payload: true,
    score_threshold: SEMANTIC_THRESHOLD,
  });
  // Same dedup/scoring as in-project stageA
  // ...
}
```

Run cross-project stageA only when the in-project pass found nothing OR the source is `agent` (agent-authored changes are the most common cross-project drift vector). Apply same Stage C confirmation. Write the alert with `cross_project: true`.

Add eval `eval-cross-project-drift.ts`: seed project A with decision "use Postgres", seed project B (same actor) with signal "we should switch to DynamoDB", assert a cross-project DriftAlert is created.

**Done criterion**

- Eval passes. UI `cross_project` flag carries through to JSON response.

---

## R11 — Auth hardening

- **Findings:** H7, H8, H10, H17
- **Effort:** 4h
- **Blocked by:** none
- **Goal:** Fail-closed membership checks, constant-time secret compares, no API key in browser memory.

**Files to change**

- `apps/api/src/lib/auth-middleware.ts`
- `apps/api/src/routes/webhooks.ts` (fireflies)
- `apps/api/src/routes/auth.ts` (don't return api_key)
- `apps/web/app/components/Chat.tsx` (use cookie auth, not in-memory key)

**Implementation notes**

In `auth-middleware.ts`:

```ts
import { timingSafeEqual } from "crypto";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// :25 — replace DEV_API_KEY comparison
if (DEV_API_KEY && process.env.NODE_ENV === "development" && safeEqual(raw as string, DEV_API_KEY)) {
  req.dev_bypass = true;
  return;
}
```

H10 — fix `requireProjectMember` and `assertProjectMember` to fail closed:

```ts
export async function requireProjectMember(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.dev_bypass) return;
  const person_id = req.actor?.person_id;
  if (!person_id) {
    return reply.status(401).send({ error: "Authentication required" });
  }
  // ... existing project_id resolution ...
  if (!project_id) return;
  const isMember = await checkPersonInProject(person_id, project_id);
  if (!isMember) return reply.status(403).send({ error: "Access denied to project" });
}

export async function assertProjectMember(req, reply, projectId, resourceLabel = "Resource"): Promise<boolean> {
  if (req.dev_bypass) return true;
  const person_id = req.actor?.person_id;
  if (!person_id) { await reply.status(401).send({ error: "Authentication required" }); return false; }
  if (!projectId) { await reply.status(404).send({ error: `${resourceLabel} not found` }); return false; }
  const isMember = await checkPersonInProject(person_id, projectId);
  if (!isMember) { await reply.status(404).send({ error: `${resourceLabel} not found` }); return false; }
  return true;
}
```

H8 — fireflies in `webhooks.ts:287`:

```ts
if (!sig || !safeEqual(sig, secret)) {
  return reply.code(401).send({ error: "Invalid signature" });
}
```

H17 — `apps/web/app/components/Chat.tsx` and `apps/api/src/routes/auth.ts`: stop returning `api_key` from `/auth/me`. The web app should proxy brain requests through Next.js server routes (or use the cookie session directly). All `apiKey` state and `headers["X-API-Key"]` usage in Chat.tsx is deleted; requests go to `/api/brain/*` (Next.js route handler) which forwards with the session cookie.

**Done criterion**

- Searching the web bundle for the user's api_key string returns no matches.
- Unauthenticated call to `/brain/query` returns 401, not silent pass.

---

## R12 — Webhook secret out of query string

- **Findings:** H9
- **Effort:** 1h
- **Blocked by:** none
- **Goal:** Jira webhook secret stops appearing in access logs.

**Files to change**

- `apps/api/src/routes/webhooks.ts`
- `docs/technical/architecture.md` (document the header)

**Implementation notes**

In `webhooks.ts:196-202`:

```ts
if (secret) {
  const token = request.headers["x-jira-webhook-token"] as string | undefined;
  if (!token || !safeEqual(token, secret)) {
    return reply.code(401).send({ error: "Invalid token" });
  }
}
```

Also strip `request.query.token` from any logging just in case operators still configure the old way during transition: add a hook that scrubs `token` from query in `request.log` bindings.

Document the cutover in `architecture.md` and tell operators to rotate `JIRA_WEBHOOK_SECRET` after they update Jira to use the header.

**Done criterion**

- `tail -f` of API logs during a Jira webhook delivery shows no `token=` substring.

---

## R13 — Identity link scoped to caller projects

- **Findings:** H11
- **Effort:** 3h
- **Blocked by:** R11
- **Goal:** A caller can only link Person nodes whose events live in projects they're members of.

**Files to change**

- `apps/api/src/lib/neo4j.ts` (linkPersonIdentities)
- `apps/api/src/routes/identity.ts`
- `apps/api/src/scripts/eval-identity-tenant-isolation.ts` (NEW)

**Implementation notes**

Change `linkPersonIdentities` to accept a `callerPersonId` and constrain the candidate match:

```ts
export async function linkPersonIdentities(params: {
  github_login?: string;
  slack_user_id?: string;
  jira_user_id?: string;
  email?: string;
  name?: string;
  callerPersonId: string; // NEW — required
}): Promise<{ person_id: string; merged_count: number }> {
  // ... existing condition build ...

  // Constrain matches to people whose events appear in the caller's projects
  const result = await session.run(
    `MATCH (caller:Person {person_id: $caller_id})-[:MEMBER_OF]->(proj:Project)
     WITH collect(proj.project_id) AS caller_projects
     MATCH (p:Person) WHERE ${conditions.join(" OR ")}
     WITH p, caller_projects
     WHERE EXISTS {
       MATCH (e:Event)-[:AUTHORED_BY]->(p)
       WHERE e.project_id IN caller_projects
     }
     RETURN p
     ORDER BY CASE WHEN p.email IS NOT NULL THEN 0 ELSE 1 END, p.created_at ASC`,
    { ...params, caller_id: callerPersonId }
  );
  // ... rest unchanged
}
```

Update `routes/identity.ts` to pass `req.actor.person_id` as `callerPersonId`.

Eval `eval-identity-tenant-isolation.ts`: user A in project P, person X has events only in project Q. User A tries to link X.slack_user_id → A's email. Expect 0 merges.

**Done criterion**

- Eval passes.

---

## R14 — Qdrant and Neo4j hot-path indexes

- **Findings:** H12, H13
- **Effort:** 3h
- **Blocked by:** none
- **Goal:** Query latency stops scaling linearly with collection / graph size.

**Files to change**

- `apps/api/src/lib/qdrant.ts`
- `apps/api/src/scripts/migrate-neo4j-constraints.ts`

**Implementation notes**

In `qdrant.ts` extend `ensureCollection`:

```ts
export async function ensureCollection() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c: { name: string }) => c.name === COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
  }
  // Idempotent: createPayloadIndex returns 200 even if the index already exists
  await qdrant.createPayloadIndex(COLLECTION, { field_name: "project_id", field_schema: "keyword", wait: true });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: "source_id", field_schema: "keyword", wait: true });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: "graph_node_id", field_schema: "keyword", wait: true });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: "source", field_schema: "keyword", wait: true });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: "has_decisions", field_schema: "bool", wait: true });
  await qdrant.createPayloadIndex(COLLECTION, { field_name: "actor_person_id", field_schema: "keyword", wait: true });
}
```

In `migrate-neo4j-constraints.ts`, add to `CONSTRAINTS`:

```ts
{ name: "project_id_unique", label: "Project", property: "project_id" },
```

Add new index list:

```ts
const HOT_PATH_INDEXES = [
  { name: "event_project_id_idx",   cypher: "CREATE INDEX event_project_id_idx   IF NOT EXISTS FOR (e:Event)        ON (e.project_id)" },
  { name: "event_timestamp_idx",    cypher: "CREATE INDEX event_timestamp_idx    IF NOT EXISTS FOR (e:Event)        ON (e.timestamp)" },
  { name: "event_source_idx",       cypher: "CREATE INDEX event_source_idx       IF NOT EXISTS FOR (e:Event)        ON (e.source)" },
  { name: "event_proj_src_idx",     cypher: "CREATE INDEX event_proj_src_idx     IF NOT EXISTS FOR (e:Event)        ON (e.project_id, e.source)" },
  { name: "decision_project_id_idx",cypher: "CREATE INDEX decision_project_id_idx IF NOT EXISTS FOR (d:Decision)    ON (d.project_id)" },
  { name: "decision_status_idx",    cypher: "CREATE INDEX decision_status_idx    IF NOT EXISTS FOR (d:Decision)    ON (d.status)" },
  { name: "drift_resolution_idx",   cypher: "CREATE INDEX drift_resolution_idx   IF NOT EXISTS FOR (a:DriftAlert)  ON (a.resolution)" },
  { name: "task_project_id_idx",    cypher: "CREATE INDEX task_project_id_idx    IF NOT EXISTS FOR (t:FollowUpTask) ON (t.project_id)" },
  { name: "task_status_idx",        cypher: "CREATE INDEX task_status_idx        IF NOT EXISTS FOR (t:FollowUpTask) ON (t.status)" },
];

for (const idx of HOT_PATH_INDEXES) {
  await session.run(idx.cypher);
  console.log(`[migrate-constraints] ✓ ${idx.name}`);
}
```

**Done criterion**

- `migrate:constraints` succeeds on a fresh and an existing Neo4j.
- `SHOW INDEXES` in Cypher lists all of them with `state=ONLINE`.
- Qdrant `GET /collections/brain_chunks` reports the payload schema with all six indexes.

---

## R15 — Source classifier: explicit `unknown` default

- **Findings:** H14
- **Effort:** 1h
- **Blocked by:** R0 (since brain-writer now reads `result.source` directly)
- **Goal:** Unknown event-id prefixes no longer misclassify as github.

**Files to change**

- `apps/api/src/lib/event-source.ts`
- `packages/types/src/index.ts` — extend `EventSource` to include `"unknown"`
- `apps/api/src/workers/drift-detector.ts:170` — accept `unknown` events for drift

**Implementation notes**

In `event-source.ts`, change the final fallback to return `"unknown"` and emit a warn log so we notice new prefixes. After R0, this function is only called as a defensive fallback — the canonical path uses the typed `source` field.

```ts
export function inferSourceFromEventId(eventId: string): EventSource {
  if (eventId.startsWith("agent_")) return "agent";
  if (eventId.startsWith("meeting_")) return "meeting";
  if (eventId.startsWith("jira_")) return "jira";
  if (eventId.startsWith("slack_")) return "slack";
  if (eventId.startsWith("doc_")) return "document";
  if (eventId.startsWith("linked_pr_") || /^[0-9a-f-]{36}$/.test(eventId)) return "github";
  console.warn(`[event-source] unknown event_id prefix, returning "unknown": ${eventId}`);
  return "unknown";
}
```

In `drift-detector.ts:170` change `if (source === "github")` to `if (source === "github")` only — `unknown` now falls through and is processed (which is the safe behaviour).

**Done criterion**

- Unit test for `inferSourceFromEventId("future_42")` returns `"unknown"`.

---

## R16 — Agent-log: extract ticket_refs and person_mentions

- **Findings:** H1, E6
- **Effort:** 3h
- **Blocked by:** R0
- **Goal:** `brain_analyze_impact` traverses from agent decision → Ticket node.

**Files to change**

- `apps/api/src/routes/brain.ts` (agent-log handler)
- `apps/api/src/lib/text-mentions.ts` (NEW, shared with normalizer)
- `apps/api/src/scripts/eval-agent-log-mentions.ts` (NEW)

**Implementation notes**

Lift the ticket-ref / person-mention regexes from `apps/api/src/workers/normalizer.ts` into `apps/api/src/lib/text-mentions.ts`:

```ts
const TICKET_RE = /\b([A-Z]{2,8}-\d+)\b/g;
const MENTION_RE = /@([a-zA-Z0-9_.-]+)/g;

export function extractTicketRefs(text: string): string[] {
  return [...new Set([...text.matchAll(TICKET_RE)].map((m) => m[1]))];
}
export function extractPersonMentions(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]))];
}
```

Update `normalizer.ts` to import from the shared module (no behaviour change).

In `brain.ts` agent-log handler, run extraction against the combined `rawContent + decisions text`:

```ts
const combinedText = [rawContent, ...log.decisions.map((d) => `${d.description} ${d.rationale}`)].join("\n");
const ticket_refs = extractTicketRefs(combinedText);
const person_mentions = extractPersonMentions(combinedText);

const extractionResult: ExtractionResult = {
  // ...
  ticket_refs,
  person_mentions,
  // ...
};
```

Eval `eval-agent-log-mentions.ts`: POST an agent log mentioning `PROJ-412` and `@alice`, query Neo4j for `(t:Ticket {ref: "PROJ-412"})<-[:REFERENCES]-(e:Event {event_id: ...})`, assert present.

**Done criterion**

- Eval passes.

---

## R17 — Transcript per-segment timestamps

- **Findings:** H2, E7
- **Effort:** 3h
- **Blocked by:** none
- **Goal:** Decisions within a meeting have monotonically increasing `valid_from`.

**Files to change**

- `apps/api/src/routes/brain.ts` (transcript handler)
- `apps/api/src/lib/transcript-parser.ts` (expose per-chunk timestamps)
- `apps/api/src/scripts/eval-transcript-timestamps.ts` (NEW)

**Implementation notes**

The parser already produces segments with `start_time`. Extend `chunkText` (or replace the call here) so it returns `Array<{ text: string; start_time?: number }>` instead of `string[]`.

In `brain.ts:155-184`, compute per-chunk timestamps as `new Date(Date.parse(baseDate) + chunkStartSeconds * 1000).toISOString()`. For plain-text input without time codes, fall back to `baseDate`.

Eval `eval-transcript-timestamps.ts`: POST a VTT with 3 segments at 00:00:00, 00:05:00, 00:10:00. Assert the 3 resulting Event timestamps are 5 minutes apart.

**Done criterion**

- Eval passes.

---

## R18 — CDK ALB HTTPS listener

- **Findings:** H6
- **Effort:** 4h
- **Blocked by:** none (infra-side, parallelisable)
- **Goal:** Marketplace metering reaches the API.

**Files to change**

- `apps/cdk/lib/app-stack.ts`
- `apps/cdk/lib/metering-stack.ts`
- A new ACM cert in the existing certificate stack (or hosted-zone DNS validation)

**Implementation notes**

In `app-stack.ts`, add a 443 listener with an ACM certificate. Redirect 80 → 443. Use the existing hosted zone (`Route53.HostedZone.fromLookup`). The Lambda's https rewrite then resolves correctly.

Smoke test: from the metering Lambda's region, `curl -i https://<alb-dns>/health` returns 200.

**Done criterion**

- `cdk diff` shows the 443 listener and ACM cert.
- After deploy, `aws marketplace-metering meter-usage --dry-run` succeeds.

---

## R19 — Web client: delete client-side intent parsing

- **Findings:** H5
- **Effort:** 3h
- **Blocked by:** none
- **Goal:** Streaming and intent parsing are no longer mutually exclusive.

**Files to change**

- `apps/web/app/components/Chat.tsx`
- `apps/api/src/services/query-engine.ts` (return `mode_used` in done event)
- `apps/api/src/routes/query.ts` (include `mode_used` in streaming `done`)

**Implementation notes**

Delete `detectTemporal` and the time-range synthesis (lines ~39-88). Always send the raw query to the streaming endpoint. Server intent-parser decides mode and returns it in the `done` SSE event:

```ts
yield { type: "done", answer, citations, citation_warning, latency_ms, mode_used: "temporal" };
```

UI renders the mode badge from `mode_used` on the done event.

**Done criterion**

- Manual test: a temporal query renders streaming tokens AND shows the "temporal" mode badge after completion.
- Grep `Chat.tsx` for "detectTemporal" returns nothing.

---

## R20 — CORS consolidation

- **Findings:** H18
- **Effort:** 1h
- **Blocked by:** none
- **Goal:** Single source of truth for allowed origins.

**Files to change**

- `apps/api/src/index.ts`
- `apps/api/src/routes/query.ts`

**Implementation notes**

In `index.ts`, configure `@fastify/cors` with `origin` as a comma-split list from env `WEB_ORIGINS` (note plural):

```ts
const allowedOrigins = (process.env.WEB_ORIGINS ?? "http://localhost:3000")
  .split(",").map((s) => s.trim()).filter(Boolean);
await app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
});
```

Remove the bespoke origin handling in `routes/query.ts`.

**Done criterion**

- Two configured origins both pass `OPTIONS` preflight; a third (not in list) returns 403.

---

## R21 — Demo mode flag (decouples from NODE_ENV)

- **Findings:** H19, M12
- **Effort:** 2h
- **Blocked by:** R11
- **Goal:** Demo compose is functional without lying about NODE_ENV.

**Files to change**

- `apps/api/src/lib/auth-middleware.ts`
- `docker-compose.demo.yml`

**Implementation notes**

Replace the `NODE_ENV === "development"` gate with an explicit `DEMO_MODE` env:

```ts
const DEMO_MODE = process.env.DEMO_MODE === "true";
// ...
if (DEV_API_KEY && DEMO_MODE && safeEqual(raw as string, DEV_API_KEY)) {
  req.dev_bypass = true;
  return;
}
```

`docker-compose.demo.yml` sets `DEMO_MODE=true` and `NODE_ENV=production`. The `seed:demo` script's dev key now works.

Log a single warning at API startup if `DEMO_MODE=true` AND `NODE_ENV=production` so it's visible if accidentally enabled in real prod.

**Done criterion**

- `docker compose -f docker-compose.demo.yml up` followed by a brain_query through the dev key returns a 200.

---

## R22 — Release pipeline gate

- **Findings:** H20, E11
- **Effort:** 4h
- **Blocked by:** R1, R8, R5 (so the gate's eval suite is meaningful)
- **Goal:** Broken builds can't reach `beta-latest`.

**Files to change**

- `.github/workflows/release.yml`
- `apps/api/src/scripts/eval-release-gate.ts` (NEW — orchestrates short curated suite)

**Implementation notes**

Add a `quality-gate` job before `build-and-push`:

```yaml
quality-gate:
  runs-on: ubuntu-latest
  services:
    redis:    { image: redis:7-alpine, ports: ["6379:6379"] }
    neo4j:    { image: neo4j:5, env: { NEO4J_AUTH: "neo4j/password" }, ports: ["7687:7687"] }
    qdrant:   { image: qdrant/qdrant:latest, ports: ["6333:6333"] }
  steps:
    - uses: actions/checkout@v4
    - uses: actions/setup-node@v4
      with: { node-version: '20' }
    - run: npm ci
    - run: npm run typecheck --workspaces
    - run: npm --workspace apps/api run eval:release-gate
      env:
        ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
build-and-push:
  needs: quality-gate
  # ... existing job
```

`eval-release-gate.ts` orchestrates a focused suite (no full-eval cost): typecheck, idempotency-concurrent, decision-idempotency, prompt-cache. Total runtime budget: 5 minutes.

**Done criterion**

- A deliberate typecheck error in a PR to `release-*` blocks the push to GHCR.

---

## R23 — Worker health-check endpoints

- **Findings:** H21
- **Effort:** 4h
- **Blocked by:** R5 (the heartbeat is updated inside the new StreamWorker loop)
- **Goal:** docker compose / ECS can detect a wedged worker.

**Files to change**

- `apps/api/src/lib/stream-worker.ts`
- `apps/api/src/workers/*.ts` (boot the HTTP listener)
- `docker-compose.yml`

**Implementation notes**

In `StreamWorker`, expose a `lastProgressAt` timestamp updated on every successful or failed process attempt. Add a method `startHealthServer(port)` that launches a tiny `http.createServer` returning 200 if `Date.now() - lastProgressAt < 60_000`, else 503.

Each worker calls `this.startHealthServer(parseInt(process.env.HEALTH_PORT ?? "3010"))` before `run()`. Assign different ports per worker in compose (3010 extractor, 3011 brain-writer, 3012 drift, 3013 slack).

`docker-compose.yml` adds `healthcheck` blocks:

```yaml
healthcheck:
  test: ["CMD", "wget", "-qO-", "http://localhost:3010/health"]
  interval: 30s
  timeout: 5s
  retries: 3
```

**Done criterion**

- `docker compose ps` shows worker health as `healthy`. Killing the worker's main loop (simulated wedge via debugger) flips it to `unhealthy` within 90s.

---

## R24 — Signals queue: async + Stage C confirmation

- **Findings:** H22, H25
- **Effort:** 5h
- **Blocked by:** R4, R5
- **Goal:** `POST /brain/signals` returns immediately. Alerts are only created on Stage-C confirmation.

**Files to change**

- `apps/api/src/lib/redis.ts` (add `SIGNALS` stream)
- `apps/api/src/routes/brain.ts` (signals handler)
- `apps/api/src/workers/signal-worker.ts` (NEW)
- `apps/api/src/services/signal-engine.ts`
- `apps/api/package.json` (add `worker:signals` script)

**Implementation notes**

Add `SIGNALS: "events:signals"` to `STREAMS`. Signals handler:

```ts
const signalId = uuidv4();
await xaddCapped(redis, STREAMS.SIGNALS, "signal", JSON.stringify({ ...req.body, signal_id: signalId, received_at: new Date().toISOString() }));
return { ok: true, signal_id: signalId, status: "queued" };
```

`workers/signal-worker.ts` extends `StreamWorker` (group `signal-worker`, fieldName `signal`) and calls `processSignal(payload)`.

In `signal-engine.ts`, before writing the alert add Stage C confirmation (reuse the `stageC` function from drift-detector — extract into a shared helper `lib/drift-stage-c.ts`):

```ts
import { confirmDrift } from "../lib/drift-stage-c.js";

// After fetching `decisions`, run stage C
const confirmation = await confirmDrift(req.text, decisions.map((d) => ({
  decision_id: d.decision_id,
  summary: d.summary,
  quoted_text: d.quoted_text,
  score: 0, // not needed for stage C
})));
const confirmedIds = new Set(confirmation.drifts.map((d) => d.decision_id));
const confirmedDecisions = decisions.filter((d) => confirmedIds.has(d.decision_id));

if (confirmedDecisions.length === 0) {
  return { ok: true, drift_alerts_created: 0, matched_decisions: decisions.length, message: "Matched decisions found but no drift confirmed." };
}

// Write alerts only for confirmed
await Promise.all(confirmedDecisions.map((d) => writeDriftAlert({ ..., confirmed_by_llm: true })));
```

**Done criterion**

- Signals POST returns in <50ms.
- A signal that matches semantically but doesn't contradict produces 0 alerts (verified by eval).

---

## R25 — Query engine: parallel embed+intent, citation correctness

- **Findings:** H23, H24
- **Effort:** 4h
- **Blocked by:** R8 (interacts with prepareContext refactor)
- **Goal:** Cut ~400ms per query; eliminate false-valid citations.

**Files to change**

- `apps/api/src/services/query-engine.ts`
- `apps/api/src/routes/query.ts`

**Implementation notes**

H24 — in `routes/query.ts` where `parseQueryIntent` and the eventual embed are called, run them in parallel:

```ts
const [intent, queryVector] = await Promise.all([
  parseQueryIntent(req.query, MODELS.EXTRACTION),
  embed(req.query),
]);
```

Thread the precomputed `queryVector` into `prepareContext` via an optional parameter so it doesn't re-embed.

H23 — `assembleContext` returns the trimmed chunk list, and the caller passes only that trimmed list to `buildCitations`:

```ts
function assembleContext(chunks: ContextChunk[]): { context: string; usedChunks: ContextChunk[] } {
  let context = "";
  let budget = CONTEXT_BUDGET_CHARS;
  const usedChunks: ContextChunk[] = [];
  for (const chunk of chunks) {
    const entry = `[${chunk.index}] Source: ${chunk.source_url} | Author: ${chunk.actor_name} | ${chunk.timestamp}\n${chunk.content}\n\n`;
    if (entry.length > budget) break;
    context += entry;
    budget -= entry.length;
    usedChunks.push(chunk);
  }
  return { context: context.trim(), usedChunks };
}
```

Update `prepareContext` and both `runQuery` / `runQueryStream` to use `usedChunks` for `buildCitations`.

**Done criterion**

- Latency eval shows median query latency drops by >300ms.
- An eval that crafts a chunk past budget, asks a question that would cite it, and asserts `citation_warning: true`.

---

## R26 — Web XSS hardening (citation URL filter)

- **Findings:** E10
- **Effort:** 2h
- **Blocked by:** none
- **Goal:** A malicious `source_url` cannot inject script.

**Files to change**

- `apps/web/app/components/Chat.tsx` (and any other component rendering `citation.source_url`)
- `apps/web/lib/safe-url.ts` (NEW)

**Implementation notes**

```ts
// apps/web/lib/safe-url.ts
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "brain:"]);

export function safeHref(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw, "http://placeholder/"); // base allows relative
    if (!SAFE_SCHEMES.has(u.protocol)) return undefined;
    return u.toString();
  } catch { return undefined; }
}
```

Replace all `href={citation.source_url}` with `href={safeHref(citation.source_url) ?? "#"}`. If `safeHref` returns undefined, render plain text.

Add a unit test with input `javascript:alert(1)` — must yield undefined.

**Done criterion**

- Unit test passes; manual smoke with a `javascript:` URL in seed data renders as plain text.

---

## R27 — MCP end-to-end eval

- **Findings:** E8
- **Effort:** 4h
- **Blocked by:** R1 (Python wrappers callable for analogue), R6 (no duplicate decisions polluting recall)
- **Goal:** A test asserts the product's core promise: write via MCP tool A, recall via MCP tool B in a fresh client.

**Files to change**

- `apps/api/src/scripts/eval-mcp-end-to-end.ts` (NEW)

**Implementation notes**

Test plan:

1. Spawn a fresh MCP client connected to the brain via stdio.
2. Call `brain_log_decision` with a unique watermark string ("decision-watermark-{uuid}").
3. Tear down the MCP client.
4. Spawn a **new** MCP client (different agent id, no shared state).
5. Call `brain_query` with a question that should return the watermark.
6. Assert the watermark is in the answer and the citation source_url points to the agent_log event.

**Done criterion**

- Eval passes on a clean brain.

---

## R28 — Medium-tier bundle 1: metrics + temporal batching

- **Findings:** M1, M2
- **Effort:** 8h
- **Blocked by:** R23 (worker HTTP server hosts metrics endpoint)
- **Goal:** Observable pipeline + faster temporal queries.

**Files to change**

- `apps/api/src/lib/metrics.ts` (NEW — thin prom-client wrapper)
- `apps/api/src/lib/llm.ts` (record llm latency + cache stats)
- `apps/api/src/lib/stream-worker.ts` (record processed/errors)
- `apps/api/src/services/temporal-engine.ts`
- All worker entry points (expose `/metrics`)

**Implementation notes**

Use `prom-client`. Standard metrics:

- `stream_lag{stream}` — gauge, computed as `XINFO STREAM lastID - consumer pendingId`
- `worker_processed_total{worker}` — counter
- `worker_errors_total{worker,reason}` — counter
- `worker_dlq_total{worker}` — counter
- `llm_latency_ms{model,operation}` — histogram
- `llm_cache_read_tokens{model}` — counter
- `query_latency_ms` — histogram

Expose at `/metrics` on the same HTTP server R23 added.

M2 — in `temporal-engine.ts:findPriorVersion`, replace the N-query loop with a single batched flow:

```ts
const vectors = await embedBatch(candidates.map((c) => c.summary));
// Single Qdrant batch search via /points/search/batch
const batchResults = await qdrant.searchBatch(COLLECTION, vectors.map((v) => ({ vector: v, limit: 3, filter: ... })));
// Single Neo4j session, IN clause for all event_ids
```

**Done criterion**

- `curl localhost:3010/metrics` returns Prometheus exposition format with the expected metric names.
- Temporal query latency on a 50-decision corpus drops by >50%.

---

## R29 — Medium-tier bundle 2: extractor strategies, query mode gating, citation polish

- **Findings:** M3, M4, M5, M7, M9, M10, M13
- **Effort:** 10h
- **Blocked by:** R0, R8
- **Goal:** Implement the remaining query-layer and extraction-spec items.

**Files to change**

- `apps/api/src/workers/extractor.ts` (Slack thread context, meeting sliding window, Jira status mapping)
- `apps/api/src/routes/query.ts` (reject unimplemented modes with 400)
- `apps/api/src/workers/brain-writer.ts` (carry `actor_type` into Qdrant payload)
- `apps/api/src/services/query-engine.ts` (priority-order sort before budget; key-term overlap validation)
- `apps/api/src/workers/drift-detector.ts` (max score per event_id)
- `docs/technical/anomaly-engine.md` (document phasing of remaining 6 detectors)

**Implementation notes**

M5 — query route validates `mode`:

```ts
const IMPLEMENTED_MODES = new Set(["project", "temporal", "impact"]);
if (req.mode && !IMPLEMENTED_MODES.has(req.mode)) {
  return reply.status(400).send({ error: `Mode '${req.mode}' is not yet implemented. Use 'project' for now.` });
}
```

M7 — pass `actor.type` through `ExtractionResult` (already typed) and store as `actor_type` in Qdrant payload. Citation construction reads it instead of hardcoding `"human"`.

M9 — sort chunks by `score * (has_decisions ? 1.2 : 1.0) * recencyBoost(timestamp)` before applying the budget.

M10 — implement key-term overlap. Extract noun phrases / tokens from cited claim sentence, require ≥30% overlap with chunk text. Mark `citation_warning: true` when below threshold.

M13 — `drift-detector.ts:74-96` track max score:

```ts
for (const r of results) {
  const id = r.payload?.graph_node_id as string | undefined;
  if (!id) continue;
  const prev = scoreByEventId.get(id) ?? -1;
  if (r.score > prev) scoreByEventId.set(id, r.score);
}
```

M3, M4 — stub detector files (`anomaly-velocity.ts`, `anomaly-ownership.ts`, ...) and document phasing in `anomaly-engine.md`. Implementation lands post-beta; the stubs make the intent visible.

**Done criterion**

- Citation actor_type carries through for agent-source citations.
- Mode `expertise` returns 400.
- Eval `eval-drift-fp` shows the same false-positive rate or lower (no regression).

---

## R30 — Medium-tier bundle 3: ops/cleanup

- **Findings:** M6, M8, M11, M14
- **Effort:** 4h
- **Blocked by:** none
- **Goal:** Final polish.

**Files to change**

- `apps/api/src/scripts/reset-pipeline.ts` (M6)
- `apps/api/src/workers/slack-listener.ts` (M8)
- `apps/api/scripts/obfuscate.mjs` and `apps/api/package.json` build scripts (M11)
- `apps/api/src/lib/config.ts` (M14)

**Implementation notes**

M6 — require `--confirm <project_id>` matching, remove the hardcoded default:

```ts
const args = process.argv.slice(2);
const confirmIdx = args.indexOf("--confirm");
const confirmedProject = confirmIdx >= 0 ? args[confirmIdx + 1] : null;
if (!confirmedProject || confirmedProject !== TARGET_PROJECT) {
  console.error("Refusing to reset. Pass --confirm <project_id> matching the target.");
  process.exit(1);
}
```

M8 — Redis-backed TTL cache for Slack users:

```ts
async function getSlackUser(client: WebClient, userId: string): Promise<UserInfo> {
  const cached = await redis.get(`slack:user:${userId}`);
  if (cached) return JSON.parse(cached);
  const res = await client.users.info({ user: userId });
  await redis.setex(`slack:user:${userId}`, 3600, JSON.stringify(res.user));
  return res.user;
}
```

M11 — delete `obfuscate.mjs`, remove `build:release` and `obfuscate` scripts; `build` is now the only build path. Also remove the `javascript-obfuscator` devDependency.

M14 — `config.ts` validates `SESSION_SECRET.length >= 32` at startup, exits non-zero with a clear message and a `head -c 64 /dev/urandom | base64` suggestion.

**Done criterion**

- All four fixes verified manually: reset without `--confirm` exits 1; Slack user fetched twice hits cache; build path no longer obfuscates; short SESSION_SECRET prevents API startup.

---

## Out-of-scope (tracked separately)

- Backfill cleanup of historical duplicate `Decision` nodes created before R6 (M3 follow-up task).
- Person/email-based observability (privacy review needed).
- The 6 unimplemented anomaly-engine detectors beyond stubs (Phase 4 backlog).
