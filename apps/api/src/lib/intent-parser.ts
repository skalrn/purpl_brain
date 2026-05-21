/**
 * Server-side query intent parser.
 *
 * Replaces the brittle client-side regex in apps/web/app/components/Chat.tsx.
 * Classifies a natural-language query into:
 *   - mode: "project" | "temporal" | "impact"
 *   - time_range (optional, for temporal mode)
 *
 * Uses the cheap extraction model (Haiku in prod, gemma3:4b locally) with a
 * tight JSON-only prompt. Falls back to "project" mode on any failure so the
 * API is never blocked by the classifier.
 */
import { chatJSON, MODELS } from "./llm.js";
import type { QueryMode } from "@purpl/types";

export interface ParsedIntent {
  mode: QueryMode;
  time_range?: { from: string; to: string };
}

interface LLMIntent {
  mode: "project" | "temporal" | "impact";
  time_window_days?: number | null;
  // Optional explicit absolute range from the model — ISO strings.
  time_range_from?: string | null;
  time_range_to?: string | null;
}

const INTENT_SYSTEM_PROMPT = `You are a query-intent classifier for a software engineering knowledge brain.

Classify the user's query into exactly one of three modes:

- "temporal" — the question is bounded in time. Examples: "what changed last week", "decisions from the past 5 days", "what happened yesterday", "this sprint", "since the auth migration".
- "impact" — the user is describing a proposed change and asking what it might affect / break / risk. Examples: "what would break if we switched from Redis to Memcached", "impact of dropping Python 3.10", "risks of moving auth to JWT".
- "project" — everything else (default). General "what / why / how" questions about the codebase, decisions, or team. Examples: "what database are we using", "why did we choose Kafka", "who is working on auth".

If the query is temporal, also extract a time window in days from today. Examples:
- "last 5 days" → 5
- "last week" / "past week" → 7
- "this week" → 7 (approximate)
- "yesterday" → 1
- "last month" → 30
- "what changed recently" with no explicit window → 7

Respond with JSON only, no commentary:
{
  "mode": "project" | "temporal" | "impact",
  "time_window_days": <integer or null>
}

When uncertain, prefer "project". A misclassified temporal question still works because temporal degrades to project semantics.`;

const DEFAULT_TEMPORAL_DAYS = 7;
const MAX_TEMPORAL_DAYS = 365;

/**
 * Parse the intent of a natural-language query. Always returns a valid
 * ParsedIntent — on any error, falls back to mode="project".
 */
export async function parseQueryIntent(query: string): Promise<ParsedIntent> {
  if (!query || query.trim().length === 0) {
    return { mode: "project" };
  }

  try {
    const result = await chatJSON<LLMIntent>(
      MODELS.EXTRACTION,
      [
        { role: "system", content: INTENT_SYSTEM_PROMPT },
        { role: "user", content: `Classify this query:\n<query>${query.trim()}</query>` },
      ],
      { maxTokens: 128, temperature: 0 }
    );

    if (result.mode === "impact") {
      return { mode: "impact" };
    }

    if (result.mode === "temporal") {
      const to = new Date();
      const days = Math.min(
        MAX_TEMPORAL_DAYS,
        Math.max(1, result.time_window_days ?? DEFAULT_TEMPORAL_DAYS)
      );
      const from = new Date(to.getTime() - days * 86400000);
      return {
        mode: "temporal",
        time_range: { from: from.toISOString(), to: to.toISOString() },
      };
    }

    return { mode: "project" };
  } catch {
    // Failsafe: never block the API on intent parsing.
    return { mode: "project" };
  }
}
