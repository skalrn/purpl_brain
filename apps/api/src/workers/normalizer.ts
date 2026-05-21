import "dotenv/config";
import { Redis } from "ioredis";
import { STREAMS } from "../lib/redis.js";
import { StreamWorker } from "../lib/stream-worker.js";
import type { CanonicalEvent } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const writer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

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

const SLACK_COMMITMENT_RE = /\b(we(?:'ll| will| should| decided| agreed| chose| are going| are not going)| let'?s go with|going with|decided to|agreed to|will use|not going to|won'?t|no need to|closing|defer|deferred|pending design|we're dropping|we'll drop)\b/i;

function slackDecisionCandidate(text: string): boolean {
  return SLACK_COMMITMENT_RE.test(text) || decisionCandidate(text);
}

class Normalizer extends StreamWorker {
  constructor() {
    super(redis, {
      name: "normalizer",
      stream: STREAMS.RAW,
      group: "normalizer",
      consumer: "normalizer-1",
      fieldName: "event",
    });
  }

  protected async processMessage(id: string, value: string): Promise<void> {
    const event = JSON.parse(value) as CanonicalEvent;

    const ticketRefs = [
      ...(event.raw_content.match(/[A-Z]+-\d+/g) ?? []),
      ...(event.raw_content.match(/#\d+/g) ?? []),
    ];
    const personMentions = event.raw_content.match(/@[\w-]+/g) ?? [];
    // Non-authoritative doc types (demo, pitch, review, unknown) reference other
    // projects or hypothetical scenarios. Marking them as non-candidates prevents
    // the extractor from storing foreign decisions under this project.
    const NON_AUTHORITATIVE_DOC_TYPES = new Set(["demo", "pitch", "review", "unknown"]);
    const isNonAuthoritativeDoc =
      event.source === "document" &&
      event.document_type != null &&
      NON_AUTHORITATIVE_DOC_TYPES.has(event.document_type);

    const isCandidate = isNonAuthoritativeDoc
      ? false
      : event.source === "slack"
        ? slackDecisionCandidate(event.raw_content)
        : decisionCandidate(event.raw_content);

    const normalized = {
      ...event,
      ticket_refs: [...new Set(ticketRefs)],
      person_mentions: [...new Set(personMentions)],
      decision_candidate: isCandidate,
    };

    await writer.xadd(STREAMS.NORMALIZED, "*", "event", JSON.stringify(normalized));
    await redis.xack(STREAMS.RAW, "normalizer", id);

    console.log(
      `[normalizer] ${event.event_type} ${event.event_id} → normalized (decision_candidate=${normalized.decision_candidate})`
    );
  }

  protected override async onShutdown(): Promise<void> {
    await writer.quit().catch(() => undefined);
  }
}

new Normalizer().run().catch((e) => {
  console.error("[normalizer] fatal:", e);
  process.exit(1);
});
