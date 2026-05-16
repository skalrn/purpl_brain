import "dotenv/config";
import { Redis } from "ioredis";
import { STREAMS } from "../lib/redis.js";
import { chat, chatJSON, MODELS } from "../lib/llm.js";
import type { CanonicalEvent, ExtractionResult, Decision, ConfidenceLevel } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const writer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const GROUP = "extractor";
const CONSUMER = "extractor-1";
const BLOCK_MS = 5000;

interface NormalizedEvent extends CanonicalEvent {
  ticket_refs: string[];
  person_mentions: string[];
  decision_candidate: boolean;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a precise decision extractor for software engineering content.
Extract decisions from the provided text. A decision is a deliberate choice made by the team: what was chosen, why, and what alternatives were considered.

Return a JSON object matching this exact schema:
{
  "decisions": [
    {
      "quoted_text": "exact quote from the source text that contains the decision",
      "summary": "one sentence summary of the decision",
      "rationale": "why this choice was made, or null if not stated",
      "alternatives_considered": ["alternative 1", "alternative 2"],
      "confidence": "high" | "medium" | "low"
    }
  ]
}

Confidence rules:
- high: explicit decision language + rationale present ("we chose X because Y")
- medium: clear choice but rationale implied or missing
- low: possible decision but ambiguous language

Return { "decisions": [] } if no decisions are found. Never fabricate decisions not present in the text.`;

async function extractDecisions(event: NormalizedEvent): Promise<Decision[]> {
  const userMessage = `Extract decisions from this GitHub ${event.event_type}:

URL: ${event.url}
Author: ${event.actor.name}

Content:
${event.raw_content}`;

  try {
    const result = await chatJSON<{ decisions: Decision[] }>(
      MODELS.EXTRACTION,
      [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 1024, temperature: 0 }
    );

    return Array.isArray(result.decisions) ? result.decisions : [];
  } catch (e) {
    // Retry once with a simpler prompt on parse failure
    console.warn("[extractor] JSON parse failed, retrying with fallback prompt");
    try {
      const raw = await chat(
        MODELS.EXTRACTION,
        [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        { maxTokens: 1024, temperature: 0 }
      );
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const result = JSON.parse(cleaned) as { decisions: Decision[] };
      return Array.isArray(result.decisions) ? result.decisions : [];
    } catch {
      console.error("[extractor] extraction failed after retry, skipping LLM pass");
      return [];
    }
  }
}

async function processMessage(id: string, event: NormalizedEvent) {
  let decisions: Decision[] = [];

  if (event.decision_candidate) {
    decisions = await extractDecisions(event);
    console.log(`[extractor] LLM extracted ${decisions.length} decision(s) from ${event.event_id}`);
  }

  const result: ExtractionResult = {
    event_id: event.event_id,
    project_id: event.project_id,
    source_url: event.url,
    actor: event.actor,
    timestamp: event.timestamp,
    decisions,
    ticket_refs: event.ticket_refs,
    person_mentions: event.person_mentions,
    concept_tags: [],
    decision_candidate: event.decision_candidate,
  };

  await writer.xadd(STREAMS.EXTRACTED, "*", "result", JSON.stringify(result));
  await redis.xack(STREAMS.NORMALIZED, GROUP, id);

  console.log(
    `[extractor] ${event.event_type} ${event.event_id} → extracted (decisions=${decisions.length}, candidate=${event.decision_candidate})`
  );
}

async function ensureGroup() {
  try {
    await redis.xgroup("CREATE", STREAMS.NORMALIZED, GROUP, "0", "MKSTREAM");
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes("BUSYGROUP")) throw e;
  }
}

async function run() {
  await ensureGroup();
  console.log("[extractor] started, reading from", STREAMS.NORMALIZED);

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
      STREAMS.NORMALIZED,
      ">"
    );

    if (!results) continue;

    for (const [, messages] of results as [string, [string, string[]][]][]) {
      for (const [id, fields] of messages) {
        const eventJson = fields[fields.indexOf("event") + 1];
        if (!eventJson) continue;
        try {
          const event = JSON.parse(eventJson) as NormalizedEvent;
          await processMessage(id, event);
        } catch (e) {
          console.error(`[extractor] failed to process ${id}:`, e);
        }
      }
    }
  }
}

run().catch((e) => {
  console.error("[extractor] fatal:", e);
  process.exit(1);
});
