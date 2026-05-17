/**
 * Seed synthetic Jira events directly into events:raw for eval/testing.
 * Bypasses the webhook endpoint — useful when no live Jira workspace available.
 *
 * Generates 10 events: 3 with decisions, 2 drift signals, 5 noise.
 *
 * Usage:
 *   tsx src/scripts/seed-jira.ts [--project encode_httpx]
 */
import "dotenv/config";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { STREAMS, PROCESSED_SET } from "../lib/redis.js";
import type { CanonicalEvent } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

interface SyntheticJiraEvent {
  issue_key: string;
  summary: string;
  content: string;
  actor: string;
  event_type: "jira_issue" | "jira_comment";
  is_decision: boolean;
  is_drift: boolean;
  note?: string;
}

const EVENTS: SyntheticJiraEvent[] = [
  // ── Decision-bearing issues ─────────────────────────────────────────────
  {
    issue_key: "HTTPX-101",
    summary: "Authentication flow: sync vs async API",
    content: "After discussion with the team, we have decided to keep the authentication flow synchronous in the public API surface. While the underlying transport is async, exposing sync auth simplifies user code significantly. This is final for 1.0.",
    actor: "tomchristie",
    event_type: "jira_issue",
    is_decision: true,
    is_drift: false,
    note: "auth API design decision",
  },
  {
    issue_key: "HTTPX-102",
    summary: "Retry policy: core client vs middleware",
    content: "Decision: retry logic will NOT be part of the core httpx client. This belongs in a middleware or transport layer. All retry-related PRs will be closed as won't-fix. Users who need retry should use tenacity or equivalent.",
    actor: "tomchristie",
    event_type: "jira_issue",
    is_decision: true,
    is_drift: false,
    note: "retry policy decision",
  },
  {
    issue_key: "HTTPX-103",
    summary: "Transport API stability in 1.0",
    content: "Comment from team lead: we will keep the low-level transport API public but add a stability warning in the docs. Third-party transport authors need a stable surface. Reversing our earlier decision would break too many libraries.",
    actor: "tomchristie",
    event_type: "jira_comment",
    is_decision: true,
    is_drift: false,
    note: "transport API decision",
  },
  // ── Drift signals ────────────────────────────────────────────────────────
  {
    issue_key: "HTTPX-104",
    summary: "Reconsider zstd compression for 1.0",
    content: "I think we should reconsider our position on compression support. The CPython 3.13 stdlib now includes zstd via the compression module. Given that, the argument for gzip-only gets weaker. We should revisit the decision to exclude zstd before we ship 1.0.",
    actor: "adriangb",
    event_type: "jira_issue",
    is_decision: false,
    is_drift: true,
    note: "challenges gzip-only Phase 1 decision",
  },
  {
    issue_key: "HTTPX-105",
    summary: "asyncio.get_event_loop deprecation impact",
    content: "Comment: I'm not convinced the asyncio.get_event_loop() removal was the right call for our test server. I've found three third-party libraries that still use the old pattern and will break. We may need to revisit and provide compatibility shims.",
    actor: "florimondmanca",
    event_type: "jira_comment",
    is_decision: false,
    is_drift: true,
    note: "challenges asyncio Phase 1 decision",
  },
  // ── Noise ────────────────────────────────────────────────────────────────
  {
    issue_key: "HTTPX-106",
    summary: "CI: Add Python 3.13 to test matrix",
    content: "Adding Python 3.13 to our CI test matrix. All existing tests pass. No configuration changes needed.",
    actor: "florimondmanca",
    event_type: "jira_issue",
    is_decision: false,
    is_drift: false,
    note: "routine CI update",
  },
  {
    issue_key: "HTTPX-107",
    summary: "Docs: update installation guide",
    content: "Updated the installation guide to reflect the new minimum Python version. Fixed broken links.",
    actor: "adriangb",
    event_type: "jira_issue",
    is_decision: false,
    is_drift: false,
    note: "routine docs",
  },
  {
    issue_key: "HTTPX-108",
    summary: "Release 0.28.1 patch",
    content: "Releasing 0.28.1 with the certifi bump and one bugfix. Tag pushed.",
    actor: "tomchristie",
    event_type: "jira_issue",
    is_decision: false,
    is_drift: false,
    note: "release note",
  },
  {
    issue_key: "HTTPX-109",
    summary: "Dependabot: bump httpcore to 1.0.5",
    content: "Automated dependency update. httpcore 1.0.5 fixes a minor memory leak. Merging.",
    actor: "dependabot",
    event_type: "jira_issue",
    is_decision: false,
    is_drift: false,
    note: "dep bump noise",
  },
  {
    issue_key: "HTTPX-110",
    summary: "Weekly standup notes",
    content: "Sprint velocity: 8 story points. 2 PRs merged. No blockers. Next sprint planning on Friday.",
    actor: "florimondmanca",
    event_type: "jira_issue",
    is_decision: false,
    is_drift: false,
    note: "standup noise",
  },
];

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";

  console.log(`[seed-jira] seeding ${EVENTS.length} events for project "${projectId}"...`);

  let enqueued = 0;
  let skipped = 0;

  for (const ev of EVENTS) {
    const sourceId = `jira_${ev.issue_key}_${ev.event_type}`;
    const already = await redis.sismember(PROCESSED_SET, sourceId);
    if (already) { skipped++; continue; }

    const event: CanonicalEvent = {
      event_id: `jira_${uuidv4()}`,
      source: "jira",
      source_id: sourceId,
      project_id: projectId,
      actor: { type: "human", id: ev.actor, name: ev.actor },
      timestamp: new Date(Date.now() - Math.random() * 7 * 24 * 3600000).toISOString(),
      event_type: ev.event_type,
      raw_content: `${ev.summary}\n\n${ev.content}`,
      url: `https://jira.example.com/browse/${ev.issue_key}`,
      jira_issue_key: ev.issue_key,
      jira_project_key: ev.issue_key.split("-")[0],
    };

    await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
    await redis.sadd(PROCESSED_SET, sourceId);
    enqueued++;

    const tag = ev.is_drift ? "⚡drift" : ev.is_decision ? "✓decision" : "·noise";
    console.log(`  [${tag}] ${ev.issue_key}: ${ev.summary}`);
  }

  console.log(`\n[seed-jira] done. enqueued=${enqueued} skipped_duplicates=${skipped}`);
  await redis.quit();
}

run().catch((e) => {
  console.error("[seed-jira] fatal:", e);
  process.exit(1);
});
