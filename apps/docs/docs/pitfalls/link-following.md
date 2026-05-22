---
sidebar_position: 4
---

# The Link-Following Bug and Recall Gap

## How the 91% recall gap was discovered

Phase 1 extraction eval showed Recall = 80%, which met the 65% target. But when examining the eval in more detail — specifically, which decisions were missed — a pattern emerged: most misses were decisions that lived in GitHub PR discussions referenced by the evaluated documents, not in the documents themselves.

ADRs and design docs routinely say things like "see PR #234 for the rationale" or include embedded GitHub PR URLs. The actual reasoning — the alternatives evaluated, the constraints surfaced, the reasons for rejection — is in the PR review thread, not in the document. The document just links to it.

Before link-following, the extractor ingested the document text but never fetched the linked PR. The decision in the document was extracted; the decision in the PR was not. On documents that primarily record conclusions with citations to the underlying discussion, the recall gap was 91% — 9 out of 10 decisions lived in linked PRs, not in the document text itself.

## The fix

The extractor now scans every ingested event's `raw_content` for embedded GitHub PR URLs:

```typescript
const GITHUB_PR_RE = /https:\/\/github\.com\/([^/\s"')]+)\/([^/\s"')]+)\/pull\/(\d+)/g;
```

For each matched URL (up to `MAX_LINKS_PER_EVENT = 5` per event):

1. Validate owner/repo slugs against `[a-zA-Z0-9_.-]+` — reject anything that looks like a path traversal or injection
2. Check `GITHUB_LINK_FOLLOW_ALLOWLIST` if configured — SSRF protection for self-hosted instances
3. Check `brain:linked_pr_processed` Redis set — skip already-fetched PRs
4. Fetch the PR body and all issue comments from the GitHub API
5. Create a synthetic `CanonicalEvent` and enqueue to `events:raw`

The deduplication key is `owner/repo/pull/N`, stored in the Redis set after successful fetch. Without this, re-ingesting a document would re-fetch all its linked PRs on every run.

## The production bug found during implementation

During testing of link-following, the drift detector started producing `ParameterMissing` errors from Neo4j. Tracing the error: the drift detector's `stageA` function called `getDecisionsByEventIds` to look up Decision nodes from matching Qdrant results. The Neo4j query returned decision rows, but the `summary` column was not included in the SELECT clause for one code path.

The `summary` field was `undefined` for those candidates. The drift detector passed `undefined` to the embedding call (`embed(text.slice(0, EMBED_MAX_CHARS))`), which passed it to Qdrant, which... actually failed further down when the candidate was used as input to the LLM confirmation call. Neo4j received `undefined` as a parameter for a mandatory field.

The symptom was silent: the drift detector would fail during Stage A candidate processing for those events, log a warning, and continue without generating alerts. Decisions that should have triggered drift detection produced no alerts.

The fix: explicitly guard against `undefined` summaries in Stage A candidates:

```typescript
const candidates = decisions.filter(dec => !!dec.summary && !!dec.quoted_text);
```

And ensure the graph query explicitly selects `summary` in the RETURN clause:

```cypher
MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
WHERE e.event_id IN $event_ids
RETURN d.decision_id AS decision_id, d.summary AS summary, d.quoted_text AS quoted_text, e.event_id AS event_id
```

The broader lesson: `undefined` propagates silently through a TypeScript pipeline of optional fields. An `undefined` value that starts as a missing graph column will not throw until it reaches a system boundary (database, API call) that rejects it. The error appears far from the original source. Explicit guards at each stage prevent silent propagation.

## The GITHUB_TOKEN requirement

Link-following requires `GITHUB_TOKEN` to be set in the container environment. If the token is only in the local `.env` file but Docker is started without passing it through to the container, link-following silently skips all PR fetches:

```typescript
async function fetchLinkedPRs(rawContent, projectId, token) {
  if (!token) return; // skip silently — no auth means 60 req/hr, too risky
  ...
}
```

The silent skip is intentional — unauthenticated GitHub API access is limited to 60 requests/hour, which is not enough for reliable link-following at any meaningful ingestion rate. But the silence means that a misconfigured installation (token in `.env`, not in Docker) appears to work — documents are ingested, events are processed — without link-following actually running.

Symptom of misconfigured GITHUB_TOKEN: extraction recall drops significantly for document sources that reference GitHub PRs. The diagnosis: add a log line at the start of `fetchLinkedPRs` to confirm the token is present, or check that `GITHUB_TOKEN` appears in `docker compose config` output (not just in `.env`).

The Docker Compose configuration must explicitly pass the variable:
```yaml
services:
  api:
    environment:
      GITHUB_TOKEN: ${GITHUB_TOKEN}
```
