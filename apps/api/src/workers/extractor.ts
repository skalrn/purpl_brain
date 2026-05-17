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

## What counts as a DECISION

Extract any of these — all are real decisions:
- Explicit choices: "we chose X over Y", "going with approach A", "we'll use X"
- Deferred decisions: "closing this until we have a design decision", "let's revisit once X is settled" — the DEFERRAL itself is a decision
- Rejection / no-action decisions: "there's no need to do X", "I don't think we should", "closing: not needed" — deciding NOT to act IS a decision
- Terse technical decisions: "Removed Python 3.10 from the test matrix", "dropped support for X" — version/support changes are decisions even when terse
- Warning / UX design choices: "we should warn when X happens", "avoid silent failures here"
- Policy and default decisions: "this is the correct default behavior", "sensible approach for our use case"
- Maintainer closures with rationale: "closing in favor of X", "closing as won't fix"

## What does NOT count as a DECISION

Return { "decisions": [] } for these — they are maintenance, not decisions:
- Automated dependency bumps (Dependabot/Renovate): "bump X from 1.0 to 1.1" with no design discussion
- Routine CI additions: adding a Python version to an existing matrix with no explanation of why
- Typo fixes, doc formatting, changelog entries, test name changes
- Questions or proposals where no explicit outcome is stated in the text

## Output schema

{ "decisions": [{ "quoted_text": "exact quote", "summary": "one sentence", "rationale": "why or null", "alternatives_considered": [], "confidence": "high|medium|low" }] }

Confidence rules:
- high: explicit decision language + rationale present ("we chose X because Y")
- medium: clear choice but rationale implied or missing ("closing in favor of X")
- low: terse decision with minimal context ("Removed Python 3.10 from test matrix")

NEVER fabricate or infer decisions not directly stated in the text.

## Examples

### Deferral decision — extract it
Text: "I'll close this for now. There's a pending design decision around authentication that needs to settle first."
Output: { "decisions": [{ "quoted_text": "I'll close this for now. There's a pending design decision around authentication that needs to settle first.", "summary": "Decision to defer this change until the authentication design is settled.", "rationale": "Blocked on upstream design decision", "alternatives_considered": [], "confidence": "medium" }] }

### Rejection decision — extract it
Text: "There's no need to enforce this at the library level. Users can configure this themselves if they want to."
Output: { "decisions": [{ "quoted_text": "There's no need to enforce this at the library level.", "summary": "Decision not to enforce this behavior at library level, leaving it to user configuration.", "rationale": "Users can configure it themselves", "alternatives_considered": ["enforce at library level"], "confidence": "high" }] }

### Terse version decision — extract it (low confidence)
Text: "Removed Python 3.10 from the test matrix."
Output: { "decisions": [{ "quoted_text": "Removed Python 3.10 from the test matrix.", "summary": "Decision to drop Python 3.10 from the supported test matrix.", "rationale": null, "alternatives_considered": [], "confidence": "low" }] }

### Automated dependency bump — return empty
Text: "Bump httpcore from 1.0.5 to 1.0.6. Bumps httpcore from 1.0.5 to 1.0.6. Changelog: ..."
Output: { "decisions": [] }

### Routine CI version addition without discussion — return empty
Text: "Add Python 3.13 to the CI matrix."
Output: { "decisions": [] }`;

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
