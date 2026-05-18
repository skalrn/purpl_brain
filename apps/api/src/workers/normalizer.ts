import "dotenv/config";
import { Redis } from "ioredis";
import { STREAMS } from "../lib/redis.js";
import type { CanonicalEvent } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const writer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const GROUP = "normalizer";
const CONSUMER = "normalizer-1";
const BLOCK_MS = 5000;

let shuttingDown = false;

process.on("SIGTERM", () => {
  console.log("[normalizer] SIGTERM received, finishing current batch then exiting");
  shuttingDown = true;
});
process.on("SIGINT", () => {
  console.log("[normalizer] SIGINT received, finishing current batch then exiting");
  shuttingDown = true;
});

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
    // Explicit choice language
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
    // Closing / deferral language (maintainer decisions in comments)
    /\bin favor of\b/i,
    /\bclosing in favor\b/i,
    /\bclose this for now\b/i,
    /\bpending (?:a )?(?:design )?decision\b/i,
    /\buntil we have\b/i,
    // Rejection / no-action decisions
    /\bno need to\b/i,
    /\bthere'?s no need\b/i,
    /\bI don'?t think (?:we|this|it)\b/i,
    // Policy / design direction statements
    /\bsensible (?:policy|default|approach|choice)\b/i,
    /\bwe'?ll go for\b/i,
    /\bthat'?s what we'?ll\b/i,
    /\bcorrect (?:default|behav[io]+r)\b/i,
    // Warning / UX design decisions
    /\bwarn(?:ing)?\s+when\b/i,
    /\bexplicit(?:ly)?\s+warn\b/i,
    /\bavoid\s+silent\b/i,
    // Version / support decisions
    /\bno longer\s+support\b/i,
    /\bdrop(?:ped|ping)?\s+support\b/i,
    /\btest matrix\b/i,
    // Suggestions that carry design weight (in review comments)
    /\bI (?:would |strongly )?suggest\b/i,
    /\bwould suggest\b/i,
  ];
  return markers.some((r) => r.test(content));
}

// Slack-specific commitment language (broader than GitHub markers)
const SLACK_COMMITMENT_RE = /\b(we(?:'ll| will| should| decided| agreed| chose| are going| are not going)| let'?s go with|going with|decided to|agreed to|will use|not going to|won'?t|no need to|closing|defer|deferred|pending design|we're dropping|we'll drop)\b/i;

function slackDecisionCandidate(text: string): boolean {
  return SLACK_COMMITMENT_RE.test(text) || decisionCandidate(text);
}

async function processMessage(id: string, event: CanonicalEvent) {
  // Enrich with Pass 1 rule-based signals
  const ticketRefs = [
    ...(event.raw_content.match(/[A-Z]+-\d+/g) ?? []),
    ...(event.raw_content.match(/#\d+/g) ?? []),
  ];

  const personMentions = event.raw_content.match(/@[\w-]+/g) ?? [];

  // Source-specific candidate detection
  const isCandidate = event.source === "slack"
    ? slackDecisionCandidate(event.raw_content)
    : decisionCandidate(event.raw_content);

  const normalized = {
    ...event,
    ticket_refs: [...new Set(ticketRefs)],
    person_mentions: [...new Set(personMentions)],
    decision_candidate: isCandidate,
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
    if (shuttingDown) break;
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

  console.log("[normalizer] draining connections...");
  await redis.quit().catch(() => undefined);
  await writer.quit().catch(() => undefined);
  console.log("[normalizer] exit");
  process.exit(0);
}

run().catch((e) => {
  console.error("[normalizer] fatal:", e);
  process.exit(1);
});
