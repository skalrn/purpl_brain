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
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { embed } from "../lib/embed.js";
import { chat, chatJSON, MODELS } from "../lib/llm.js";
import { writeDriftAlert, getDecisionsByEventIds } from "../lib/neo4j.js";
import type { ExtractionResult, DriftAlert, EventSource } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const writer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const GROUP = "drift-detector";
const CONSUMER = "drift-detector-1";
const BLOCK_MS = 5000;

const SEMANTIC_THRESHOLD = parseFloat(process.env.DRIFT_SEMANTIC_THRESHOLD ?? "0.55");
const TOP_K = parseInt(process.env.DRIFT_TOP_K ?? "3");
const EMBED_MAX_CHARS = 1200; // keep well within nomic-embed-text context window

async function ensureGroup() {
  try {
    await redis.xgroup("CREATE", STREAMS.EXTRACTED, GROUP, "$", "MKSTREAM");
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes("BUSYGROUP")) throw e;
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

  // Collect event_ids from the matching chunks, excluding the event being processed
  const matchingEventIds = [
    ...new Set(
      results
        .map((r) => r.payload?.graph_node_id as string | undefined)
        .filter((id): id is string => !!id && !excludeEventIds.includes(id))
    ),
  ].slice(0, TOP_K * 2);

  if (matchingEventIds.length === 0) return [];

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

Given a new message/event and a list of existing project decisions, determine:
1. Does the message CONTRADICT or CHALLENGE any of the listed decisions?
2. A contradiction means the message suggests doing something different, reopening a closed question, or expressing doubt about a settled choice.

Routine updates, bug fixes, or messages that are consistent with decisions are NOT drift.

Respond with JSON only:
{ "drifts": [{ "decision_id": "...", "reason": "one sentence why this is a contradiction" }] }

Return { "drifts": [] } if no contradictions found.`;

interface DriftConfirmation {
  drifts: Array<{ decision_id: string; reason: string }>;
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

  return chatJSON<DriftConfirmation>(
    MODELS.EXTRACTION, // Use fast model for confirmation — cheaper
    [
      { role: "system", content: DRIFT_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 512, temperature: 0 }
  );
}

// ── Main processing ────────────────────────────────────────────────────────

async function processMessage(id: string, result: ExtractionResult) {
  if (!result.raw_content || result.raw_content.trim().length < 20) {
    await redis.xack(STREAMS.EXTRACTED, GROUP, id);
    return;
  }

  // Only run drift detection on non-GitHub events (Slack, meetings, Jira).
  // GitHub-on-GitHub is intra-PR debate — expected, not drift.
  // Remove this guard when GitHub issues/commits are added in M5.
  const isGithub = result.event_id.startsWith("seed_") || result.event_id.startsWith("gh_")
    || (!result.event_id.startsWith("slack_") && !result.event_id.startsWith("meeting_") && !result.event_id.startsWith("jira_"));
  if (isGithub) {
    await redis.xack(STREAMS.EXTRACTED, GROUP, id);
    return;
  }

  // Stage A: find semantically similar confirmed decisions
  const candidates = await stageA(
    result.raw_content,
    result.project_id,
    [result.event_id] // exclude the event itself
  );

  if (candidates.length === 0) {
    await redis.xack(STREAMS.EXTRACTED, GROUP, id);
    return;
  }

  // Stage C: LLM confirmation
  let confirmation: DriftConfirmation;
  try {
    confirmation = await stageC(result.raw_content, candidates);
  } catch (e) {
    console.error(`[drift-detector] LLM confirmation failed for ${result.event_id}:`, e);
    await redis.xack(STREAMS.EXTRACTED, GROUP, id);
    return;
  }

  if (confirmation.drifts.length === 0) {
    await redis.xack(STREAMS.EXTRACTED, GROUP, id);
    return;
  }

  // Write confirmed DriftAlerts to Neo4j and publish to events:drift
  for (const drift of confirmation.drifts) {
    const alert: DriftAlert = {
      alert_id: uuidv4(),
      decision_id: drift.decision_id,
      event_id: result.event_id,
      source: (result.event_id.startsWith("slack_") ? "slack"
        : result.event_id.startsWith("meeting_") ? "meeting"
        : result.event_id.startsWith("jira_") ? "jira"
        : "github") as EventSource,
      content: result.raw_content.slice(0, 500),
      actor: result.actor.name,
      timestamp: result.timestamp,
      confirmed_by_llm: true,
      resolution: "pending",
    };

    try {
      await writeDriftAlert(alert);
      await writer.xadd(STREAMS.DRIFT, "*", "alert", JSON.stringify(alert));
      console.log(
        `[drift-detector] ⚡ DRIFT ALERT: event=${result.event_id} challenges decision=${drift.decision_id}: ${drift.reason}`
      );
    } catch (e) {
      console.error(`[drift-detector] failed to write alert for ${result.event_id}:`, e);
    }
  }

  await redis.xack(STREAMS.EXTRACTED, GROUP, id);
}

async function run() {
  await ensureGroup();
  console.log("[drift-detector] started, reading from", STREAMS.EXTRACTED);
  console.log(`[drift-detector] semantic threshold: ${SEMANTIC_THRESHOLD}, top-k: ${TOP_K}`);

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
      STREAMS.EXTRACTED,
      ">"
    );

    if (!results) continue;

    for (const [, messages] of results as [string, [string, string[]][]][]) {
      for (const [id, fields] of messages) {
        const resultJson = fields[fields.indexOf("result") + 1];
        if (!resultJson) {
          await redis.xack(STREAMS.EXTRACTED, GROUP, id);
          continue;
        }
        try {
          const result = JSON.parse(resultJson) as ExtractionResult;
          await processMessage(id, result);
        } catch (e) {
          console.error(`[drift-detector] failed to process ${id}:`, e);
          await redis.xack(STREAMS.EXTRACTED, GROUP, id);
        }
      }
    }
  }
}

run().catch((e) => {
  console.error("[drift-detector] fatal:", e);
  process.exit(1);
});
