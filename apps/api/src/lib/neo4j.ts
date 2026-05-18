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

// ── Person identity (M5) ──────────────────────────────────────────────────────

export interface PersonRecord {
  person_id: string;
  email: string;
  name: string;
  github_login?: string;
  avatar_url?: string;
  api_key: string;
  aliases: string[];     // per-source IDs merged under this canonical person
  created_at: string;
  last_active_at: string;
}

/**
 * Upsert a canonical Person by email. If a Person with this email already
 * exists, updates name/avatar and merges the source alias. If not, creates one.
 * Returns the canonical person_id and api_key.
 */
export async function upsertPersonByEmail(params: {
  email: string;
  name: string;
  github_login: string;
  avatar_url?: string;
  api_key: string;
}): Promise<PersonRecord> {
  const session = getSession();
  try {
    const now = new Date().toISOString();
    const result = await session.run(
      `MERGE (p:Person {email: $email})
       ON CREATE SET
         p.person_id  = randomUUID(),
         p.name       = $name,
         p.github_login = $github_login,
         p.avatar_url = $avatar_url,
         p.api_key    = $api_key,
         p.aliases    = [$github_login],
         p.created_at = $now,
         p.last_active_at = $now
       ON MATCH SET
         p.name           = $name,
         p.github_login   = $github_login,
         p.avatar_url     = COALESCE($avatar_url, p.avatar_url),
         p.last_active_at = $now,
         p.aliases        = CASE
           WHEN $github_login IN p.aliases THEN p.aliases
           ELSE p.aliases + [$github_login]
         END
       RETURN p`,
      { ...params, now }
    );
    const p = result.records[0].get("p").properties as Record<string, unknown>;
    return {
      person_id: p.person_id as string,
      email: p.email as string,
      name: p.name as string,
      github_login: p.github_login as string,
      avatar_url: p.avatar_url as string | undefined,
      api_key: p.api_key as string,
      aliases: (p.aliases as string[]) ?? [],
      created_at: p.created_at as string,
      last_active_at: p.last_active_at as string,
    };
  } finally {
    await session.close();
  }
}

/**
 * Merge a source-specific alias (e.g. Slack user ID, Jira account ID) into an
 * existing Person by matching on email. No-op if person not found.
 */
export async function mergePersonAlias(email: string, alias: string): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (p:Person {email: $email})
       SET p.aliases = CASE
         WHEN $alias IN p.aliases THEN p.aliases
         ELSE p.aliases + [$alias]
       END`,
      { email, alias }
    );
  } finally {
    await session.close();
  }
}

/**
 * Look up a Person by API key — used for request authentication.
 * Returns null if not found.
 */
export async function getPersonByApiKey(api_key: string): Promise<PersonRecord | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (p:Person {api_key: $api_key})
       RETURN p`,
      { api_key }
    );
    if (result.records.length === 0) return null;
    const p = result.records[0].get("p").properties as Record<string, unknown>;
    return {
      person_id: p.person_id as string,
      email: p.email as string,
      name: p.name as string,
      github_login: p.github_login as string | undefined,
      avatar_url: p.avatar_url as string | undefined,
      api_key: p.api_key as string,
      aliases: (p.aliases as string[]) ?? [],
      created_at: p.created_at as string,
      last_active_at: p.last_active_at as string,
    };
  } finally {
    await session.close();
  }
}

/**
 * Count distinct active Person nodes (last_active_at within cutoff) — used
 * for per-seat billing.
 */
export async function countActiveSeats(since: string): Promise<number> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (p:Person)
       WHERE p.last_active_at >= $since AND p.email IS NOT NULL
       RETURN count(p) AS seats`,
      { since }
    );
    return (result.records[0]?.get("seats") as number) ?? 0;
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

// Fuzzy-match a speaker name to an existing Person node.
// Tries exact match first, then case-insensitive first-name match.
// Returns the canonical email/id if found, or null.
export async function resolvePersonByName(name: string): Promise<{ email: string; id: string; name: string } | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (p:Person)
       WHERE toLower(p.name) = toLower($name)
          OR toLower(p.name) STARTS WITH toLower(split($name, ' ')[0])
          OR any(alias IN coalesce(p.aliases, []) WHERE toLower(alias) = toLower($name))
       RETURN p.email AS email, p.id AS id, p.name AS name
       LIMIT 1`,
      { name }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      email: r.get("email") as string,
      id: r.get("id") as string,
      name: r.get("name") as string,
    };
  } finally {
    await session.close();
  }
}
