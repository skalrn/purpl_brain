---
sidebar_position: 3
---

# ADR-003: Event-Driven Ingestion

**Status:** Accepted | **Date:** 2026-05-15

## The problem

The brain must stay current as source systems change. The anomaly detection requirement adds a hard constraint: proactive alerts must fire within 5 minutes of an event. This eliminates batch polling intervals longer than 5 minutes as the primary ingestion mechanism — polling every 5 minutes is both expensive (rate limits on GitHub, Slack, Jira APIs) and unreliable at scale.

Two strategies were evaluated: scheduled batch polling (pull) and event-driven webhooks (push).

## The decision

**Webhook-first** with polling as a fallback.

All major ingestion sources support webhook delivery. Webhooks deliver events in near real-time (typically < 30 seconds), meeting the 5-minute anomaly detection requirement with significant margin. Each source has its own webhook format and signature verification:

- **GitHub:** HMAC-SHA256 signature on `X-Hub-Signature-256` header
- **Slack:** Signing secret verification on `X-Slack-Signature` header
- **Jira:** JWT verification on the webhook payload

Webhook events are received by the ingestion API and immediately enqueued to `events:raw` in Redis Streams. The API returns 200 immediately without blocking on processing. The processing pipeline consumes asynchronously. This decouples webhook receipt from processing, provides backpressure during spikes, and allows retry on processing failure without re-requesting from the source.

**Polling fallback** runs every 10-15 minutes per source. It only activates when a webhook delivery is confirmed missed via the source's delivery log (GitHub, Slack, and Jira all expose delivery history). Polling is not the primary path and does not run continuously — it is a catch-up mechanism.

**Idempotency:** Every event carries a source-native ID. The processing pipeline checks this ID against a Redis SET before processing. Duplicate deliveries (common with webhooks) are discarded.

## What was rejected

**Batch polling only:** Cannot meet the 5-minute anomaly detection requirement without polling every 5 minutes per source. At scale with multiple repos, this becomes expensive (GitHub REST API rate limit: 5,000 requests/hour per token). Additionally, up to 5-minute lag for all brain updates is poor UX for a system that should feel current.

**Kafka from day one:** The right choice if event volume exceeds what Redis Streams handles (rough threshold: > 10,000 events/day sustained). At POC scale, Kafka adds significant operational overhead (broker management, ZooKeeper or KRaft, topic configuration) without adding capability. Redis Streams provides consumer groups, SIGTERM-safe workers, and dead-letter queue patterns that are sufficient through Phase 3.

The migration path from Redis Streams to Kafka is straightforward: the `StreamWorker` base class abstracts the stream consumer interface, and Kafka has a compatible consumer group model. Migration does not require rewriting worker logic.

**Third-party integration platform (Zapier, Make, Pipedream):** Adds latency (additional network hop), cost (per-event pricing at scale), and a dependency on a third party for the critical ingestion path. Also limits the ability to customize event parsing and entity extraction — the webhook payloads need source-specific transformation that requires code, not no-code.

## The Redis Streams pipeline

Three streams form the ingestion pipeline:

**`events:raw`** — raw webhook payloads. Format: `{ event: JSON.stringify(CanonicalEvent) }`. The normalizer is the consumer.

**`events:normalized`** — canonical `CanonicalEvent` objects. Format: same. The extractor is the consumer.

**`events:extracted`** — `ExtractionResult` objects. Format: `{ result: JSON.stringify(ExtractionResult) }`. Brain writer and drift detector are consumers.

Each stream uses `StreamWorker` with a consumer group per worker type. Consumer groups ensure that each message is processed by exactly one worker instance, enabling horizontal scaling without duplicate processing.

## Operational consequences

The webhook endpoint must be publicly accessible. For local development, ngrok provides a stable URL. For trusted user testing, a cloud VM is required. This is a deployment constraint that exists regardless of polling vs. webhook — GitHub needs a target URL for webhooks.

Webhook signature verification must be implemented per source. A missing or incorrect signature check is a security gap that allows arbitrary event injection. All three sources (GitHub, Slack, Jira) use different signing schemes — they cannot be unified into one verification path.

Dead-letter queueing is required for events that fail repeatedly. Events that exceed the max retry count go to `dlq:events` and are logged for manual inspection. The current max is 3 retries with exponential backoff.
