// Risk tiers use a hybrid model: deterministic rule-based floor + LLM nuance on top.
// overall_risk = max(rule_floor, llm_tier) per decision.
// Floor rules: open DriftAlert → min "high"; confidence="high" → min "medium".
import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { getDecisionsWithTicketsByEventIds } from "../lib/neo4j.js";
import { chatJSON, MODELS } from "../lib/llm.js";
import type { ImpactDecision, ImpactResponse, ImpactTask } from "@purpl/types";

const TIER_RANK: Record<string, number> = { low: 0, medium: 1, high: 2, critical: 3 };
type RiskTier = "critical" | "high" | "medium" | "low";

function maxTier(a: RiskTier, b: RiskTier): RiskTier {
  return (TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b;
}

function ruleFloor(confidence: string, openDriftCount: number): RiskTier {
  if (openDriftCount > 0) return "high";
  if (confidence === "high") return "medium";
  return "low";
}

const TOP_K = 15;
// Cap decisions sent to LLM — avoids token overflow on large corpora; tunable via env
const LLM_DECISION_CAP = Number(process.env.IMPACT_LLM_DECISION_CAP ?? 10);

// Minimum Qdrant score to treat a chunk as relevant to the change
const RELEVANCE_THRESHOLD = 0.55;

const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? "";
const JIRA_USER = process.env.JIRA_USER ?? "";
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN ?? "";

// ── Jira API ──────────────────────────────────────────────────────────────────

interface JiraTicketInfo {
  summary: string;
  status: string;
  assignee: string | null;
  url: string;
}

async function fetchJiraTicket(ticketRef: string): Promise<JiraTicketInfo | null> {
  if (!JIRA_BASE_URL || !JIRA_USER || !JIRA_API_TOKEN) return null;

  try {
    const url = `${JIRA_BASE_URL}/rest/api/3/issue/${encodeURIComponent(ticketRef)}?fields=summary,status,assignee`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${JIRA_USER}:${JIRA_API_TOKEN}`).toString("base64")}`,
        "Accept": "application/json",
      },
    });

    if (!res.ok) return null;

    const data = await res.json() as {
      fields: {
        summary: string;
        status: { name: string };
        assignee: { displayName: string } | null;
      };
    };

    return {
      summary: data.fields.summary,
      status: data.fields.status.name,
      assignee: data.fields.assignee?.displayName ?? null,
      url: `${JIRA_BASE_URL}/browse/${ticketRef}`,
    };
  } catch {
    return null;
  }
}

// ── LLM risk assessment ───────────────────────────────────────────────────────

const IMPACT_SYSTEM_PROMPT = `You are a senior engineer assessing the risk of a proposed code change against existing architectural decisions and linked tasks.

For each affected decision, determine:
- risk_tier: "critical" (breaks a hard constraint) | "high" (likely rework needed) | "medium" (possible friction) | "low" (worth knowing, minimal risk)
- reason: one sentence explaining why this decision is affected

Then provide:
- overall_risk: the highest risk tier across all decisions
- summary: 2-3 sentence plain-English impact summary for the engineering team

Output JSON only:
{
  "overall_risk": "critical|high|medium|low",
  "summary": "...",
  "assessments": [
    { "decision_id": "...", "risk_tier": "critical|high|medium|low", "reason": "..." }
  ]
}`;

interface LLMAssessment {
  overall_risk: "critical" | "high" | "medium" | "low";
  summary: string;
  assessments: Array<{
    decision_id: string;
    risk_tier: "critical" | "high" | "medium" | "low";
    reason: string;
  }>;
}

