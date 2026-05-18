import { v4 as uuidv4 } from "uuid";
import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { getDecisionsByEventIds, writeDriftAlert } from "../lib/neo4j.js";
import type { EventSource, SignalRequest, SignalResponse } from "@purpl/types";

// Minimum cosine similarity to consider a chunk semantically related to the signal
const SIGNAL_RELEVANCE_THRESHOLD = 0.6;

// Maximum number of Qdrant results to inspect for matching decisions
const SIGNAL_TOP_K = 20;

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

  // 5. Write a DriftAlert for each matched decision
  const now = req.occurred_at ?? new Date().toISOString();
  const truncatedContent = req.text.slice(0, 500);

  await Promise.all(
    decisions.map((d) =>
      writeDriftAlert({
        alert_id: uuidv4(),
        decision_id: d.decision_id,
        event_id: d.event_id,
        source: req.source as EventSource,
        content: truncatedContent,
        actor: req.actor_name,
        timestamp: now,
        confirmed_by_llm: false,
        resolution: "pending",
      })
    )
  );

  return {
    ok: true,
    drift_alerts_created: decisions.length,
    matched_decisions: decisions.length,
    message: `Created ${decisions.length} drift alert(s) for review.`,
  };
}
