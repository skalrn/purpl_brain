# ADR-003: Event-Driven Ingestion with Webhook-First Architecture

**Status:** Accepted  
**Date:** 2026-05-15  
**Deciders:** Deepak Kollipalli  

---

## Context

The brain must stay current as source systems change. Two ingestion strategies were considered: scheduled batch polling (pull) and event-driven webhooks (push). The choice directly affects how stale the brain can be and how the system scales.

The anomaly detection requirement adds a constraint: proactive alerts must fire within 5 minutes of an event. This rules out batch polling intervals longer than 5 minutes.

## Decision

**Webhook-first** ingestion with polling as a fallback for sources that do not support webhooks or when webhooks are unavailable (e.g., network issues, source system outage).

All major sources (GitHub, Slack, Jira, Linear) support webhook delivery. Webhooks deliver events in near real-time (< 30 seconds typically), meeting the 5-minute anomaly detection requirement with significant margin.

**Fallback polling:** If a webhook delivery is missed (source system confirmed via delivery log), a polling job runs on a 10-minute interval per source as a catch-up mechanism. Polling is not the primary path.

**Internal event queue:** Webhook events are received by the ingestion API and immediately enqueued in Redis Streams (Phase 1). The processing pipeline consumes from the queue asynchronously. This decouples webhook receipt from processing, provides backpressure, and allows retry on processing failure without re-requesting from the source.

**Idempotency:** Every event carries a source-native ID. The processing pipeline checks this ID before processing — duplicate deliveries (common with webhooks) are discarded.

## Alternatives Considered

**Batch polling only**  
Rejected. Cannot meet 5-minute anomaly detection SLA without polling every 5 minutes per source — expensive and rate-limit-unfriendly at scale. Also introduces up to 5-minute lag for all brain updates.

**Event streaming via Kafka from day one**  
Deferred to post-Phase 3. Kafka is the right choice if event volume scales beyond what Redis Streams handles (rough threshold: > 10k events/day sustained). POC scale does not require it and Kafka adds significant operational overhead.

**Third-party integration platform (Zapier, Make, Pipedream)**  
Rejected. Adds latency, cost, and a dependency on a third party for the critical ingestion path. Also limits the ability to customize event parsing and entity extraction.

## Consequences

- Webhook endpoint must be publicly accessible — requires a stable URL for POC (can use ngrok for local dev, a cloud instance for trusted user testing)
- Webhook verification (signature validation) must be implemented per source — GitHub HMAC-SHA256, Slack signing secret, Jira JWT
- Redis Streams adds an infrastructure dependency; acceptable for POC
- Processing failures result in the event staying in the queue for retry — dead letter queue needed for events that fail repeatedly