async function assessImpact(
  changeDescription: string,
  decisions: Array<{ decision_id: string; summary: string; rationale: string | null; status: string; confidence: string; open_drift_count: number }>
): Promise<LLMAssessment> {
  if (decisions.length === 0) {
    return {
      overall_risk: "low",
      summary: "No existing decisions found that are directly relevant to this change.",
      assessments: [],
    };
  }

  // Cap to most relevant decisions to avoid token overflow
  const capped = decisions.slice(0, LLM_DECISION_CAP);

  const decisionList = capped
    .map((d, i) => `${i + 1}. [${d.decision_id}] ${d.summary}${d.rationale ? ` (rationale: ${d.rationale})` : ""} [status: ${d.status}]`)
    .join("\n");

  try {
    return await chatJSON<LLMAssessment>(
      MODELS.QUERY,
      [
        { role: "system", content: IMPACT_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Proposed change: ${changeDescription}\n\nExisting decisions that may be affected:\n${decisionList}`,
        },
      ],
      { maxTokens: 2048, temperature: 0 }
    );
  } catch (err) {
    console.error("[impact-engine] LLM assessment failed:", (err as Error).message ?? err);
    // Fallback: mark all as medium risk without LLM
    return {
      overall_risk: "medium",
      summary: "Impact assessment unavailable — manual review recommended.",
      assessments: decisions.map((d) => ({
        decision_id: d.decision_id,
        risk_tier: "medium",
        reason: "Assessment failed; flag for manual review.",
      })),
    };
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function analyzeImpact(
  changeDescription: string,
  projectId: string
): Promise<ImpactResponse> {
  const startMs = Date.now();

  // 1. Semantic search for relevant chunks
  const queryVector = await embed(changeDescription);
  const results = await qdrant.search(COLLECTION, {
    vector: queryVector,
    limit: TOP_K,
    filter: { must: [{ key: "project_id", match: { value: projectId } }] },
    with_payload: true,
  }) as Array<{ id: string | number; score: number; payload?: Record<string, unknown> }>;

  // Build max-score-per-event map so decisions inherit the strongest relevance signal
  // from their source event's chunks. Option A: event proxy score — no extra embed calls.
  // Option B (higher accuracy): embed each decision summary individually against changeDescription.
  const relevantChunks = results.filter(
    (r) => r.score >= RELEVANCE_THRESHOLD && r.payload?.graph_node_id
  );
  const eventMaxScore = new Map<string, number>();
  for (const r of relevantChunks) {
    const eid = String(r.payload!.graph_node_id);
    eventMaxScore.set(eid, Math.max(eventMaxScore.get(eid) ?? 0, r.score));
  }
  const relevantEventIds = [...new Set(relevantChunks.map((r) => String(r.payload!.graph_node_id)))];

  // 2. Fetch decisions + ticket refs from graph
  const decisionsRaw = await getDecisionsWithTicketsByEventIds(relevantEventIds, projectId);

  // Sort by max chunk score of source event descending — best available per-decision relevance signal.
  // Deterministic tiebreaker on decision_id for decisions from the same event.
  const decisionsWithTickets = decisionsRaw.sort(
    (a, b) =>
      ((eventMaxScore.get(b.event_id) ?? 0) - (eventMaxScore.get(a.event_id) ?? 0)) ||
      a.decision_id.localeCompare(b.decision_id)
  );

  if (decisionsWithTickets.length === 0) {
    return {
      change_description: changeDescription,
      overall_risk: "low",
      summary: "No decisions in the brain are relevant to this change.",
      affected_decisions: [],
      latency_ms: Date.now() - startMs,
    };
  }

  // 3. LLM risk assessment — only top N decisions; remainder get floor-only assessment
  const llmDecisions = decisionsWithTickets.slice(0, LLM_DECISION_CAP);
  const remainderDecisions = decisionsWithTickets.slice(LLM_DECISION_CAP);
  const assessment = await assessImpact(changeDescription, llmDecisions);
  const assessmentDegraded = assessment.summary.includes("unavailable") || remainderDecisions.length > 0;

  // 4. Enrich each ticket with live Jira data (parallel, best-effort)
  const allTicketRefs = [...new Set(decisionsWithTickets.flatMap((d) => d.ticket_refs))];
  const jiraInfoMap = new Map<string, JiraTicketInfo | null>();

  await Promise.all(
    allTicketRefs.map(async (ref) => {
      jiraInfoMap.set(ref, await fetchJiraTicket(ref));
    })
  );

  // Build risk tier lookup from LLM assessment
  const riskByDecision = new Map(
    assessment.assessments.map((a) => [a.decision_id, a])
  );

  function buildDecision(d: typeof decisionsWithTickets[number], riskTier: RiskTier, reason: string): ImpactDecision {
    const affectedTickets: ImpactTask[] = d.ticket_refs.map((ref) => {
      const info = jiraInfoMap.get(ref);
      return {
        ticket_ref: ref,
        jira_summary: info?.summary,
        jira_status: info?.status,
        jira_assignee: info?.assignee ?? undefined,
        jira_url: info?.url,
        risk_tier: riskTier,
        reason,
      };
    });
    return { decision_id: d.decision_id, summary: d.summary, rationale: d.rationale, status: d.status, risk_tier: riskTier, affected_tickets: affectedTickets };
  }

  // 5. Apply deterministic floor over LLM tier — LLM-assessed decisions only
  const floored = llmDecisions.map((d) => {
    const assess = riskByDecision.get(d.decision_id);
    const llmTier = (assess?.risk_tier ?? "low") as RiskTier;
    const floor = ruleFloor(d.confidence, d.open_drift_count);
    return { d, riskTier: maxTier(llmTier, floor), reason: assess?.reason ?? "" };
  });

  // Remainder decisions: floor-only, explicit reason so callers know they weren't LLM-assessed
  const flooredRemainder = remainderDecisions.map((d) => {
    const floor = ruleFloor(d.confidence, d.open_drift_count);
    return { d, riskTier: floor, reason: "Not individually assessed — deterministic floor applied (confidence/drift)." };
  });

  const overall_risk = [...floored, ...flooredRemainder].reduce<RiskTier>(
    (acc, { riskTier }) => maxTier(acc, riskTier),
    assessment.overall_risk as RiskTier
  );

  const sortByRisk = (items: typeof floored) =>
    [...items].sort((a, b) => (TIER_RANK[b.riskTier] ?? 0) - (TIER_RANK[a.riskTier] ?? 0));

  return {
    change_description: changeDescription,
    overall_risk,
    summary: assessment.summary,
    affected_decisions: sortByRisk(floored).map(({ d, riskTier, reason }) => buildDecision(d, riskTier, reason)),
    not_assessed_decisions: flooredRemainder.length > 0
      ? sortByRisk(flooredRemainder).map(({ d, riskTier, reason }) => buildDecision(d, riskTier, reason))
      : undefined,
    assessment_degraded: assessmentDegraded || undefined,
    latency_ms: Date.now() - startMs,
  };
}
