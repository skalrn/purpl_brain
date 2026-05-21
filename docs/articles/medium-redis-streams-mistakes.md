# Eight Redis Streams Mistakes That Will Quietly Destroy Your AI Pipeline

---

Redis Streams look simple. You `XADD` events into a stream, workers `XREADGROUP` from consumer groups, they `XACK` when done. It is roughly 30 lines of code to get a working pipeline. The simplicity is real — and it hides a specific class of mistakes that only surface under load, under failure, or at the exact worst moment.

We built a four-stage AI extraction pipeline on Redis Streams: webhooks land in `events:raw`, a normalizer enriches them into `events:normalized`, an LLM extractor writes to `events:extracted`, a drift detector processes from `events:extracted` in parallel. The system ran correctly in development for weeks. A full review of the production codebase found eight mistakes. None of them surfaced during normal operation. All of them would have caused data loss, cascading failures, or silent corruption in production.

Here is what they are, why they happen, and exactly how to fix each one.

---

## Mistake 1: 🧨 No MAXLEN on Any Stream

**What we did:**

```typescript
await redis.xadd("events:raw", "*", "event", JSON.stringify(event));
```

No `MAXLEN`. No `MINID`. The stream grows forever.

**What breaks:** If the extractor stalls — Anthropic returns 5xx, you hit rate limits, a Neo4j query times out — the normalizer keeps writing into `events:normalized`. At roughly 10KB per canonical event, a sustained 1,000 events per hour into a stalled stream consumes 240MB per day. Redis on a standard cloud instance runs with no `maxmemory` limit configured by default. The Redis container OOMs. Redis dies. This takes down not just the pipeline but the entire API server that shares the same Redis connection.

**The fix:**

```typescript
// Helper that every xadd call should use
async function xaddCapped(
  redis: Redis,
  stream: string,
  data: Record<string, string>
): Promise<string> {
  const args: (string | number)[] = [stream, "MAXLEN", "~", 100_000, "*"];
  for (const [k, v] of Object.entries(data)) args.push(k, v);
  return redis.xadd(...(args as Parameters<typeof redis.xadd>)) as Promise<string>;
}
```

The `~` makes the trim approximate — Redis trims to a radix tree node boundary, which is faster and good enough. 100,000 events at 10KB is 1GB maximum — set it relative to your event size and Redis memory budget.

---

## Mistake 2: 🔄 No PEL Recovery on Startup

**What we did:**

Workers called `XREADGROUP` to read new messages. On startup, they started reading `>` (new, never-delivered messages). Nothing else.

**What breaks:** When a worker crashes mid-processing, the message stays in the Pending Entries List (PEL) — delivered to the consumer but not yet acknowledged. On restart, the new worker instance starts reading new messages and never claims the pending ones. PEL grows on every crash. Those messages are never processed again.

**The fix:** On startup, before entering the main loop, drain the PEL for your consumer group:

```typescript
async function drainPending(redis: Redis, stream: string, group: string, consumer: string) {
  while (true) {
    // Claim messages idle > 60s that belong to any dead consumer
    const results = await redis.xautoclaim(
      stream, group, consumer,
      60_000,   // min-idle-time in ms
      "0-0",    // start from beginning of PEL
      "COUNT", "100"
    );
    
    const messages = results[1] as string[][];
    if (!messages || messages.length === 0) break;
    
    for (const msg of messages) {
      const [id, fields] = msg;
      await processWithRetryTracking(id, fields, stream, group, redis);
    }
  }
}
```

`XAUTOCLAIM` (Redis 6.2+) atomically finds idle messages and re-assigns them to your consumer. Run this on every worker startup before entering `XREADGROUP >`.

---

## Mistake 3: ☠️ Ack-and-Drop on Second Failure

**What we did:**

```typescript
// drainPending in stream-worker.ts
try {
  await this.processMessage(id, value);
  await redis.xack(stream, group, id);
} catch (e) {
  console.error("retry failed, skipping:", e);
  await redis.xack(stream, group, id); // ← ack-and-drop on failure
}
```

We claimed the message from the PEL, it failed again, and we acknowledged it to get it out of the PEL. The data is gone.

