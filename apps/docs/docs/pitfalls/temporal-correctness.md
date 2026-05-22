---
sidebar_position: 5
---

# Temporal Correctness

## The ingestion timestamp vs. the source timestamp

Every `CanonicalEvent` has a `timestamp` field. The implementation requirement is that this field contains the timestamp from the source system — when the event occurred in GitHub, Slack, or Jira — not when the brain ingested it.

This matters for temporal queries. "What changed last week" means "what events have a source timestamp in the range [now-7d, now]." If the brain uses ingestion timestamps instead of source timestamps, a PR merged last Tuesday that was ingested today appears in today's diff, not last Tuesday's. A user querying "what changed this week" after a bulk historical seeding run would see all the seeded history appear as "this week's changes," regardless of when it actually happened.

The `timestamp` field in `CanonicalEvent` is set from:

- **GitHub:** `pull_request.merged_at` or `pull_request.updated_at` or `issue.updated_at`
- **Slack:** `message.ts` (Slack's Unix timestamp with microsecond precision)
- **Jira:** `issue.updated` or `changelog.created`
- **Meetings:** meeting date from metadata, not upload date
- **Agent logs:** `timestamp_end` from the agent log schema

If none of these are available, the current time is used as a fallback — but this is explicitly a fallback, and the normalizer logs a warning when it happens.

## The seen-set deduplication key

The idempotency check uses `event_id` as the deduplication key, stored in a Redis SET `processed:event_ids` with a 30-day TTL.

For GitHub events, the `event_id` is the GitHub delivery ID (`X-GitHub-Delivery` header). This is unique per webhook delivery. But GitHub re-sends the same event with the same delivery ID when you manually redeliver from the webhook settings. The seen-set correctly deduplicates these.

For GitHub seed events (fetched via the REST API rather than webhooks), the `event_id` is constructed as `github_{owner}_{repo}_{event_type}_{source_id}_{gitSHA}`. The `gitSHA` component is important: it keys the seen-set on content (what version of the file), not just identity (which file). Without `gitSHA`, re-seeding a repo after new commits would not re-ingest updated documents because the file's `source_id` (path) would already be in the seen-set from the prior seed run.

## The QueryLog temporal correlation

The brain logs all `brain_query` calls to a `QueryLog` table in Neo4j with a timestamp. This enables a correlation analysis: for a given time window, how many queries were answered with at least one citation vs. returned empty ("brain does not have sufficient information")?

The `brain_query_results_count` metric — the count of queries in a 30-minute window that returned citations — is the primary indicator that the brain is populated and functioning. If this drops to near-zero and you did not change anything in the extraction or query pipeline, the likely cause is that the ingestion pipeline has stalled (Redis worker crashed, Qdrant is unreachable) or that no new events have been ingested.

The 30-minute window is a reasonable detection window: if ingestion has been stalled for 30 minutes on an active project, `query_results_count` will fall noticeably because new queries are being made about recent events that have not been ingested yet.

## Temporal versioning and point-in-time queries

Decision nodes use a bi-temporal model: `valid_from` and `valid_to` timestamps. The current decision is always the node with `valid_to IS NULL`. Historical decisions have `valid_to` set to the time they were superseded.

A point-in-time query — "what was the decision on auth tokens as of last Tuesday at 3pm" — is expressed in Cypher as:

```cypher
MATCH (d:Decision)
WHERE d.project_id = $project_id
  AND d.valid_from <= $point_in_time
  AND (d.valid_to IS NULL OR d.valid_to > $point_in_time)
RETURN d
```

This query is not currently exposed as a dedicated API endpoint — all temporal queries are through the standard `brain_query` with `mode: "temporal"` and a time range. But the graph model supports it, and a point-in-time query endpoint is a natural addition for the beta UI.

The important constraint: `valid_from` must be set to the source timestamp of the event that created the decision, not the time the decision was written to the graph. Otherwise, a decision from last week that was ingested today would show up as "created today" in a point-in-time query, which breaks the temporal model entirely.
