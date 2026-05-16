import { getSession } from "../lib/neo4j.js";
import { chat, MODELS } from "../lib/llm.js";

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
  summary: string;
  rationale: string;
  confidence: string;
  valid_from: string;
  source_url: string;
  actor_name: string;
}

interface EventRow {
  event_type: string;
  timestamp: string;
  url: string;
  actor_name: string;
}

const CHANGELOG_SYSTEM_PROMPT = `You are a precise changelog generator for software engineering teams.
Summarize the provided decisions and events into a structured changelog.

Format as markdown bullet lists grouped by type:
## Decisions
- [confidence] Summary of decision — Author, Date [cited as source URL]

## Activity
- Event type: URL — Author, Date

Rules:
- Most recent first within each group
- If no decisions exist, say "No decisions recorded in this period"
- If no activity exists, say "No activity recorded in this period"
- Be concise — one line per item
- Do not add commentary or analysis`;

async function fetchDecisions(projectId: string, range: TimeRange): Promise<DecisionRow[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.project_id = $project_id
         AND d.valid_from >= $from
         AND d.valid_from <= $to
       OPTIONAL MATCH (e)-[:AUTHORED_BY]->(p:Person)
       RETURN d.summary AS summary,
              d.rationale AS rationale,
              d.confidence AS confidence,
              d.valid_from AS valid_from,
              e.url AS source_url,
              p.name AS actor_name
       ORDER BY d.valid_from DESC`,
      { project_id: projectId, from: range.from, to: range.to }
    );
    return result.records.map((r) => r.toObject() as DecisionRow);
  } finally {
    await session.close();
  }
}

async function fetchEvents(projectId: string, range: TimeRange): Promise<EventRow[]> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (e:Event)
       WHERE e.project_id = $project_id
         AND e.timestamp >= $from
         AND e.timestamp <= $to
       OPTIONAL MATCH (e)-[:AUTHORED_BY]->(p:Person)
       RETURN e.event_type AS event_type,
              e.timestamp AS timestamp,
              e.url AS url,
              p.name AS actor_name
       ORDER BY e.timestamp DESC
       LIMIT 20`,
      { project_id: projectId, from: range.from, to: range.to }
    );
    return result.records.map((r) => r.toObject() as EventRow);
  } finally {
    await session.close();
  }
}

function formatDecisions(decisions: DecisionRow[]): string {
  if (decisions.length === 0) return "No decisions recorded in this period.";
  return decisions
    .map((d) =>
      `- [${d.confidence}] ${d.summary}${d.rationale ? ` — ${d.rationale}` : ""} (${d.actor_name ?? "unknown"}, ${d.valid_from?.slice(0, 10) ?? ""}) — ${d.source_url}`
    )
    .join("\n");
}

function formatEvents(events: EventRow[]): string {
  if (events.length === 0) return "No activity recorded in this period.";
  return events
    .map((e) =>
      `- ${e.event_type}: ${e.url} — ${e.actor_name ?? "unknown"}, ${e.timestamp?.slice(0, 10) ?? ""}`
    )
    .join("\n");
}

export async function runTemporalQuery(
  projectId: string,
  range: TimeRange,
  originalQuery: string
): Promise<TemporalResult> {
  const startMs = Date.now();

  const [decisions, events] = await Promise.all([
    fetchDecisions(projectId, range),
    fetchEvents(projectId, range),
  ]);

  if (decisions.length === 0 && events.length === 0) {
    return {
      changelog: `No decisions or activity found between ${range.from.slice(0, 10)} and ${range.to.slice(0, 10)}.`,
      decisions_found: 0,
      events_found: 0,
      latency_ms: Date.now() - startMs,
    };
  }

  const userMessage = `Question: "${originalQuery}"
Time range: ${range.from.slice(0, 10)} to ${range.to.slice(0, 10)}

Decisions in this period:
${formatDecisions(decisions)}

Activity in this period:
${formatEvents(events)}

Generate a changelog summarizing what happened.`;

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
    events_found: events.length,
    latency_ms: Date.now() - startMs,
  };
}
