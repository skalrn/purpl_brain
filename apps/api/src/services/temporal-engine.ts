/**
 * Temporal engine — "what changed in the last N days" diff path.
 *
 * Per docs/technical/query-layer.md:
 *   1. Query Neo4j for Decision nodes whose valid_from falls in [from, to].
 *   2. For each, look up a prior version: a Decision in the same project,
 *      with valid_from BEFORE this decision, whose summary is semantically
 *      similar (Qdrant vector search) above SUPERSEDES_THRESHOLD.
 *   3. Group by source (inferred from the extracting Event's event_id prefix).
 *   4. Produce a structured changelog: created vs. superseded, by source,
 *      with who decided and what it replaced.
 *
 * This is a real diff: it identifies "what replaced what," not just
 * "what happened in this window." Distinct from runQuery — does NOT use
 * vector retrieval to assemble context; only to find supersedes candidates.
 */
import { getSession, writeSupersedesEdge, resolveAlertsForSupersededDecision } from "../lib/neo4j.js";
import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { chat, chatJSON, MODELS } from "../lib/llm.js";
import { inferSourceFromEventId } from "../lib/event-source.js";
import type { EventSource } from "@purpl/types";

export interface TimeRange {
  from: string; // ISO 8601
  to: string;   // ISO 8601
}

export interface TemporalResult {
  changelog: string;
  decisions_found: number;
  events_found: number;
  latency_ms: number;
}

interface DecisionRow {
  decision_id: string;
  event_id: string;
  summary: string;
  rationale: string | null;
  confidence: string;
  valid_from: string;
  source_url: string;
  actor_name: string | null;
}

interface PriorMatch {
  decision_id: string;
  summary: string;
  valid_from: string;
  source_url: string;
  score: number;
}

interface ChangelogEntry {
  decision: DecisionRow;
  source: EventSource;
  kind: "created" | "superseded";
  replaced?: PriorMatch;
}

// Broad candidate threshold — low enough to catch topically-related decisions
// including reversals (e.g. "no cache needed" vs "add Redis cache"). The old
// 0.72 paraphrase threshold was structurally blind to reversals because a
// decision and its opposite score low on cosine similarity.
// LLM confirmation (stageC below) gates which candidates actually supersede.
const SUPERSEDES_CANDIDATE_THRESHOLD = parseFloat(
  process.env.TEMPORAL_CANDIDATE_THRESHOLD ?? "0.35"
);
const SUPERSEDES_TOP_K = 5;

const CHANGELOG_SYSTEM_PROMPT = `You are a precise changelog generator for a software engineering team's decision history.

You are given a structured delta of decisions from a time window. Produce a markdown changelog grouped by source.

Format:

## <Source name, e.g. GitHub / Slack / Meeting / Agent>

- **Created**: <one-line summary of the decision> — <author>, <date> [<url>]
- **Replaced**: <one-line summary of the new decision> — <author>, <date> [<url>]
  - Previously: <one-line summary of the prior decision> [<url>]

Rules:
- Most recent first within each group.
- Use the actor name; if missing, write "unknown".
- Dates as YYYY-MM-DD.
- Keep each bullet to one line; do not commentate.
- If a source has no entries, omit the section entirely.
- Never invent decisions, dates, or URLs that are not in the input.`;

async function fetchDecisionsInRange(
  projectId: string,
  range: TimeRange
): Promise<DecisionRow[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.project_id = $project_id
         AND d.valid_from >= $from
         AND d.valid_from <= $to
       OPTIONAL MATCH (e)-[:AUTHORED_BY]->(p:Person)
       RETURN d.decision_id  AS decision_id,
              e.event_id     AS event_id,
              d.summary      AS summary,
              d.rationale    AS rationale,
              d.confidence   AS confidence,
              d.valid_from   AS valid_from,
              e.url          AS source_url,
              p.name         AS actor_name
       ORDER BY d.valid_from DESC`,
      { project_id: projectId, from: range.from, to: range.to }
    );
    return result.records.map((r) => ({
      decision_id: r.get("decision_id") as string,
      event_id: r.get("event_id") as string,
      summary: r.get("summary") as string,
      rationale: (r.get("rationale") as string | null) ?? null,
      confidence: (r.get("confidence") as string) ?? "",
      valid_from: r.get("valid_from") as string,
      source_url: (r.get("source_url") as string) ?? "",
      actor_name: (r.get("actor_name") as string | null) ?? null,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Count of all Event nodes in the time window (used as a sanity stat in the
 * response; not gated on Decision existence).
 */
async function countEventsInRange(
  projectId: string,
  range: TimeRange
): Promise<number> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (e:Event)
       WHERE e.project_id = $project_id
         AND e.timestamp >= $from
         AND e.timestamp <= $to
       RETURN count(e) AS n`,
      { project_id: projectId, from: range.from, to: range.to }
    );
    const n = result.records[0]?.get("n");
    // neo4j-driver returns Integer; coerce safely
    return typeof n === "number" ? n : Number(n?.toNumber?.() ?? 0);
  } finally {
    await session.close();
  }
}

