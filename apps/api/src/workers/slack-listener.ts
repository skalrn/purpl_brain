/**
 * Slack listener worker — Socket Mode (no public URL needed).
 * Watches configured channel(s), normalises messages to CanonicalEvent,
 * and publishes to events:raw for the existing pipeline.
 *
 * Required env:
 *   SLACK_BOT_TOKEN   — xoxb-...  (Bot User OAuth Token)
 *   SLACK_APP_TOKEN   — xapp-...  (App-Level Token with connections:write scope)
 *   SLACK_CHANNEL_IDS — comma-separated channel IDs to watch, e.g. C0123,C0456
 *   SLACK_PROJECT_MAP — JSON map of channel_id → project_id, e.g. {"C0123":"encode_httpx"}
 *                       Falls back to SLACK_DEFAULT_PROJECT if channel not in map.
 *   SLACK_DEFAULT_PROJECT — project_id to use when no map entry (default: "default")
 */
import "dotenv/config";
import { App } from "@slack/bolt";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { STREAMS, PROCESSED_SET } from "../lib/redis.js";
import type { CanonicalEvent } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const CHANNEL_IDS = (process.env.SLACK_CHANNEL_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const PROJECT_MAP: Record<string, string> = (() => {
  try { return JSON.parse(process.env.SLACK_PROJECT_MAP ?? "{}"); } catch { return {}; }
})();
const DEFAULT_PROJECT = process.env.SLACK_DEFAULT_PROJECT ?? "default";

function projectForChannel(channelId: string): string {
  return PROJECT_MAP[channelId] ?? DEFAULT_PROJECT;
}

// Commitment language that signals a possible decision
const COMMITMENT_RE = /\b(we(?:'ll| will| should| decided| agreed| chose| are going)| let'?s go with|going with|decided to|agreed to|will use|not going to|won'?t|no need to|closing|deferred?|pending design)\b/i;

function mightBeDecision(text: string): boolean {
  return COMMITMENT_RE.test(text);
}

async function publishToRaw(event: CanonicalEvent): Promise<void> {
  // Dedup by source_id
  const already = await redis.sismember(PROCESSED_SET, event.source_id);
  if (already) return;

  await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
  await redis.sadd(PROCESSED_SET, event.source_id);
  console.log(`[slack-listener] published ${event.event_id} (${event.slack_channel})`);
}

async function run() {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    console.error("[slack-listener] SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required");
    process.exit(1);
  }

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    appToken: process.env.SLACK_APP_TOKEN,
    socketMode: true,
    // Reduce noise in logs
    logger: {
      debug: () => {},
      info: (msg: string) => console.log(`[slack-bolt] ${msg}`),
      warn: (msg: string) => console.warn(`[slack-bolt] ${msg}`),
      error: (msg: string) => console.error(`[slack-bolt] ${msg}`),
      setLevel: () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      getLevel: () => "info" as any,
      setName: () => {},
    },
  });

  app.message(async ({ message, client }) => {
    const msg = message as {
      type: string;
      subtype?: string;
      text?: string;
      user?: string;
      ts: string;
      channel: string;
      thread_ts?: string;
    };

    // Skip bot messages and message edits/deletions
    if (msg.subtype) return;
    if (!msg.text || msg.text.trim().length < 10) return;

    // Filter to configured channels (if any configured)
    if (CHANNEL_IDS.length > 0 && !CHANNEL_IDS.includes(msg.channel)) return;

    // Resolve user display name
    let actorName = msg.user ?? "unknown";
    let actorId = msg.user ?? "unknown";
    try {
      const userInfo = await client.users.info({ user: msg.user ?? "" });
      actorName = userInfo.user?.real_name ?? userInfo.user?.name ?? actorName;
    } catch { /* best-effort */ }

    const sourceId = `slack_${msg.channel}_${msg.ts}`;
    const projectId = projectForChannel(msg.channel);

    const event: CanonicalEvent = {
      event_id: `slack_${uuidv4()}`,
      source: "slack",
      source_id: sourceId,
      project_id: projectId,
      actor: { type: "human", id: actorId, name: actorName },
      timestamp: new Date(parseFloat(msg.ts) * 1000).toISOString(),
      event_type: "slack_message",
      raw_content: msg.text,
      url: `https://slack.com/archives/${msg.channel}/p${msg.ts.replace(".", "")}`,
      slack_channel: msg.channel,
      slack_thread_ts: msg.thread_ts,
    };

    await publishToRaw(event);

    // Log if this message might contain a decision — helps with monitoring
    if (mightBeDecision(msg.text)) {
      console.log(`[slack-listener] possible decision detected in ${msg.channel}: "${msg.text.slice(0, 80)}"`);
    }
  });

  await app.start();
  console.log(`[slack-listener] started in Socket Mode`);
  console.log(`[slack-listener] watching channels: ${CHANNEL_IDS.length > 0 ? CHANNEL_IDS.join(", ") : "all"}`);
}

run().catch((e) => {
  console.error("[slack-listener] fatal:", e);
  process.exit(1);
});