**What breaks:** Any message that fails twice is permanently dropped. No record of the failure. No way to inspect or replay it. For an LLM extraction pipeline, this means any event that hits a transient Anthropic error during the retry window loses its decisions forever.

**The fix:** Add a dead-letter stream. Track attempt counts per message in Redis:

```typescript
const DEAD_LETTER_STREAM = "events:dead";
const MAX_ATTEMPTS = 3;

async function processWithRetryTracking(
  id: string,
  fields: string[],
  stream: string,
  group: string,
  redis: Redis
) {
  const attemptsKey = `retry:attempts:${stream}:${id}`;
  const attempts = parseInt(await redis.incr(attemptsKey) as unknown as string);
  await redis.expire(attemptsKey, 86_400); // 24h TTL

  try {
    await processMessage(id, fields);
    await redis.xack(stream, group, id);
    await redis.del(attemptsKey);
  } catch (e) {
    if (attempts >= MAX_ATTEMPTS) {
      // Dead-letter: preserve the message for inspection and replay
      await redis.xadd(DEAD_LETTER_STREAM, "*",
        "original_stream", stream,
        "original_id", id,
        "error", String(e),
        "attempts", String(attempts),
        ...fields
      );
      await redis.xack(stream, group, id);
      await redis.del(attemptsKey);
    }
    // else: leave in PEL for next XAUTOCLAIM cycle
  }
}
```

Now failed messages are inspectable, replayable, and counted — not silently dropped.

---

## Mistake 4: 🏁 No Consumer Group Bootstrap on First Run

**What we did:** Workers called `XREADGROUP` assuming the consumer group already existed.

**What breaks:** On a fresh deployment, the streams and groups don't exist. `XREADGROUP` throws. The worker crashes. Depending on your restart policy, it either loops and crashes again or fails to start entirely. On `restart: always` without backoff, you get a crash loop from the first second of deployment.

**The fix:** Create the group idempotently on startup, using `MKSTREAM` to also create the stream if it doesn't exist:

```typescript
async function ensureConsumerGroup(
  redis: Redis,
  stream: string,
  group: string
): Promise<void> {
  try {
    await redis.xgroup("CREATE", stream, group, "$", "MKSTREAM");
  } catch (e: unknown) {
    // BUSYGROUP means the group already exists — not an error
    if (!(e instanceof Error) || !e.message.includes("BUSYGROUP")) throw e;
  }
}
```

Call this in `run()` before the main loop. Idempotent on every startup. Safe on concurrent worker instances.

---

## Mistake 5: 🔒 TOCTOU Idempotency Race

**What we did:**

```typescript
const alreadyProcessed = await redis.sismember("processed:events", eventId);
if (alreadyProcessed) return;

await redis.xadd("events:raw", "*", "event", JSON.stringify(event));
await redis.sadd("processed:events", eventId);
```

**What breaks:** GitHub re-delivers webhooks when your endpoint responds slowly. Two concurrent deliveries of the same event both call `SISMEMBER` before either calls `SADD`. Both see `false`. Both enqueue. Both write to the brain. You pay for two LLM extraction calls. You get two duplicate Decision nodes in Neo4j. Your drift detection starts returning the same decision multiple times.

**The fix:** Replace the two-call pattern with atomic `SET NX`:

```typescript
const key = `dedup:event:${projectId}:${eventId}`;
const result = await redis.set(key, "1", "EX", 2_592_000, "NX"); // 30 days

if (result !== "OK") {
  // Already processed — idempotent, not an error
  return reply.status(200).send({ ok: true, duplicate: true });
}

// Safe to process — we own the slot
await redis.xadd("events:raw", "*", "event", JSON.stringify(event));
```

`SET NX` (set-if-not-exists) is atomic. Two concurrent calls: exactly one returns `"OK"`, the other returns `null`. No race. The `EX` argument sets a TTL so the set never grows unboundedly.

---

## Mistake 6: 🌐 Single Global Dedup Set Across All Tenants

**What we did:**

```typescript
export const PROCESSED_SET = "processed:event_ids"; // one set for everyone
```