// ── Stage C: LLM supersession confirmation ────────────────────────────────────
// Mirrors the drift-detector Stage C pattern. Low Qdrant threshold catches
// reversals (low-similarity opposites); LLM confirms whether supersession is real.

const SUPERSEDES_CONFIRM_SYSTEM = `You are a decision supersession detector for software engineering teams.

Given a newer engineering decision and a list of older decisions from the same project, identify which older decision (if any) the newer one supersedes, reverses, or replaces.

A newer decision SUPERSEDES an older one when:
- It reverses the stance: chose X before, now choosing not-X or the opposite
- It replaces the technology or approach for the same purpose: chose X, now choosing Y for the same concern
- It updates or refines the choice for the same specific concern

A newer decision does NOT supersede an older one when:
- They address genuinely different concerns or different parts of the system
- The newer decision extends or adds something without changing the older choice
- The newer decision is about a different component, module, or scope

Respond with JSON only:
{
  "superseded_id": "<decision_id of the one being superseded, or null if none>",
  "reasoning": "one sentence explaining why this is or is not a supersession"
}`;

interface SupersedesConfirmation {
  superseded_id: string | null;
  reasoning: string;
}

async function confirmSupersession(
  newer: DecisionRow,
  candidates: Array<PriorMatch & { rationale?: string }>
): Promise<PriorMatch | null> {
  if (candidates.length === 0) return null;

  const candidatesBlock = candidates
    .map((c, i) =>
      `Candidate ${i + 1}:\n  decision_id: ${c.decision_id}\n  summary: "${c.summary}"\n  date: ${c.valid_from.slice(0, 10)}`
    )
    .join("\n\n");

  const userMessage = `Newer decision (${newer.valid_from.slice(0, 10)}):
  summary: "${newer.summary}"${newer.rationale ? `\n  rationale: "${newer.rationale}"` : ""}

Older candidate decisions:
${candidatesBlock}

Does the newer decision supersede any of these?`;

  console.log(
    `[temporal-engine] stage-C: checking ${candidates.length} candidate(s) for "${newer.summary.slice(0, 60)}"`
  );

  try {
    const result = await chatJSON<SupersedesConfirmation>(
      MODELS.EXTRACTION,
      [
        { role: "system", content: SUPERSEDES_CONFIRM_SYSTEM },
        { role: "user", content: userMessage },
      ]
    );

    console.log(
      `[temporal-engine] stage-C result: superseded_id=${result.superseded_id ?? "none"} — ${result.reasoning}`
    );

    if (!result.superseded_id) return null;
    return candidates.find((c) => c.decision_id === result.superseded_id) ?? null;
  } catch (e) {
    console.error("[temporal-engine] stage-C confirmation failed:", e);
    return null;
  }
}

// Max prior decisions to pass directly to LLM without Qdrant pre-filtering.
// For corpora with more decisions than this, Qdrant pre-filters first.
const NEO4J_DIRECT_LIMIT = parseInt(
  process.env.TEMPORAL_NEO4J_DIRECT_LIMIT ?? "25"
);

/**
 * Fetch up to `limit` Decision nodes that are older than `validFrom` in the
 * same project, excluding `selfId`. Most-recent first.
 */
