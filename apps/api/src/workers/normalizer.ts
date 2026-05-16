import "dotenv/config";
import { Redis } from "ioredis";
import { STREAMS } from "../lib/redis.js";
import type { CanonicalEvent } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const writer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const GROUP = "normalizer";
const CONSUMER = "normalizer-1";
const BLOCK_MS = 5000;

async function ensureGroup() {
  try {
    await redis.xgroup("CREATE", STREAMS.RAW, GROUP, "0", "MKSTREAM");
  } catch (e: unknown) {
    // Group already exists — ignore
    if (!(e instanceof Error) || !e.message.includes("BUSYGROUP")) throw e;
  }
}

function decisionCandidate(content: string): boolean {
  const markers = [
    /\bwe (decided|agreed|chose|selected|went with|will use|are using)\b/i,
    /\bdecision\b/i,
    /\badr\b/i,
    /\bapproach\b/i,
    /\binstead of\b/i,
    /\brather than\b/i,
    /\btrade.?off\b/i,
    /\balternative\b/i,
    /\brejected\b/i,
    /\bchosen\b/i,
  ];
  return markers.some((r) => r.test(content));
}

async function processMessage(id: string, event: CanonicalEvent) {
  // Enrich with Pass 1 rule-based signals
  const ticketRefs = [
    ...(event.raw_content.match(/[A-Z]+-\d+/g) ?? []),
    ...(event.raw_content.match(/#\d+/g) ?? []),
  ];

  const personMentions = event.raw_content.match(/@[\w-]+/g) ?? [];

  const normalized = {
    ...event,
    ticket_refs: [...new Set(ticketRefs)],
    person_mentions: [...new Set(personMentions)],
    decision_candidate: decisionCandidate(event.raw_content),
  };

  await writer.xadd(
    STREAMS.NORMALIZED,
    "*",
    "event",
    JSON.stringify(normalized)
  );

  await redis.xack(STREAMS.RAW, GROUP, id);

  console.log(
    `[normalizer] ${event.event_type} ${event.event_id} → normalized (decision_candidate=${normalized.decision_candidate})`
  );
}

async function run() {
  await ensureGroup();
  console.log("[normalizer] started, reading from", STREAMS.RAW);

  while (true) {
    const results = await redis.xreadgroup(
      "GROUP",
      GROUP,
      CONSUMER,
      "COUNT",
      10,
      "BLOCK",
      BLOCK_MS,
      "STREAMS",
      STREAMS.RAW,
      ">"
    );

    if (!results) continue;

    for (const [, messages] of results as [string, [string, string[]][]][]) {
      for (const [id, fields] of messages) {
        const eventJson = fields[fields.indexOf("event") + 1];
        if (!eventJson) continue;
        try {
          const event = JSON.parse(eventJson) as CanonicalEvent;
          await processMessage(id, event);
        } catch (e) {
          console.error(`[normalizer] failed to process ${id}:`, e);
          // Leave in stream for dead-letter inspection — do not ack
        }
      }
    }
  }
}

run().catch((e) => {
  console.error("[normalizer] fatal:", e);
  process.exit(1);
});
