---
sidebar_position: 2
---

# Ingestion

## Webhook-first

Every ingestion source is webhook-first. When a GitHub PR is merged, GitHub fires a webhook immediately. The brain receives it, validates the HMAC-SHA256 signature, enqueues the raw payload to `events:raw`, and returns 200 within milliseconds. Processing happens asynchronously.

Polling fallback runs every 10-15 minutes per source as a catch-up mechanism for missed deliveries, confirmed via source delivery logs. Polling is not the primary path — it exists because webhooks occasionally miss events, and the 5-minute anomaly detection target requires a catch-up mechanism, not a polling primary.

## Sources

**GitHub** is the most deeply integrated source. Ingested events: PR opened, PR merged, PR closed (no merge), PR review comment submitted, issue created, issue updated, issue comment, push/commit. The GitHub webhook validates HMAC-SHA256 signatures on every event. The normalizer maps event types to the canonical schema:

```typescript
const EVENT_TYPE_MAP = {
  "pull_request.opened": "pr_opened",
  "pull_request.closed": "pr_merged",   // when merged=true
  "pull_request.closed": "pr_closed",   // when merged=false
  "pull_request_review.submitted": "pr_review",
  "issues.opened": "issue_created",
  "issues.edited": "issue_updated",
  "issue_comment.created": "comment",
  "push": "commit",
};
```

**Slack** is ingested via Socket Mode (Bolt SDK). Extraction unit is the full thread — decisions emerge across thread arcs, not in single messages. Reaction metadata (👍 from 2+ people on a message with a decision marker) is used as a confidence modifier. Channel context affects confidence: `#decisions` and `#architecture` channels get +0.2, `#random` gets nothing.

**Jira / Linear** webhooks deliver issue lifecycle events: created, updated, transitioned, commented. Status transitions are mapped to implicit decisions: a "Won't Fix" transition becomes `"decided not to implement {ticket_title}"`. The rationale is usually in the last comment before the transition, so the extractor looks there first.

**Meetings** are ingested via `POST /brain/ingest/transcript` (file upload of `.vtt`, `.srt`, `.txt`). Fireflies webhook integration is also supported. Speaker resolution maps transcript names to existing `Person` nodes by email fuzzy match.

**Documents** are ingested via `POST /brain/ingest/crawl-docs` or the `seed:local-docs` CLI. GitHub repo file crawlers auto-index `docs/**/*.md` on project setup and on push events to the `docs/` path. Supported formats: `.md`, `.pdf`, `.txt`, `.docx`. Document type is tagged from filename patterns: `adr` for `docs/adrs/`, `prd` for `docs/product/`, `architecture` for `docs/technical/`.

**AI Agent logs** are ingested via `POST /brain/agent-log` or the `brain_log_decision` MCP tool. No LLM extraction needed — agent logs use a structured schema with decisions explicitly labeled.

## The canonical event schema

Every ingested event, regardless of source, is normalized to this shape before the extractor sees it:

```typescript
interface CanonicalEvent {
  event_id: string;      // deduplication key
  source: "github" | "slack" | "jira" | "linear" | "meeting" | "agent" | "document";
  source_id: string;     // original ID in source system
  project_id: string;    // brain project namespace
  actor: {
    type: "human" | "agent" | "collective";
    id: string;
    name: string;
  };
  timestamp: string;     // ISO 8601 — when the event occurred in the source, not ingestion time
  event_type: EventType;
  raw_content: string;
  url: string;
}
```

The `timestamp` field is the timestamp from the source system, not the time of ingestion. This matters for temporal queries — "what changed last week" uses event timestamps, not ingestion timestamps. An event ingested today with a source timestamp from last Tuesday shows up in last Tuesday's diff, not today's.

## Idempotency

Every ingestion path checks the `event_id` against a Redis SET `processed:event_ids` before processing. If the ID is already present, the event is discarded. After processing, the ID is added. TTL on the set is 30 days (GitHub's re-delivery window).

This means re-delivering the same webhook event, or running a seed job over already-ingested history, produces no duplicates. The check is per-stream and happens before any database writes.

## Link-following

The most significant enhancement to basic ingestion is link-following. ADRs, PRDs, and design documents frequently reference GitHub PRs where the actual decision discussion happened. Without link-following, ingesting the document captures the conclusion but misses the reasoning.

The extractor scans every ingested document for embedded GitHub PR URLs using this regex:

```typescript
const GITHUB_PR_RE = /https:\/\/github\.com\/([^/\s"')]+)\/([^/\s"')]+)\/pull\/(\d+)/g;
```

For each matched URL (up to `MAX_LINKS_PER_EVENT = 5` per event), the extractor:

1. Validates the owner and repo slugs against `[a-zA-Z0-9_.-]+`
2. Checks an allowlist if `GITHUB_LINK_FOLLOW_ALLOWLIST` is configured (SSRF protection)
3. Checks the `brain:linked_pr_processed` Redis set to skip already-fetched PRs
4. Fetches the PR body and all issue comments from the GitHub API (requires `GITHUB_TOKEN` in container env)
5. Combines body and comment thread, creates a synthetic `CanonicalEvent`, and enqueues it to `events:raw`

The deduplication key for linked PRs is `owner/repo/pull/N`, not the event's GitHub delivery ID (since these are synthetic events). Without this deduplication, re-ingesting a document would re-fetch all its linked PRs on every run.

`GITHUB_TOKEN` must be in the container environment. If it is only in the local `.env` file but not passed to the Docker container, link-following silently skips all PR fetches (the code checks `if (!token) return` without error).