async function fetchPriorDecisions(
  projectId: string,
  validFrom: string,
  selfId: string,
  limit: number
): Promise<Array<PriorMatch & { rationale?: string }>> {
  const session = getSession();
  try {
    // Note: LIMIT with a parameter is unreliable across Neo4j versions/drivers;
    // fetch all candidates and slice in application code.
    const result = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.project_id = $project_id
         AND d.decision_id <> $self
         AND d.valid_from < $valid_from
         AND NOT (d)<-[:SUPERSEDES]-()
       RETURN d.decision_id AS decision_id,
              d.summary     AS summary,
              d.rationale   AS rationale,
              d.valid_from  AS valid_from,
              e.url         AS source_url
       ORDER BY d.valid_from DESC`,
      { project_id: projectId, self: selfId, valid_from: validFrom }
    );
    return result.records.slice(0, limit).map((r) => ({
      decision_id: r.get("decision_id") as string,
      summary: r.get("summary") as string,
      rationale: (r.get("rationale") as string | null) ?? undefined,
      valid_from: r.get("valid_from") as string,
      source_url: (r.get("source_url") as string) ?? "",
      score: 0,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Find a prior version of `decision` that the newer decision supersedes.
 *
 * Two-stage approach — Stage A varies by corpus size:
 *
 *   Small corpus (≤ NEO4J_DIRECT_LIMIT prior decisions):
 *     Stage A — Query Neo4j directly for all prior decisions. Bypasses Qdrant
 *               entirely. Semantic search on multi-decision chunks is the wrong
 *               instrument for finding reversals — a decision and its opposite
 *               (e.g. "no cache needed" vs "add Redis cache") score LOW on
 *               cosine similarity and would never surface as candidates.
 *
 *   Large corpus (> NEO4J_DIRECT_LIMIT):
 *     Stage A — Qdrant broad candidate search at low threshold (0.35) to
 *               surface topically-related decisions, then Neo4j lookup.
 *               LLM still makes the final call.
 *
 *   Stage C — LLM confirms which candidate (if any) is actually superseded.
 */
async function findPriorVersion(
  projectId: string,
  decision: DecisionRow
): Promise<PriorMatch | null> {
  // Stage A: get candidates — prefer Neo4j direct query for small corpora
  let candidates: Array<PriorMatch & { rationale?: string }>;

  const priorDirect = await fetchPriorDecisions(
    projectId, decision.valid_from, decision.decision_id, NEO4J_DIRECT_LIMIT + 1
  );

  if (priorDirect.length <= NEO4J_DIRECT_LIMIT) {
    // Small corpus — use all prior decisions directly, no Qdrant filter needed
    candidates = priorDirect;
    console.log(
      `[temporal-engine] stage-A (neo4j-direct): ${candidates.length} prior decision(s) for "${decision.summary.slice(0, 60)}"`
    );
  } else {
    // Large corpus — use Qdrant to pre-filter topically-related decisions
    const vector = await embed(decision.summary).catch(() => null);
    if (!vector) return null;

    const results = (await qdrant.search(COLLECTION, {
      vector,
      limit: SUPERSEDES_TOP_K * 4,
      filter: {
        must: [
          { key: "project_id", match: { value: projectId } },
          { key: "has_decisions", match: { value: true } },
        ],
      },
      with_payload: true,
      score_threshold: SUPERSEDES_CANDIDATE_THRESHOLD,
    })) as Array<{ score: number; payload?: Record<string, unknown> }>;

    const candidateEventIds = [
      ...new Set(
        results
          .map((r) => String(r.payload?.graph_node_id ?? ""))
          .filter((id) => id && id !== decision.event_id)
      ),
    ];
    if (candidateEventIds.length === 0) return null;

    const session = getSession();
    try {
      const lookup = await session.run(
        `UNWIND $ids AS eid
         MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event {event_id: eid})
         WHERE d.decision_id <> $self
           AND d.valid_from < $valid_from
           AND NOT (d)<-[:SUPERSEDES]-()
         RETURN d.decision_id AS decision_id,
                d.summary     AS summary,
                d.rationale   AS rationale,
                d.valid_from  AS valid_from,
                e.url         AS source_url,
                eid           AS event_id
         ORDER BY d.valid_from DESC`,
        { ids: candidateEventIds, self: decision.decision_id, valid_from: decision.valid_from }
      );

      const scoreByEventId = new Map(
        results.map((r) => [String(r.payload?.graph_node_id ?? ""), r.score])
      );
      const seen = new Set<string>();
      candidates = [];
      for (const r of lookup.records) {
        const did = r.get("decision_id") as string;
        if (seen.has(did)) continue;
        seen.add(did);
        candidates.push({
          decision_id: did,
          summary: r.get("summary") as string,
          rationale: (r.get("rationale") as string | null) ?? undefined,
          valid_from: r.get("valid_from") as string,
          source_url: (r.get("source_url") as string) ?? "",
          score: scoreByEventId.get(r.get("event_id") as string) ?? SUPERSEDES_CANDIDATE_THRESHOLD,
        });
        if (candidates.length >= SUPERSEDES_TOP_K) break;
      }
    } finally {
      await session.close();
    }
    console.log(
      `[temporal-engine] stage-A (qdrant): ${candidates.length} candidate(s) for "${decision.summary.slice(0, 60)}" — scores: ${candidates.map((c) => c.score.toFixed(2)).join(", ")}`
    );
  }

  if (candidates.length === 0) return null;

  // Stage C: LLM confirms which candidate (if any) is actually superseded
  return confirmSupersession(decision, candidates);
}

function formatDelta(entries: ChangelogEntry[]): string {
  if (entries.length === 0) return "(no decisions)";

  const bySource = new Map<EventSource, ChangelogEntry[]>();
  for (const e of entries) {
    if (!bySource.has(e.source)) bySource.set(e.source, []);
    bySource.get(e.source)!.push(e);
  }

  const sections: string[] = [];
  for (const [source, items] of bySource) {
    const lines = items.map((it) => {
      const d = it.decision;
      const date = (d.valid_from ?? "").slice(0, 10);
      const author = d.actor_name ?? "unknown";
      if (it.kind === "superseded" && it.replaced) {
        const priorDate = it.replaced.valid_from.slice(0, 10);
        return (
          `- Replaced: ${d.summary} — ${author}, ${date} [${d.source_url}]\n` +
          `  - Previously: ${it.replaced.summary} (${priorDate}) [${it.replaced.source_url}]`
        );
      }
      return `- Created: ${d.summary} — ${author}, ${date} [${d.source_url}]`;
    });
    sections.push(`SOURCE=${source}\n${lines.join("\n")}`);
  }

  return sections.join("\n\n");
}

export async function runTemporalQuery(
  projectId: string,
  range: TimeRange,
  originalQuery: string
): Promise<TemporalResult> {
  const startMs = Date.now();

  const [decisions, eventCount] = await Promise.all([
    fetchDecisionsInRange(projectId, range),
    countEventsInRange(projectId, range),
  ]);

  if (decisions.length === 0) {
    return {
      changelog: `No decisions recorded between ${range.from.slice(0, 10)} and ${range.to.slice(0, 10)}.${
        eventCount > 0 ? ` ${eventCount} event(s) ingested in this window but none produced extracted decisions.` : ""
      }`,
      decisions_found: 0,
      events_found: eventCount,
      latency_ms: Date.now() - startMs,
    };
  }

  // For each decision, look up a possible prior version and persist the edge.
  // Sequential — parallel LLM calls for large time windows hit rate limits and
  // fail silently (catch returns null). Most decisions won't supersede anything,
  // so the extra latency is only paid when supersessions are actually found.
  const entries: ChangelogEntry[] = [];
  for (const d of decisions) {
    const prior = await findPriorVersion(projectId, d).catch(() => null);
    if (prior) {
      // Persist supersession and reconcile stale drift alerts — best-effort
      await Promise.all([
        writeSupersedesEdge(d.decision_id, prior.decision_id),
        resolveAlertsForSupersededDecision(prior.decision_id),
      ]).catch((err) =>
        console.error("[temporal-engine] supersedes write failed:", err)
      );
    }
    entries.push({
      decision: d,
      source: inferSourceFromEventId(d.event_id),
      kind: prior ? "superseded" : "created",
      replaced: prior ?? undefined,
    });
  }

  const userMessage = `Question: "${originalQuery}"
Time range: ${range.from.slice(0, 10)} to ${range.to.slice(0, 10)}
Decisions found: ${entries.length}
Decisions replaced: ${entries.filter((e) => e.kind === "superseded").length}

Delta (grouped by source):

${formatDelta(entries)}

Produce the changelog now.`;

  const changelog = await chat(
    MODELS.QUERY,
    [
      { role: "system", content: CHANGELOG_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 1024, temperature: 0 }
  );

  return {
    changelog,
    decisions_found: decisions.length,
    events_found: eventCount,
    latency_ms: Date.now() - startMs,
  };
}
