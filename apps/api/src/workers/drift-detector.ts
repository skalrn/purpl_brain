/**
 * Drift detector worker — M2
 *
 * Consumes events:extracted, runs two-stage drift detection against
 * existing confirmed decisions, writes DriftAlert nodes to Neo4j,
 * and publishes confirmed alerts to events:drift.
 *
 * Stage A: cosine similarity via Qdrant (threshold: DRIFT_SEMANTIC_THRESHOLD)
 * Stage C: LLM confirmation on candidates
 *
 * Only processes events from non-GitHub sources (Slack, Jira, meetings)
 * plus GitHub PRs/issues that are new events after initial seeding.
 * Skips events that generated the decisions themselves (avoids self-drift).
 */
import "dotenv/config";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { STREAMS } from "../lib/redis.js";
import { StreamWorker } from "../lib/stream-worker.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { embed } from "../lib/embed.js";
import { chatJSON, MODELS } from "../lib/llm.js";
import { driver, writeDriftAlert, getDecisionsByEventIds } from "../lib/neo4j.js";
import { inferSourceFromEventId } from "../lib/event-source.js";
import type { ExtractionResult, DriftAlert } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const writer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const SEMANTIC_THRESHOLD = parseFloat(process.env.DRIFT_SEMANTIC_THRESHOLD ?? "0.55");
const TOP_K = parseInt(process.env.DRIFT_TOP_K ?? "3");
const EMBED_MAX_CHARS = 1200;
const DRIFT_WEBHOOK_URL = process.env.DRIFT_WEBHOOK_URL;

async function pushDriftNotification(payload: {
  alert_id: string;
  project_id: string;
  challenged_decision_id: string;
  challenged_decision_summary: string;
  challenging_content: string;
  reason: string;
  actor: string;
  timestamp: string;
}): Promise<void> {
  if (!DRIFT_WEBHOOK_URL) return;
  try {
    await fetch(DRIFT_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, risk: "high" }),
    });
  } catch (e) {
    console.error("[drift-detector] webhook push failed:", e);
  }
}

// ── Stage A: semantic similarity via Qdrant ───────────────────────────────

interface CandidateDecision {
  decision_id: string;
  summary: string;
  quoted_text: string;
  score: number;
}

async function stageA(
  text: string,
  projectId: string,
  excludeEventIds: string[]
): Promise<CandidateDecision[]> {
  const vector = await embed(text.slice(0, EMBED_MAX_CHARS));

  const results = await qdrant.search(COLLECTION, {
    vector,
    limit: TOP_K * 4, // over-fetch: we'll filter by has_decisions and exclude list
    filter: {
      must: [
        { key: "project_id", match: { value: projectId } },
        { key: "has_decisions", match: { value: true } },
      ],
    },
    with_payload: true,
    score_threshold: SEMANTIC_THRESHOLD,
  });

  console.log(`[drift-detector] stage-A raw hits: ${results.map(r => `${r.payload?.graph_node_id}(${r.score.toFixed(2)})`).join(", ") || "none"}`);

  // Collect event_ids from the matching chunks, excluding the event being processed
  const matchingEventIds = [
    ...new Set(
      results
        .map((r) => r.payload?.graph_node_id as string | undefined)
        .filter((id): id is string => !!id && !excludeEventIds.includes(id))
    ),
  ].slice(0, TOP_K * 2);

  if (matchingEventIds.length === 0) return [];

  console.log(`[drift-detector] stage-A candidates: event_ids=${matchingEventIds.join(",")} excluded=${excludeEventIds.join(",")}`);

  // Look up which confirmed Decision nodes were extracted from those events
  const decisions = await getDecisionsByEventIds(matchingEventIds);

  // Map back to candidates, preserving the best Qdrant score per decision
  const scoreByEventId = new Map<string, number>();
  for (const r of results) {
    const id = r.payload?.graph_node_id as string | undefined;
    if (id && !scoreByEventId.has(id)) scoreByEventId.set(id, r.score);
  }

  const seen = new Set<string>();
  const candidates: CandidateDecision[] = [];
  for (const dec of decisions) {
    if (seen.has(dec.decision_id)) continue;
    seen.add(dec.decision_id);
    candidates.push({
      decision_id: dec.decision_id,
      summary: dec.summary,
      quoted_text: dec.quoted_text,
      score: scoreByEventId.get(dec.event_id) ?? SEMANTIC_THRESHOLD,
    });
    if (candidates.length >= TOP_K) break;
  }

  return candidates;
}

// ── Stage C: LLM confirmation ──────────────────────────────────────────────

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

Example conflict reason: "Removes obfuscation step, contradicting the decision to ship obfuscated builds for IP protection."
Example conflict reason: "Proposes migrating to Weaviate, directly contradicting the decision to adopt Qdrant as the vector store — the tool choice conflicts even if the rationale sounds similar."
Example confirmation reason: "Implements the 3-pane layout as AppShell, consistent with the decision to adopt this layout pattern."

Return { "drifts": [], "confirms": [] } if no related decisions found.`;

interface DriftConfirmation {
  drifts: Array<{ decision_id: string; reason: string }>;
  confirms: Array<{ decision_id: string; reason: string }>;
}

async function stageC(
  eventText: string,
  candidates: CandidateDecision[]
): Promise<DriftConfirmation> {
  const decisionsBlock = candidates
    .map((c) => `Decision ID: ${c.decision_id}\nSummary: ${c.summary}\nOriginal text: "${c.quoted_text}"`)
    .join("\n\n");

  const userMessage = `New message:
