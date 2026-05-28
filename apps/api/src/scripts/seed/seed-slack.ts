/**
 * Seed synthetic Slack messages into events:raw for eval/testing.
 *
 * Generates 20 messages: 10 with real decisions, 10 noise.
 * Covers drift scenarios (messages that contradict Phase 1 decisions)
 * and fresh decisions (new choices made in Slack).
 *
 * Usage:
 *   tsx src/scripts/seed-slack.ts [--project encode_httpx] [--drift-only]
 */
import "dotenv/config";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { STREAMS, PROCESSED_SET } from "../../lib/redis.js";
import type { CanonicalEvent } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

interface SyntheticMessage {
  text: string;
  actor_name: string;
  is_decision: boolean;
  is_drift: boolean; // contradicts a known Phase 1 decision
  drift_target?: string; // which decision it challenges
  note?: string;
}

const MESSAGES: SyntheticMessage[] = [
  // ── Decisions (fresh, not contradicting existing) ──────────────────────────
  {
    text: "We agreed in today's call: we'll use pytest-asyncio in strict mode going forward. No more implicit async markers.",
    actor_name: "tomchristie",
    is_decision: true,
    is_drift: false,
    note: "testing framework decision",
  },
  {
    text: "Decided to drop Python 3.11 from CI next release cycle — we need to keep the matrix manageable. 3.12 and 3.13 are the priority.",
    actor_name: "florimondmanca",
    is_decision: true,
    is_drift: false,
    note: "Python version support decision",
  },
  {
    text: "We're going with semver for httpx 1.x. No more CalVer proposals — let's close that discussion.",
    actor_name: "tomchristie",
    is_decision: true,
    is_drift: false,
    note: "versioning decision",
  },
  {
    text: "Let's go with a read-only interface for the transport layer — no need to expose write methods in the public API.",
    actor_name: "adriangb",
    is_decision: true,
    is_drift: false,
    note: "API design decision",
  },
  {
    text: "Agreed: we won't add retry logic to the core client. That belongs in a middleware layer. Closing all retry PRs as won't-fix.",
    actor_name: "tomchristie",
    is_decision: true,
    is_drift: false,
    note: "retry policy decision",
  },
  {
    text: "No need to add a timeout to WebSocket connections by default — it breaks too many use cases. We'll document it instead.",
    actor_name: "florimondmanca",
    is_decision: true,
    is_drift: false,
    note: "WebSocket timeout decision",
  },
  {
    text: "We decided the auth flow should be synchronous in the public API, even if the underlying transport is async. Simplifies user code.",
    actor_name: "adriangb",
    is_decision: true,
    is_drift: false,
    note: "auth API design decision",
  },
  {
    text: "Going forward, all deprecations need a minimum one-major-version warning period. We agreed on this in the last core team call.",
    actor_name: "tomchristie",
    is_decision: true,
    is_drift: false,
    note: "deprecation policy decision",
  },
  // ── Drift messages (contradict known Phase 1 decisions) ───────────────────
  {
    text: "Actually I think we should reconsider the gzip-only compression policy. zstd is now stable in CPython 3.13 via the compression module. We should add it before 1.0.",
    actor_name: "adriangb",
    is_decision: false,
    is_drift: true,
    drift_target: "gzip-only compression policy",
    note: "challenges Phase 1 decision: gzip only for 1.0",
  },
  {
    text: "Wait, I'm not sure the asyncio.get_event_loop() removal was the right call. There are several third-party libraries that depend on the old behaviour. We may need to revisit.",
    actor_name: "florimondmanca",
    is_decision: false,
    is_drift: true,
    drift_target: "asyncio.get_event_loop() replacement",
    note: "challenges Phase 1 decision: explicit event loop",
  },
  // ── Noise (no decision content) ───────────────────────────────────────────
  {
    text: "Just pushed the fix for the test flake on Python 3.12. Should be green now.",
    actor_name: "tomchristie",
    is_decision: false,
    is_drift: false,
    note: "routine CI message",
  },
  {
    text: "Thanks for the review! Will address the nits tomorrow morning.",
    actor_name: "adriangb",
    is_decision: false,
    is_drift: false,
    note: "routine acknowledgement",
  },
  {
    text: "The release branch is cut. Anyone with pending PRs should target the next minor.",
    actor_name: "tomchristie",
    is_decision: false,
    is_drift: false,
    note: "release admin, no design decision",
  },
  {
    text: "Reminder: standup in 15 minutes",
    actor_name: "florimondmanca",
    is_decision: false,
    is_drift: false,
    note: "noise",
  },
  {
    text: "Just rebased #3812 on main, conflicts were minor.",
    actor_name: "adriangb",
    is_decision: false,
    is_drift: false,
    note: "routine PR update",
  },
  {
    text: "Docs build is failing on the latest Sphinx version. Looking into it.",
    actor_name: "tomchristie",
    is_decision: false,
    is_drift: false,
    note: "bug report, no decision",
  },
  {
    text: "Weekly: 4 PRs merged, 2 open issues triaged. Nothing blocking.",
    actor_name: "florimondmanca",
    is_decision: false,
    is_drift: false,
    note: "standup noise",
  },
  {
    text: "Can someone take a look at #3819? It's been open for 2 weeks.",
    actor_name: "adriangb",
    is_decision: false,
    is_drift: false,
    note: "request for review, no decision",
  },
  {
    text: "Dependabot bumped certifi. Merging now — routine.",
    actor_name: "tomchristie",
    is_decision: false,
    is_drift: false,
    note: "dep bump, no decision",
  },
  // ── Extra decisions to round out eval dataset ─────────────────────────────
  {
    text: "Agreed with @florimondmanca: no streaming response by default in the sync client. Users who need it should use the async client.",
    actor_name: "tomchristie",
    is_decision: true,
    is_drift: false,
    note: "streaming API decision",
  },
];

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";
  const driftOnly = args.includes("--drift-only");

  const toSeed = driftOnly ? MESSAGES.filter((m) => m.is_drift) : MESSAGES;

  console.log(`[seed-slack] seeding ${toSeed.length} messages for project "${projectId}"...`);

  let enqueued = 0;
  let skipped = 0;
  const baseTs = Date.now() / 1000 - 7 * 24 * 3600; // spread over last week

  for (let i = 0; i < toSeed.length; i++) {
    const msg = toSeed[i];
    const ts = (baseTs + i * 3600).toFixed(6); // 1 hour apart
    const sourceId = `slack_C_SEED_${i}_${ts}`;

    const already = await redis.sismember(PROCESSED_SET, sourceId);
    if (already) { skipped++; continue; }

    const event: CanonicalEvent = {
      event_id: `slack_${uuidv4()}`,
      source: "slack",
      source_id: sourceId,
      project_id: projectId,
      actor: { type: "human", id: msg.actor_name, name: msg.actor_name },
      timestamp: new Date(parseFloat(ts) * 1000).toISOString(),
      event_type: "slack_message",
      raw_content: msg.text,
      url: `https://slack.com/archives/C_SEED/p${ts.replace(".", "")}`,
      slack_channel: "C_SEED",
    };

    await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
    await redis.sadd(PROCESSED_SET, sourceId);
    enqueued++;

    const tag = msg.is_drift ? "⚡drift" : msg.is_decision ? "✓decision" : "·noise";
    console.log(`  [${tag}] ${msg.text.slice(0, 70)}`);
  }

  console.log(`\n[seed-slack] done. enqueued=${enqueued} skipped_duplicates=${skipped}`);
  await redis.quit();
}

run().catch((e) => {
  console.error("[seed-slack] fatal:", e);
  process.exit(1);
});
