import { v4 as uuidv4 } from "uuid";
import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { getDecisionsByEventIds, writeDriftAlert } from "../lib/neo4j.js";
import { chatJSON, MODELS } from "../lib/llm.js";
import type { EventSource, SignalRequest, SignalResponse } from "@purpl/types";

const SIGNAL_RELEVANCE_THRESHOLD = parseFloat(process.env.SIGNAL_RELEVANCE_THRESHOLD ?? "0.6");
const SIGNAL_TOP_K = 20;

// Reuse the same prompt and model as drift-detector for consistency
const DRIFT_SYSTEM_PROMPT = `You are a decision drift detector for software engineering teams.

Given a new message/event and a list of existing project decisions, classify each related decision as one of:
- "conflicts": the message contradicts or challenges the decision — suggests doing something different, reopens a closed question, or expresses doubt about a settled choice. This includes replacing a previously-chosen technology with a different one, even if the stated rationale sounds similar.
- "confirms": the message is consistent with or reinforces the decision — implements it, references it positively, or provides evidence it was the right call. A message that proposes switching away from the chosen option is NOT a confirmation.
- neither: the message is unrelated or is a routine update with no bearing on the decision

Respond with JSON only:
{
  "drifts": [{ "decision_id": "...", "reason": "one sentence — state what conflicts with what" }],
  "confirms": [{ "decision_id": "...", "reason": "one sentence — state what the message confirms about the decision" }]
}

Return { "drifts": [], "confirms": [] } if no related decisions found.`;

interface LLMConfirmation {
  drifts: Array<{ decision_id: string; reason: string }>;
  confirms: Array<{ decision_id: string; reason: string }>;
}

async function confirmWithLLM(
  signalText: string,
  decisions: Array<{ decision_id: string; summary: string; quoted_text: string }>
): Promise<LLMConfirmation> {
  const decisionsBlock = decisions
    .map((d) => `Decision ID: ${d.decision_id}\nSummary: ${d.summary}\nOriginal text: "${d.quoted_text}"`)
    .join("\n\n");

  return chatJSON<LLMConfirmation>(
    MODELS.EXTRACTION,
    [
      { role: "system", content: DRIFT_SYSTEM_PROMPT },
      {
        role: "user",
        content: `New message:\n"${signalText.slice(0, 1000)}"\n\nExisting decisions to check against:\n${decisionsBlock}\n\nDoes this message contradict any of these decisions?`,
      },
    ],
    { maxTokens: 512, temperature: 0 }
  );
}

/**
 * Ingest an observation signal and match it against existing confirmed decisions.
 * For each high-confidence match, writes a pending DriftAlert so human reviewers
 * (or the next agent session) can resolve the contradiction.
 *
 * The signal itself is NOT stored as a canonical event — it is ephemeral input
 * that triggers drift detection. If it represents a real decision the caller
 * should use /brain/agent-log or the meeting transcript route instead.
 */
export async function processSignal(req: SignalRequest): Promise<SignalResponse> {
  // 1. Embed the signal text
  const signalVector = await embed(req.text);

  // 2. Qdrant search — find chunks from confirmed-decision events
  const results = await qdrant.search(COLLECTION, {
    vector: signalVector,
    limit: SIGNAL_TOP_K,
    filter: {
      must: [
        { key: "project_id", match: { value: req.project_id } },
        { key: "has_decisions", match: { value: true } },
      ],
    },
    with_payload: true,
  }) as Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;

  // 3. Filter by relevance threshold and extract unique event_ids
  const relevantEventIds = [
    ...new Set(
      results
        .filter((r) => r.score >= SIGNAL_RELEVANCE_THRESHOLD && r.payload?.graph_node_id)
        .map((r) => String(r.payload!.graph_node_id))
    ),
  ];

  if (relevantEventIds.length === 0) {
    return {
      ok: true,
      drift_alerts_created: 0,
      matched_decisions: 0,
      message: "No existing decisions matched this signal above the relevance threshold.",
    };
  }

  // 4. Fetch confirmed decisions from matched events
  const decisions = await getDecisionsByEventIds(relevantEventIds);

  if (decisions.length === 0) {
    return {
      ok: true,
      drift_alerts_created: 0,
      matched_decisions: 0,
      message: "Matched events found but no confirmed decisions to create alerts for.",
    };
  }

  // 5. LLM confirmation — only write alerts for genuine conflicts
  let confirmation: LLMConfirmation;
  try {
    confirmation = await confirmWithLLM(req.text, decisions);
  } catch (e) {
    console.error("[signal-engine] LLM confirmation failed:", e);
    return {
      ok: false,
      drift_alerts_created: 0,
      matched_decisions: decisions.length,
      message: "LLM confirmation failed — no alerts written. Retry or use /brain/agent-log for high-confidence signals.",
    };
  }

  const confirmedConflicts = confirmation.drifts ?? [];
  if (confirmedConflicts.length === 0) {
    return {
      ok: true,
      drift_alerts_created: 0,
      matched_decisions: decisions.length,
      message: `${decisions.length} decision(s) matched but LLM found no genuine conflicts.`,
    };
  }

  // 6. Write one DriftAlert per confirmed conflict
  const now = req.occurred_at ?? new Date().toISOString();
  const truncatedContent = req.text.slice(0, 500);
  const decisionById = new Map(decisions.map((d) => [d.decision_id, d]));

  await Promise.all(
    confirmedConflicts
      .filter((c) => decisionById.has(c.decision_id))
      .map((c) => {
        const d = decisionById.get(c.decision_id)!;
        return writeDriftAlert({
          alert_id: uuidv4(),
          decision_id: d.decision_id,
          event_id: d.event_id,
          source: req.source as EventSource,
          content: truncatedContent,
          reason: c.reason,
          actor: req.actor_name,
          timestamp: now,
          confirmed_by_llm: true,
          resolution: "pending",
        });
      })
  );

  return {
    ok: true,
    drift_alerts_created: confirmedConflicts.length,
    matched_decisions: decisions.length,
    message: `Created ${confirmedConflicts.length} drift alert(s) from ${decisions.length} matched decision(s).`,
  };
}