"${eventText.slice(0, 1000)}"

Existing decisions to check against:
${decisionsBlock}

Does this message contradict any of these decisions?`;

  console.log(`[drift-detector] stage-C input: candidates=${candidates.map(c => `${c.decision_id}(${c.score.toFixed(2)}): "${c.summary.slice(0,80)}"`).join(" | ")}`);
  return chatJSON<DriftConfirmation>(
    MODELS.EXTRACTION, // Use fast model for confirmation — cheaper
    [
      { role: "system", content: DRIFT_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 512, temperature: 0 }
  );
}

// ── Worker class ──────────────────────────────────────────────────────────

class DriftDetector extends StreamWorker {
  constructor() {
    super(redis, {
      name: "drift-detector",
      stream: STREAMS.EXTRACTED,
      group: "drift-detector",
      consumer: "drift-detector-1",
      fieldName: "result",
    });
  }

  protected async processMessage(id: string, value: string): Promise<void> {
    const result = JSON.parse(value) as ExtractionResult;

    if (!result.raw_content || result.raw_content.trim().length < 20) {
      await redis.xack(STREAMS.EXTRACTED, "drift-detector", id);
      return;
    }

    // Run drift detection on Slack, meeting, Jira, and agent events.
    // Skip GitHub — intra-PR debate is expected, not drift.
    // Skip document — docs define the baseline; bulk ingest causes non-deterministic
    // race conditions where doc chunks drift-check against each other mid-ingest.
    const source = inferSourceFromEventId(result.event_id);
    console.log(`[drift-detector] processing event=${result.event_id} source=${source} project=${result.project_id}`);
    if (source === "github" || source === "document") {
      await redis.xack(STREAMS.EXTRACTED, "drift-detector", id);
      return;
    }

    // Stage A: find semantically similar confirmed decisions
    const candidates = await stageA(
      result.raw_content,
      result.project_id,
      [result.event_id]
    );

    if (candidates.length === 0) {
      await redis.xack(STREAMS.EXTRACTED, "drift-detector", id);
      return;
    }

    // Stage C: LLM confirmation
    let confirmation: DriftConfirmation;
    try {
      confirmation = await stageC(result.raw_content, candidates);
    } catch (e) {
      console.error(`[drift-detector] LLM confirmation failed for ${result.event_id}:`, e);
      await redis.xack(STREAMS.EXTRACTED, "drift-detector", id);
      return;
    }

    const drifts = confirmation.drifts ?? [];
    const confirms = confirmation.confirms ?? [];

    if (drifts.length === 0 && confirms.length === 0) {
      await redis.xack(STREAMS.EXTRACTED, "drift-detector", id);
      return;
    }

    // Write conflict alerts
    for (const drift of drifts) {
      const alert: DriftAlert = {
        alert_id: uuidv4(),
        decision_id: drift.decision_id,
        event_id: result.event_id,
        source,
        content: result.raw_content.slice(0, 500),
        reason: drift.reason,
        actor: result.actor.name,
        timestamp: result.timestamp,
        confirmed_by_llm: true,
        resolution: "pending",
      };
      try {
        await writeDriftAlert(alert);
        await writer.xadd(STREAMS.DRIFT, "*", "alert", JSON.stringify(alert));
        console.log(`[drift-detector] ⚡ CONFLICT: event=${result.event_id} challenges decision=${drift.decision_id}: ${drift.reason}`);
        const decisionSummary = candidates.find((c) => c.decision_id === drift.decision_id)?.summary ?? drift.decision_id;
        pushDriftNotification({
          alert_id: alert.alert_id,
          project_id: result.project_id,
          challenged_decision_id: drift.decision_id,
          challenged_decision_summary: decisionSummary,
          challenging_content: result.raw_content.slice(0, 300),
          reason: drift.reason,
          actor: result.actor.name,
          timestamp: result.timestamp,
        });
      } catch (e) {
        console.error(`[drift-detector] failed to write conflict for ${result.event_id}:`, e);
      }
    }

    // Write confirmation alerts — stored as resolution "confirms" so UI can distinguish
    for (const confirm of confirms) {
      const alert: DriftAlert = {
        alert_id: uuidv4(),
        decision_id: confirm.decision_id,
        event_id: result.event_id,
        source,
        content: result.raw_content.slice(0, 500),
        reason: confirm.reason,
        actor: result.actor.name,
        timestamp: result.timestamp,
        confirmed_by_llm: true,
        resolution: "confirms",
      };
      try {
        await writeDriftAlert(alert);
        console.log(`[drift-detector] ✓ CONFIRMS: event=${result.event_id} confirms decision=${confirm.decision_id}: ${confirm.reason}`);
      } catch (e) {
        console.error(`[drift-detector] failed to write confirmation for ${result.event_id}:`, e);
      }
    }

    await redis.xack(STREAMS.EXTRACTED, "drift-detector", id);
  }

  protected override async onShutdown(): Promise<void> {
    await writer.quit().catch(() => undefined);
    await driver.close().catch(() => undefined);
  }

  override async run(): Promise<void> {
    console.log(`[drift-detector] semantic threshold: ${SEMANTIC_THRESHOLD}, top-k: ${TOP_K}`);
    await super.run();
  }
}

new DriftDetector().run().catch((e) => {
  console.error("[drift-detector] fatal:", e);
  process.exit(1);
});
