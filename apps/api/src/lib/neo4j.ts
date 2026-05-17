import neo4j from "neo4j-driver";
import type { DriftAlert } from "@purpl/types";

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? process.env.NEO4J_PASS ?? "password";

export const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
);

export const getSession = () => driver.session();

export async function writeDriftAlert(alert: DriftAlert): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (d:Decision {decision_id: $decision_id})
       CREATE (a:DriftAlert {
         alert_id: $alert_id,
         event_id: $event_id,
         source: $source,
         content: $content,
         actor: $actor,
         timestamp: $timestamp,
         confirmed_by_llm: $confirmed_by_llm,
         resolution: $resolution
       })
       CREATE (a)-[:CHALLENGES]->(d)`,
      {
        decision_id: alert.decision_id,
        alert_id: alert.alert_id,
        event_id: alert.event_id,
        source: alert.source,
        content: alert.content,
        actor: alert.actor,
        timestamp: alert.timestamp,
        confirmed_by_llm: alert.confirmed_by_llm,
        resolution: alert.resolution,
      }
    );
  } finally {
    await session.close();
  }
}

export async function resolveDriftAlert(
  alert_id: string,
  resolution: "keep" | "under_review" | "reopen",
  resolved_at: string
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (a:DriftAlert {alert_id: $alert_id})
       SET a.resolution = $resolution, a.resolved_at = $resolved_at
       WITH a
       MATCH (a)-[:CHALLENGES]->(d:Decision)
       SET d.status = CASE $resolution
         WHEN "under_review" THEN "under_review"
         WHEN "reopen" THEN "changed"
         ELSE d.status
       END`,
      { alert_id, resolution, resolved_at }
    );
  } finally {
    await session.close();
  }
}

export async function getDecisionsForDriftCheck(projectId: string): Promise<Array<{
  decision_id: string;
  summary: string;
  quoted_text: string;
  status: string;
}>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event {project_id: $project_id})
       WHERE d.status = "confirmed"
       RETURN d.decision_id AS decision_id,
              d.summary AS summary,
              d.quoted_text AS quoted_text,
              d.status AS status
       LIMIT 100`,
      { project_id: projectId }
    );
    return result.records.map((r) => ({
      decision_id: r.get("decision_id") as string,
      summary: r.get("summary") as string,
      quoted_text: r.get("quoted_text") as string,
      status: r.get("status") as string,
    }));
  } finally {
    await session.close();
  }
}

/** Given event_ids from Qdrant chunks, return the decisions extracted from those events. */
export async function getDecisionsByEventIds(eventIds: string[]): Promise<Array<{
  decision_id: string;
  event_id: string;
  summary: string;
  quoted_text: string;
  status: string;
}>> {
  if (eventIds.length === 0) return [];
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.event_id IN $event_ids AND d.status = "confirmed"
       RETURN d.decision_id AS decision_id,
              e.event_id AS event_id,
              d.summary AS summary,
              d.quoted_text AS quoted_text,
              d.status AS status`,
      { event_ids: eventIds }
    );
    return result.records.map((r) => ({
      decision_id: r.get("decision_id") as string,
      event_id: r.get("event_id") as string,
      summary: r.get("summary") as string,
      quoted_text: r.get("quoted_text") as string,
      status: r.get("status") as string,
    }));
  } finally {
    await session.close();
  }
}

export async function getDriftAlerts(projectId: string): Promise<Array<{
  alert_id: string;
  decision_id: string;
  decision_summary: string;
  source: string;
  content: string;
  actor: string;
  timestamp: string;
  resolution: string;
}>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (a:DriftAlert)-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(e:Event {project_id: $project_id})
       WHERE a.resolution = "pending"
       RETURN a.alert_id AS alert_id,
              d.decision_id AS decision_id,
              d.summary AS decision_summary,
              a.source AS source,
              a.content AS content,
              a.actor AS actor,
              a.timestamp AS timestamp,
              a.resolution AS resolution
       ORDER BY a.timestamp DESC`,
      { project_id: projectId }
    );
    return result.records.map((r) => ({
      alert_id: r.get("alert_id") as string,
      decision_id: r.get("decision_id") as string,
      decision_summary: r.get("decision_summary") as string,
      source: r.get("source") as string,
      content: r.get("content") as string,
      actor: r.get("actor") as string,
      timestamp: r.get("timestamp") as string,
      resolution: r.get("resolution") as string,
    }));
  } finally {
    await session.close();
  }
}