**What breaks:** This is a multi-tenant system. `PROCESSED_SET` is shared across every project and every customer. Two customers who both subscribe to the same public GitHub repo will collide on delivery IDs. The first customer's webhook marks the event as processed. The second customer never sees it. Their brain is permanently missing those events — silently.

More subtly: `EXPIRE` was only called on the GitHub webhook path, which reset the TTL of the entire shared set on every GitHub event. Non-GitHub members of the set (Slack, Jira, meeting transcripts) were evicted at random when GitHub traffic slowed.

**The fix:** Namespace every dedup key by source and project:

```typescript
// Before: shared global set
const key = PROCESSED_SET;
await redis.sadd(key, eventId);

// After: namespaced per source and project, atomic, self-expiring
const key = `dedup:${source}:${projectId}:${externalId}`;
const result = await redis.set(key, "1", "EX", 2_592_000, "NX");
```

No shared set. No TTL resets. No cross-tenant collisions.

---

## Mistake 7: 💀 Crash-Amplifier Restart Policy

**What we did:** Workers were configured with `restart: always` in Docker Compose.

**What breaks:** Combine this with Mistake 3 (ack-and-drop) and the absence of Mistake 4's fix (no group bootstrap). A malformed event reaches the worker. The worker crashes. Docker restarts it immediately. The worker starts, reads the same event from the PEL (if PEL recovery is implemented) or picks up the next event. If the malformed event is what caused the crash, the worker crashes again. Immediately restarted. Loops at full speed.

This is a crash amplifier. One bad event drives continuous restart cycling, consuming CPU, generating log spam, and blocking all subsequent events from the same stream partition.

**The fix:** Two parts. First, implement a dead-letter stream (Mistake 3) so bad events are routed away rather than retried forever. Second, use restart policies with backoff:

```yaml
# docker-compose.yml
services:
  extractor:
    restart: unless-stopped
    deploy:
      restart_policy:
        condition: on-failure
        delay: 5s
        max_attempts: 10
        window: 120s
```

Max 10 restarts per 2-minute window. After that, the container stays down and paging fires. This is the correct behavior: a repeatedly crashing worker is a signal that needs human attention, not an infinite retry loop.

---

## Mistake 8: 🏃 Consumer Ordering Between Parallel Workers on the Same Stream

**What we did:** Both `brain-writer` and `drift-detector` consumed `events:extracted` from separate consumer groups. Both ran in parallel on the same messages.

**What breaks:** Drift detection's Stage A searches Qdrant for existing decisions to compare against. But those decisions are only in Qdrant after `brain-writer` has written them. If `drift-detector` processes an event before `brain-writer` indexes it, the contradiction check runs against a stale Qdrant state. The alert is missed. This is non-deterministic — it depends on which worker wins the race.

**The fix:** Create a new stream that `brain-writer` emits to only after a successful Qdrant write:

```typescript
// In brain-writer, after successful qdrant.upsert():
await xaddCapped(writer, "events:brain_written", {
  event_id: result.event_id,
  project_id: result.project_id,
  source: result.source,
  has_decisions: String(result.decisions.length > 0),
  timestamp: result.timestamp,
});
```

`drift-detector` then consumes `events:brain_written` instead of `events:extracted`. It only runs after the data it needs to compare against is confirmed in Qdrant. The race disappears.

---

## 🔑 The Pattern Behind All Eight Mistakes

Every one of these mistakes comes from the same root cause: **treating Redis Streams like a simple queue when they are a durable log with a specific failure model.**

A simple queue hides failures. Redis Streams exposes them — but only if you've built the infrastructure to surface them. PEL exists precisely because Redis tracks unacknowledged messages, but nothing automatically re-delivers them; you have to implement the XAUTOCLAIM loop. MAXLEN exists because Redis doesn't limit stream growth by default; you have to add the argument. Atomic SET NX exists because SISMEMBER+SADD is not atomic; you have to use the right primitive.

The rule for Redis Streams pipelines: **every edge case (crash mid-message, duplicate delivery, concurrent workers, stalled consumer, deployment with no data) has a specific Redis primitive that handles it correctly. Know which primitive handles which case, and use it.**

---

*This article is part of a series on building production-grade AI pipelines. The mistakes described here were found in a full-codebase review of purpl_brain.*
