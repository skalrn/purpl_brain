import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { getDecisionsWithTicketsByEventIds } from "../lib/neo4j.js";
import { chatJSON, MODELS } from "../lib/llm.js";
import type { ImpactDecision, ImpactResponse, ImpactTask } from "@purpl/types";

const TOP_K = 15;

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
  decisions: Array<{ decision_id: string; summary: string; rationale: string | null; status: string }>
): Promise<LLMAssessment> {
  if (decisions.length === 0) {
    return {
      overall_risk: "low",
      summary: "No existing decisions found that are directly relevant to this change.",
      assessments: [],
    };
  }

  const decisionList = decisions
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
      { maxTokens: 1024, temperature: 0 }
    );
  } catch {
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

  const relevantEventIds = [
    ...new Set(
      results
        .filter((r) => r.score >= RELEVANCE_THRESHOLD && r.payload?.graph_node_id)
        .map((r) => String(r.payload!.graph_node_id))
    ),
  ];

  // 2. Fetch decisions + ticket refs from graph
  const decisionsWithTickets = await getDecisionsWithTicketsByEventIds(relevantEventIds, projectId);

  if (decisionsWithTickets.length === 0) {
    return {
      change_description: changeDescription,
      overall_risk: "low",
      summary: "No decisions in the brain are relevant to this change.",
      affected_decisions: [],
      latency_ms: Date.now() - startMs,
    };
  }

  // 3. LLM risk assessment
  const assessment = await assessImpact(changeDescription, decisionsWithTickets);

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

  // 5. Assemble ImpactDecision objects
  const affectedDecisions: ImpactDecision[] = decisionsWithTickets.map((d) => {
    const assess = riskByDecision.get(d.decision_id);
    const riskTier = assess?.risk_tier ?? "low";
    const reason = assess?.reason ?? "";

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

    return {
      decision_id: d.decision_id,
      summary: d.summary,
      rationale: d.rationale,
      status: d.status,
      affected_tickets: affectedTickets,
    };
  });

  return {
    change_description: changeDescription,
    overall_risk: assessment.overall_risk,
    summary: assessment.summary,
    affected_decisions: affectedDecisions,
    latency_ms: Date.now() - startMs,
  };
}
