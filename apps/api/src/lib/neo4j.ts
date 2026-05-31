import neo4j from "neo4j-driver";
import { createHash } from "crypto";
import type { DriftAlert } from "@purpl/types";

/** One-way SHA-256 hash for API keys stored at rest. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Convert a Neo4j Integer object (or plain number) to a JS number. */
function toNum(val: unknown): number {
  if (val === null || val === undefined) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "object" && "toNumber" in (val as object)) {
    return (val as { toNumber(): number }).toNumber();
  }
  return Number(val) || 0;
}

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD ?? process.env.NEO4J_PASS ?? "password";

export const driver = neo4j.driver(
  NEO4J_URI,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD)
);

export const getSession = () => driver.session();

export async function writeDriftAlert(alert: DriftAlert): Promise<void> {
  // Fingerprint on decision + content so the same observation can't create duplicate alerts.
  const fingerprint = createHash("sha256")
    .update(`${alert.decision_id}:${alert.content.slice(0, 200)}`)
    .digest("hex");

  const session = getSession();
  try {
    await session.run(
      `MATCH (d:Decision {decision_id: $decision_id})
       MERGE (a:DriftAlert {fingerprint: $fingerprint})
       ON CREATE SET
         a.alert_id        = $alert_id,
         a.event_id        = $event_id,
         a.source          = $source,
         a.content         = $content,
         a.reason          = $reason,
         a.actor           = $actor,
         a.timestamp       = $timestamp,
         a.confirmed_by_llm = $confirmed_by_llm,
         a.resolution      = $resolution,
         a.project_id      = d.project_id
       MERGE (a)-[:CHALLENGES]->(d)`,
      {
        fingerprint,
        decision_id: alert.decision_id,
        alert_id: alert.alert_id,
        event_id: alert.event_id,
        source: alert.source,
        content: alert.content,
        reason: alert.reason ?? null,
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
  resolution: "keep" | "under_review" | "reopen" | "escalate",
  resolved_at: string,
  resolution_reason?: string,
  resolved_by?: string
): Promise<void> {
  // "escalate" moves a confirmation back to pending conflict for human review
  const storedResolution = resolution === "escalate" ? "pending" : resolution;
  const session = getSession();
  try {
    await session.run(
      `MATCH (a:DriftAlert {alert_id: $alert_id})
       SET a.resolution = $resolution,
           a.resolved_at = $resolved_at,
           a.resolution_reason = $resolution_reason,
           a.resolved_by = $resolved_by
       WITH a
       MATCH (a)-[:CHALLENGES]->(d:Decision)
       SET d.status = CASE $resolution
         WHEN "under_review" THEN "under_review"
         WHEN "reopen" THEN "changed"
         ELSE d.status
       END`,
      {
        alert_id,
        resolution: storedResolution,
        resolved_at,
        resolution_reason: resolution_reason ?? null,
        resolved_by: resolved_by ?? null,
      }
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
         AND NOT (d)<-[:SUPERSEDES]-()
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

/**
 * Persist a SUPERSEDES edge: newer decision replaced older decision.
 * MERGE is idempotent — safe to call multiple times for the same pair.
 */
export async function writeSupersedesEdge(
  newerDecisionId: string,
  olderDecisionId: string,
  reasoning?: string
): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (newer:Decision {decision_id: $newer_id})
       MATCH (older:Decision {decision_id: $older_id})
       MERGE (newer)-[r:SUPERSEDES]->(older)
       ON CREATE SET r.reasoning = $reasoning, r.created_at = $now`,
      {
        newer_id: newerDecisionId,
        older_id: olderDecisionId,
        reasoning: reasoning ?? null,
        now: new Date().toISOString(),
      }
    );
  } finally {
    await session.close();
  }
}

/**
 * When a decision is superseded, auto-resolve any pending DriftAlerts that were
 * challenging it — the decision is dead so the conflict no longer matters.
 * Returns the count of alerts resolved.
 */
export async function resolveAlertsForSupersededDecision(
  olderDecisionId: string
): Promise<number> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (a:DriftAlert {resolution: "pending"})-[:CHALLENGES]->(d:Decision {decision_id: $decision_id})
       SET a.resolution = "superseded", a.resolved_at = $resolved_at
       RETURN count(a) AS n`,
      { decision_id: olderDecisionId, resolved_at: new Date().toISOString() }
    );
    const n = result.records[0]?.get("n");
    return typeof n === "number" ? n : Number(n?.toNumber?.() ?? 0);
  } finally {
    await session.close();
  }
}

/**
 * For each event_id, return the confirmed decisions extracted from it along with
 * the ticket refs those decisions INFORMS (used for impact analysis traversal).
 */
export async function getDecisionsWithTicketsByEventIds(eventIds: string[], projectId: string): Promise<Array<{
  decision_id: string;
  event_id: string;
  summary: string;
  rationale: string | null;
  status: string;
  confidence: string;
  open_drift_count: number;
  ticket_refs: string[];
}>> {
  if (eventIds.length === 0) return [];
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.event_id IN $event_ids AND e.project_id = $project_id
       OPTIONAL MATCH (d)-[:INFORMS]->(t:Ticket)
       OPTIONAL MATCH (a:DriftAlert {resolution: "pending"})-[:CHALLENGES]->(d)
       RETURN d.decision_id AS decision_id,
              e.event_id AS event_id,
              d.summary AS summary,
              d.rationale AS rationale,
              d.status AS status,
              coalesce(d.confidence, 'medium') AS confidence,
              count(DISTINCT a) AS open_drift_count,
              collect(DISTINCT t.ref) AS ticket_refs`,
      { event_ids: eventIds, project_id: projectId }
    );
    return result.records.map((r) => ({
      decision_id: r.get("decision_id") as string,
      event_id: r.get("event_id") as string,
      summary: r.get("summary") as string,
      rationale: (r.get("rationale") as string | null) ?? null,
      status: (r.get("status") as string) ?? "unknown",
      confidence: (r.get("confidence") as string) ?? "medium",
      open_drift_count: (r.get("open_drift_count") as number) ?? 0,
      ticket_refs: ((r.get("ticket_refs") as string[]) ?? []).filter(Boolean),
    }));
  } finally {
    await session.close();
  }
}

// ── Person identity ───────────────────────────────────────────────────────────

export interface PersonRecord {
  person_id: string;
  name: string;
  email?: string;
  github_login?: string;
  slack_user_id?: string;
  jira_user_id?: string;
  avatar_url?: string;
  api_key?: string;
  aliases: string[];
  provisional: boolean;  // true = created from signal, not explicitly registered
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
    const hashedKey = hashApiKey(params.api_key);

    // Create or update the canonical Person by email
    const result = await session.run(
      `MERGE (p:Person {email: $email})
       ON CREATE SET
         p.person_id    = randomUUID(),
         p.name         = $name,
         p.github_login = $github_login,
         p.avatar_url   = $avatar_url,
         p.api_key      = $api_key,
         p.aliases      = [$github_login],
         p.provisional  = false,
         p.created_at   = $now,
         p.last_active_at = $now
       ON MATCH SET
         p.name           = $name,
         p.github_login   = $github_login,
         p.avatar_url     = COALESCE($avatar_url, p.avatar_url),
         p.api_key        = $api_key,
         p.provisional    = false,
         p.last_active_at = $now,
         p.aliases        = CASE
           WHEN $github_login IN coalesce(p.aliases, []) THEN p.aliases
           ELSE coalesce(p.aliases, []) + [$github_login]
         END
       RETURN p`,
      { ...params, api_key: hashedKey, now }
    );
    const p = result.records[0].get("p").properties as Record<string, unknown>;
    const primaryId = p.person_id as string;

    // Detect shadow node: a provisional stub created by the seed script with
    // the same github_login but no email (different MERGE key → different node).
    // Re-point its Event relationships to this canonical person then delete it.
    await session.run(
      `MATCH (stub:Person {github_login: $github_login})
       WHERE stub.person_id <> $primary_id AND stub.email IS NULL
       MATCH (e:Event)-[r:AUTHORED_BY]->(stub)
       MATCH (primary:Person {person_id: $primary_id})
       MERGE (e)-[:AUTHORED_BY]->(primary)
       DELETE r
       WITH stub
       DETACH DELETE stub`,
      { github_login: params.github_login, primary_id: primaryId }
    );

    return {
      person_id: primaryId,
      email: p.email as string,
      name: p.name as string,
      github_login: p.github_login as string,
      avatar_url: p.avatar_url as string | undefined,
      api_key: p.api_key as string,
      aliases: (p.aliases as string[]) ?? [],
      provisional: false,
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
      { api_key: hashApiKey(api_key) }
    );
    if (result.records.length === 0) return null;
    const p = result.records[0].get("p").properties as Record<string, unknown>;
    return {
      person_id: p.person_id as string,
      email: p.email as string | undefined,
      name: p.name as string,
      github_login: p.github_login as string | undefined,
      slack_user_id: p.slack_user_id as string | undefined,
      jira_user_id: p.jira_user_id as string | undefined,
      avatar_url: p.avatar_url as string | undefined,
      api_key: p.api_key as string,
      aliases: (p.aliases as string[]) ?? [],
      provisional: (p.provisional as boolean) ?? false,
      created_at: p.created_at as string,
      last_active_at: p.last_active_at as string,
    };
  } finally {
    await session.close();
  }
}

/**
 * Ensure an API key is registered as a Bot Person in Neo4j.
 * Called at startup for BRAIN_API_KEY so MCP deployments work without DEV_API_KEY.
 * No-ops if a Person with this key already exists.
 */
export async function ensureBotPerson(apiKey: string, agentId: string): Promise<void> {
  const session = getSession();
  try {
    const now = new Date().toISOString();
    const hashedKey = hashApiKey(apiKey);
    await session.run(
      `MERGE (p:Person {api_key: $api_key})
       ON CREATE SET
         p.person_id    = randomUUID(),
         p.name         = $name,
         p.aliases      = [$name],
         p.provisional  = false,
         p.actor_type   = 'bot',
         p.created_at   = $now,
         p.last_active_at = $now`,
      { api_key: hashedKey, name: agentId, now }
    );
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

export async function getDriftAlerts(projectId?: string): Promise<Array<{
  alert_id: string;
  decision_id: string;
  decision_summary: string;
  project_id: string;
  source: string;
  content: string;
  reason: string | null;
  actor: string;
  timestamp: string;
  resolution: string;
  confirmed_by_llm: boolean;
  fingerprint: string | null;
}>> {
  const session = getSession();
  try {
    const query = projectId
      ? `MATCH (a:DriftAlert {resolution: "pending"})-[:CHALLENGES]->(d:Decision)
         WHERE a.project_id = $project_id
            OR (a.project_id IS NULL AND (d)-[:EXTRACTED_FROM]->(:Event {project_id: $project_id}))
         RETURN a.alert_id AS alert_id,
                d.decision_id AS decision_id,
                d.summary AS decision_summary,
                coalesce(a.project_id, $project_id) AS project_id,
                a.source AS source,
                a.content AS content,
                a.reason AS reason,
                a.actor AS actor,
                a.timestamp AS timestamp,
                a.resolution AS resolution,
                a.confirmed_by_llm AS confirmed_by_llm,
                a.fingerprint AS fingerprint
         ORDER BY a.timestamp DESC`
      : `MATCH (a:DriftAlert {resolution: "pending"})
         MATCH (a)-[:CHALLENGES]->(d:Decision)
         RETURN a.alert_id AS alert_id,
                d.decision_id AS decision_id,
                d.summary AS decision_summary,
                a.project_id AS project_id,
                a.source AS source,
                a.content AS content,
                a.reason AS reason,
                a.actor AS actor,
                a.timestamp AS timestamp,
                a.resolution AS resolution,
                a.confirmed_by_llm AS confirmed_by_llm,
                a.fingerprint AS fingerprint
         ORDER BY a.timestamp DESC
         LIMIT 200`;
    const result = await session.run(query, { project_id: projectId ?? null });
    return result.records.map((r) => ({
      alert_id: r.get("alert_id") as string,
      decision_id: r.get("decision_id") as string,
      decision_summary: r.get("decision_summary") as string,
      project_id: r.get("project_id") as string,
      source: r.get("source") as string,
      content: r.get("content") as string,
      reason: (r.get("reason") as string | null) ?? null,
      actor: r.get("actor") as string,
      timestamp: r.get("timestamp") as string,
      resolution: r.get("resolution") as string,
      confirmed_by_llm: r.get("confirmed_by_llm") as boolean,
      fingerprint: r.get("fingerprint") as string | null,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Cross-project drift alerts scoped to the projects the actor is a member of.
 * Used by the multi-project dashboard when no project_id is specified — ensures
 * a user only sees alerts for their own projects, never other tenants'.
 */
export async function getDriftAlertsForActor(personId: string): Promise<Array<{
  alert_id: string;
  decision_id: string;
  decision_summary: string;
  project_id: string;
  source: string;
  content: string;
  reason: string | null;
  actor: string;
  timestamp: string;
  resolution: string;
  confirmed_by_llm: boolean;
  fingerprint: string | null;
}>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (:Person {person_id: $person_id})-[:MEMBER_OF]->(proj:Project)
       WITH collect(proj.project_id) AS allowed_projects
       MATCH (a:DriftAlert {resolution: "pending"})
       WHERE a.project_id IN allowed_projects
       MATCH (a)-[:CHALLENGES]->(d:Decision)
       RETURN a.alert_id AS alert_id,
              d.decision_id AS decision_id,
              d.summary AS decision_summary,
              a.project_id AS project_id,
              a.source AS source,
              a.content AS content,
              a.reason AS reason,
              a.actor AS actor,
              a.timestamp AS timestamp,
              a.resolution AS resolution,
              a.confirmed_by_llm AS confirmed_by_llm,
              a.fingerprint AS fingerprint
       ORDER BY a.timestamp DESC
       LIMIT 200`,
      { person_id: personId }
    );
    return result.records.map((r) => ({
      alert_id: r.get("alert_id") as string,
      decision_id: r.get("decision_id") as string,
      decision_summary: r.get("decision_summary") as string,
      project_id: r.get("project_id") as string,
      source: r.get("source") as string,
      content: r.get("content") as string,
      reason: (r.get("reason") as string | null) ?? null,
      actor: r.get("actor") as string,
      timestamp: r.get("timestamp") as string,
      resolution: r.get("resolution") as string,
      confirmed_by_llm: r.get("confirmed_by_llm") as boolean,
      fingerprint: r.get("fingerprint") as string | null,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Return the project_id for a given DriftAlert, or null if not found.
 * Used for ownership checks on alert resolution.
 */
export async function getAlertProjectId(alertId: string): Promise<string | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (a:DriftAlert {alert_id: $alert_id})
       RETURN a.project_id AS project_id LIMIT 1`,
      { alert_id: alertId }
    );
    return result.records[0]?.get("project_id") as string ?? null;
  } finally {
    await session.close();
  }
}

/**
 * Return the project_id for a given agent session event_id, or null if not found.
 * Used for ownership checks on session reads.
 */
export async function getSessionProjectId(eventId: string): Promise<string | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (e:Event {event_id: $event_id}) RETURN e.project_id AS project_id LIMIT 1`,
      { event_id: eventId }
    );
    return result.records[0]?.get("project_id") as string ?? null;
  } finally {
    await session.close();
  }
}

/**
 * List projects the actor is a member of, with health stats.
 * Scoped via MEMBER_OF edges — never leaks cross-tenant project data.
 */
export async function listProjectsForActor(personId: string, since?: string): Promise<Array<{
  project_id: string;
  event_count: number;
  decision_count: number;
  pending_drift_count: number;
  pending_tasks_count: number;
  sessions_since: number;
  decisions_since: number;
  last_event_at: string | null;
  last_decision_logged_at: string | null;
  last_session_agent_id: string | null;
  last_session_operator_name: string | null;
  last_session_work_summary: string | null;
  active_sources: string[];
}>> {
  const session = getSession();
  const sinceTs = since ?? "1970-01-01T00:00:00.000Z";
  try {
    const result = await session.run(
      `MATCH (:Person {person_id: $person_id})-[:MEMBER_OF]->(proj:Project)
       MATCH (e:Event {project_id: proj.project_id})
       WITH proj.project_id AS pid, count(e) AS event_count, max(e.timestamp) AS last_event_at
       OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(e2:Event {project_id: pid})
       WITH pid, event_count, last_event_at, count(DISTINCT d) AS decision_count,
            max(d.valid_from) AS last_decision_logged_at
       OPTIONAL MATCH (a:DriftAlert {resolution: "pending"})-[:CHALLENGES]->
                      (:Decision)-[:EXTRACTED_FROM]->(e3:Event {project_id: pid})
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            count(DISTINCT a) AS pending_drift_count
       OPTIONAL MATCH (t:FollowUpTask {project_id: pid, status: "open"})
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, count(t) AS pending_tasks_count
       OPTIONAL MATCH (es:Event {project_id: pid, source: "agent"})
       WHERE es.timestamp >= $since
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, count(es) AS sessions_since
       OPTIONAL MATCH (ds:Decision)-[:EXTRACTED_FROM]->(esc:Event {project_id: pid, source: "agent"})
       WHERE esc.timestamp >= $since
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since,
            count(DISTINCT ds) AS decisions_since
       OPTIONAL MATCH (esrc:Event {project_id: pid})
       WHERE esrc.timestamp >= $since
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since, decisions_since,
            collect(DISTINCT esrc.source) AS active_sources
       OPTIONAL MATCH (latest_agent:Event {project_id: pid, source: "agent"})
       OPTIONAL MATCH (latest_agent)-[:AUTHORED_BY]->(latest_person:Person)
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since, decisions_since,
            active_sources, latest_agent, latest_person
       ORDER BY latest_agent.timestamp DESC
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since, decisions_since,
            active_sources,
            head(collect(latest_person.name)) AS last_session_agent_id,
            head(collect(latest_agent.operator_name)) AS last_session_operator_name,
            head(collect(latest_agent.raw_content)) AS last_session_raw
       RETURN pid AS project_id,
              event_count,
              last_event_at,
              decision_count,
              last_decision_logged_at,
              pending_drift_count,
              pending_tasks_count,
              sessions_since,
              decisions_since,
              active_sources,
              last_session_agent_id,
              last_session_operator_name,
              last_session_raw
       ORDER BY last_event_at DESC`,
      { person_id: personId, since: sinceTs }
    );
    return result.records.map((r) => {
      const raw: string = (r.get("last_session_raw") as string) ?? "";
      const workMatch = raw.match(/Work completed:\s*(.+?)(?:\n|$)/);
      return {
        project_id:                  r.get("project_id") as string,
        event_count:                 toNum(r.get("event_count")),
        decision_count:              toNum(r.get("decision_count")),
        pending_drift_count:         toNum(r.get("pending_drift_count")),
        pending_tasks_count:         toNum(r.get("pending_tasks_count")),
        sessions_since:              toNum(r.get("sessions_since")),
        decisions_since:             toNum(r.get("decisions_since")),
        last_event_at:               (r.get("last_event_at") as string | null) ?? null,
        last_decision_logged_at:     (r.get("last_decision_logged_at") as string | null) ?? null,
        last_session_agent_id:       (r.get("last_session_agent_id") as string | null) ?? null,
        last_session_operator_name:  (r.get("last_session_operator_name") as string | null) ?? null,
        last_session_work_summary:   workMatch ? workMatch[1].trim() : (raw ? raw.slice(0, 120) : null),
        active_sources:              ((r.get("active_sources") as string[]) ?? []).filter(Boolean),
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * Count active seats scoped to projects the actor is a member of.
 * Prevents cross-tenant seat count leakage on the billing endpoint.
 */
export async function countActiveSeatsForActor(personId: string, since: string): Promise<number> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (:Person {person_id: $person_id})-[:MEMBER_OF]->(proj:Project)
       MATCH (p:Person)-[:MEMBER_OF]->(proj)
       WHERE p.last_active_at >= $since AND p.email IS NOT NULL
       RETURN count(DISTINCT p) AS seats`,
      { person_id: personId, since }
    );
    return toNum(result.records[0]?.get("seats"));
  } finally {
    await session.close();
  }
}

/**
 * List all projects that have at least one Event, with health stats.
 * Used by the multi-project overview (Profile B dashboard).
 */
export async function listProjects(since?: string): Promise<Array<{
  project_id: string;
  event_count: number;
  decision_count: number;
  pending_drift_count: number;
  pending_tasks_count: number;
  sessions_since: number;
  decisions_since: number;
  last_event_at: string | null;
  last_decision_logged_at: string | null;
  last_session_agent_id: string | null;
  last_session_operator_name: string | null;
  last_session_work_summary: string | null;
  active_sources: string[];
}>> {
  const session = getSession();
  // Use epoch as sentinel when no since is provided — avoids conditional Cypher
  const sinceTs = since ?? "1970-01-01T00:00:00.000Z";
  try {
    const result = await session.run(
      `MATCH (e:Event)
       WITH e.project_id AS pid, count(e) AS event_count, max(e.timestamp) AS last_event_at
       OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(e2:Event {project_id: pid})
       WITH pid, event_count, last_event_at, count(DISTINCT d) AS decision_count,
            max(d.valid_from) AS last_decision_logged_at
       OPTIONAL MATCH (a:DriftAlert {resolution: "pending"})-[:CHALLENGES]->
                      (:Decision)-[:EXTRACTED_FROM]->(e3:Event {project_id: pid})
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            count(DISTINCT a) AS pending_drift_count
       OPTIONAL MATCH (t:FollowUpTask {project_id: pid, status: "open"})
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, count(t) AS pending_tasks_count
       OPTIONAL MATCH (es:Event {project_id: pid, source: "agent"})
       WHERE es.timestamp >= $since
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, count(es) AS sessions_since
       OPTIONAL MATCH (ds:Decision)-[:EXTRACTED_FROM]->(esc:Event {project_id: pid, source: "agent"})
       WHERE esc.timestamp >= $since
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since,
            count(DISTINCT ds) AS decisions_since
       OPTIONAL MATCH (esrc:Event {project_id: pid})
       WHERE esrc.timestamp >= $since
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since, decisions_since,
            collect(DISTINCT esrc.source) AS active_sources
       OPTIONAL MATCH (latest_agent:Event {project_id: pid, source: "agent"})
       OPTIONAL MATCH (latest_agent)-[:AUTHORED_BY]->(latest_person:Person)
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since, decisions_since,
            active_sources, latest_agent, latest_person
       ORDER BY latest_agent.timestamp DESC
       WITH pid, event_count, last_event_at, decision_count, last_decision_logged_at,
            pending_drift_count, pending_tasks_count, sessions_since, decisions_since,
            active_sources,
            head(collect(latest_person.name)) AS last_session_agent_id,
            head(collect(latest_agent.operator_name)) AS last_session_operator_name,
            head(collect(latest_agent.raw_content)) AS last_session_raw
       RETURN pid AS project_id,
              event_count,
              last_event_at,
              decision_count,
              last_decision_logged_at,
              pending_drift_count,
              pending_tasks_count,
              sessions_since,
              decisions_since,
              active_sources,
              last_session_agent_id,
              last_session_operator_name,
              last_session_raw
       ORDER BY last_event_at DESC`,
      { since: sinceTs }
    );
    return result.records.map((r) => {
      const raw: string = (r.get("last_session_raw") as string) ?? "";
      const workMatch = raw.match(/Work completed:\s*(.+?)(?:\n|$)/);
      return {
        project_id:                  r.get("project_id") as string,
        event_count:                 toNum(r.get("event_count")),
        decision_count:              toNum(r.get("decision_count")),
        pending_drift_count:         toNum(r.get("pending_drift_count")),
        pending_tasks_count:         toNum(r.get("pending_tasks_count")),
        sessions_since:              toNum(r.get("sessions_since")),
        decisions_since:             toNum(r.get("decisions_since")),
        last_event_at:               (r.get("last_event_at") as string | null) ?? null,
        last_decision_logged_at:     (r.get("last_decision_logged_at") as string | null) ?? null,
        last_session_agent_id:       (r.get("last_session_agent_id") as string | null) ?? null,
        last_session_operator_name:  (r.get("last_session_operator_name") as string | null) ?? null,
        last_session_work_summary:   workMatch ? workMatch[1].trim() : (raw ? raw.slice(0, 120) : null),
        active_sources:              ((r.get("active_sources") as string[]) ?? []).filter(Boolean),
      };
    });
  } finally {
    await session.close();
  }
}

/**
 * List agent sessions for a project — Events where source="agent", newest first.
 * Each agent POST /brain/agent-log creates exactly one Event, so one row = one session.
 */
function deriveAgentType(agentId: string): "coding" | "infra" | "other" {
  const id = agentId.toLowerCase();
  if (/migration|postgres|cassandra|kafka|redis|mysql|mongo|dynamo|database|db-|schema|infra/.test(id)) {
    return "infra";
  }
  if (/claude|cursor|copilot|codex|aider|devin|cody/.test(id)) {
    return "coding";
  }
  return "other";
}

export async function listAgentSessions(projectId: string): Promise<Array<{
  event_id: string;
  agent_id: string;
  agent_type: "coding" | "infra" | "other";
  operator_id: string | null;
  operator_name: string | null;
  timestamp: string;
  decision_count: number;
  decisions_with_alternatives: number;
  work_summary: string;
}>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (e:Event {project_id: $project_id, source: "agent"})
       MATCH (e)-[:AUTHORED_BY]->(p:Person)
       OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(e)
       WITH e, p,
            count(d) AS decision_count,
            sum(CASE WHEN size(coalesce(d.alternatives_considered, [])) > 0 THEN 1 ELSE 0 END) AS decisions_with_alternatives
       RETURN e.event_id AS event_id,
              p.name AS agent_id,
              e.operator_id AS operator_id,
              e.operator_name AS operator_name,
              e.timestamp AS timestamp,
              decision_count,
              decisions_with_alternatives,
              e.raw_content AS raw_content
       ORDER BY e.timestamp DESC
       LIMIT 100`,
      { project_id: projectId }
    );
    return result.records.map((r) => {
      const raw: string = (r.get("raw_content") as string) ?? "";
      const workMatch = raw.match(/Work completed:\s*(.+?)(?:\n|$)/);
      const agentId = (r.get("agent_id") as string) ?? "unknown";
      return {
        event_id:                    r.get("event_id") as string,
        agent_id:                    agentId,
        agent_type:                  deriveAgentType(agentId),
        operator_id:                 (r.get("operator_id") as string | null) ?? null,
        operator_name:               (r.get("operator_name") as string | null) ?? null,
        timestamp:                   r.get("timestamp") as string,
        decision_count:              toNum(r.get("decision_count")),
        decisions_with_alternatives: toNum(r.get("decisions_with_alternatives")),
        work_summary:                workMatch ? workMatch[1].trim() : raw.slice(0, 120),
      };
    });
  } finally {
    await session.close();
  }
}

export async function countProjectDecisions(projectId: string): Promise<number> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision {project_id: $project_id}) RETURN count(d) AS n`,
      { project_id: projectId }
    );
    return toNum(result.records[0]?.get("n") ?? 0);
  } finally {
    await session.close();
  }
}

export async function countRecentDecisions(projectId: string, since: string): Promise<number> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision {project_id: $project_id})
       WHERE d.valid_from >= $since
       RETURN count(d) AS n`,
      { project_id: projectId, since }
    );
    return toNum(result.records[0]?.get("n") ?? 0);
  } finally {
    await session.close();
  }
}

/**
 * Return full detail for a single agent session by event_id, including
 * every decision extracted from it. Used for pre-merge audit.
 */
export async function getAgentSession(eventId: string): Promise<{
  event_id: string;
  agent_id: string;
  agent_type: "coding" | "infra" | "other";
  operator_id: string | null;
  operator_name: string | null;
  project_id: string;
  timestamp: string;
  raw_content: string;
  decisions: Array<{
    decision_id: string;
    summary: string;
    rationale: string | null;
    alternatives_considered: string[];
    confidence: string;
    status: string;
  }>;
  preflight_checks: Array<{
    check_id: string;
    change_description: string;
    overall_risk: string;
    summary: string;
    affected_decision_count: number;
    checked_at: string;
  }>;
  brain_query_results_count: number | null;
} | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (e:Event {event_id: $event_id, source: "agent"})
       MATCH (e)-[:AUTHORED_BY]->(p:Person)
       OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(e)
       OPTIONAL MATCH (c:PreflightCheck)-[:FOR_SESSION]->(e)
       // Look for a QueryLog from this project within 30 min before the session timestamp
       OPTIONAL MATCH (ql:QueryLog {project_id: e.project_id})
         WHERE datetime(ql.timestamp) >= datetime(e.timestamp) - duration('PT30M')
           AND datetime(ql.timestamp) <= datetime(e.timestamp) + duration('PT5M')
       RETURN e.event_id AS event_id,
              p.name AS agent_id,
              e.operator_id AS operator_id,
              e.operator_name AS operator_name,
              e.project_id AS project_id,
              e.timestamp AS timestamp,
              e.raw_content AS raw_content,
              collect(DISTINCT CASE WHEN d IS NOT NULL THEN {
                decision_id: d.decision_id,
                summary: d.summary,
                rationale: d.rationale,
                alternatives_considered: d.alternatives_considered,
                confidence: d.confidence,
                status: d.status
              } END) AS decisions,
              collect(DISTINCT CASE WHEN c IS NOT NULL THEN {
                check_id: c.check_id,
                change_description: c.change_description,
                overall_risk: c.overall_risk,
                summary: c.summary,
                affected_decision_count: c.affected_decision_count,
                checked_at: c.checked_at
              } END) AS preflight_checks,
              max(ql.results_count) AS brain_query_results_count`,
      { event_id: eventId }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    const agentId = (r.get("agent_id") as string) ?? "unknown";
    const rawQueryCount = r.get("brain_query_results_count");
    return {
      event_id:         r.get("event_id") as string,
      agent_id:         agentId,
      agent_type:       deriveAgentType(agentId),
      operator_id:      (r.get("operator_id") as string | null) ?? null,
      operator_name:    (r.get("operator_name") as string | null) ?? null,
      project_id:       r.get("project_id") as string,
      timestamp:        r.get("timestamp") as string,
      raw_content:      (r.get("raw_content") as string) ?? "",
      decisions:        ((r.get("decisions") as Array<Record<string, unknown>>) ?? [])
        .filter(Boolean)
        .map((d) => ({
          decision_id:             d.decision_id as string,
          summary:                 d.summary as string,
          rationale:               (d.rationale as string | null) ?? null,
          alternatives_considered: (d.alternatives_considered as string[] | null) ?? [],
          confidence:              (d.confidence as string) ?? "medium",
          status:                  (d.status as string) ?? "confirmed",
        })),
      preflight_checks: ((r.get("preflight_checks") as Array<Record<string, unknown>>) ?? [])
        .filter(Boolean)
        .map((c) => ({
          check_id:               c.check_id as string,
          change_description:     c.change_description as string,
          overall_risk:           c.overall_risk as string,
          summary:                c.summary as string,
          affected_decision_count: toNum(c.affected_decision_count),
          checked_at:             c.checked_at as string,
        })),
      brain_query_results_count: rawQueryCount != null ? toNum(rawQueryCount) : null,
    };
  } finally {
    await session.close();
  }
}

/**
 * Write a QueryLog node when brain_query is called. Fire-and-forget.
 * getAgentSession looks for QueryLogs in the 30-minute window before session start
 * to populate brain_query_results_count.
 */
export async function writeQueryLog(params: {
  project_id: string;
  results_count: number;
  timestamp: string;
}): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `CREATE (:QueryLog {
         log_id:        randomUUID(),
         project_id:    $project_id,
         results_count: $results_count,
         timestamp:     $timestamp
       })`,
      params
    );
  } finally {
    await session.close();
  }
}

/**
 * Persist a preflight impact check and link it to the agent session Event node.
 * Called when brain_analyze_impact is invoked with a session_id.
 * The check is linked via [:FOR_SESSION] so getAgentSession can retrieve it.
 */
export async function persistPreflightCheck(params: {
  check_id: string;
  event_id: string;
  change_description: string;
  overall_risk: string;
  summary: string;
  affected_decision_count: number;
  project_id: string;
  checked_at: string;
}): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (e:Event {event_id: $event_id, source: "agent"})
       CREATE (c:PreflightCheck {
         check_id: $check_id,
         change_description: $change_description,
         overall_risk: $overall_risk,
         summary: $summary,
         affected_decision_count: $affected_decision_count,
         project_id: $project_id,
         checked_at: $checked_at
       })
       CREATE (c)-[:FOR_SESSION]->(e)`,
      params
    );
  } finally {
    await session.close();
  }
}

/**
 * Resolve an event actor to a canonical person_id UUID.
 * Strategy per source:
 *   github  → MERGE on github_login (links to OAuth Person if they've logged in)
 *   slack/jira → MATCH on aliases first, then fall through to keyed stub
 *   meeting/agent/unknown → MERGE on display_key "source:actor_id"
 *
 * Always returns a stable UUID — either the canonical person_id or a provisional one
 * that gets promoted when the user logs in via OAuth.
 */
export async function resolveOrCreateActorPerson(params: {
  actor_id: string;
  actor_name: string;
  actor_type: string;
  source: string;
}): Promise<string> {
  const session = getSession();
  try {
    const now = new Date().toISOString();

    if (params.source === "github") {
      // Merge on github_login. If an email-keyed canonical person already has this
      // github_login, MERGE finds them — no duplicate created.
      const result = await session.run(
        `MERGE (p:Person {github_login: $actor_id})
         ON CREATE SET
           p.person_id  = randomUUID(),
           p.name       = $name,
           p.provisional = true,
           p.aliases    = [$actor_id],
           p.created_at = $now,
           p.last_active_at = $now
         ON MATCH SET
           p.name           = coalesce(p.name, $name),
           p.last_active_at = $now
         RETURN p.person_id AS person_id`,
        { actor_id: params.actor_id, name: params.actor_name, now }
      );
      return result.records[0].get("person_id") as string;
    }

    if (params.source === "slack") {
      // Merge on slack_user_id — stable cross-session identifier, not display name
      const result = await session.run(
        `MERGE (p:Person {slack_user_id: $actor_id})
         ON CREATE SET
           p.person_id   = randomUUID(),
           p.name        = $name,
           p.provisional = true,
           p.aliases     = [$actor_id],
           p.created_at  = $now,
           p.last_active_at = $now
         ON MATCH SET
           p.name           = coalesce(p.name, $name),
           p.last_active_at = $now
         RETURN p.person_id AS person_id`,
        { actor_id: params.actor_id, name: params.actor_name, now }
      );
      return result.records[0].get("person_id") as string;
    }

    if (params.source === "jira") {
      // Merge on jira_user_id — Jira account ID or username
      const result = await session.run(
        `MERGE (p:Person {jira_user_id: $actor_id})
         ON CREATE SET
           p.person_id   = randomUUID(),
           p.name        = $name,
           p.provisional = true,
           p.aliases     = [$actor_id],
           p.created_at  = $now,
           p.last_active_at = $now
         ON MATCH SET
           p.name           = coalesce(p.name, $name),
           p.last_active_at = $now
         RETURN p.person_id AS person_id`,
        { actor_id: params.actor_id, name: params.actor_name, now }
      );
      return result.records[0].get("person_id") as string;
    }

    // Fallback for meeting speakers, agents, and unknown sources
    const displayKey = `${params.source}:${params.actor_id}`;
    const result = await session.run(
      `MERGE (p:Person {display_key: $display_key})
       ON CREATE SET
         p.person_id   = randomUUID(),
         p.name        = $name,
         p.type        = $type,
         p.provisional = true,
         p.aliases     = [],
         p.created_at  = $now,
         p.last_active_at = $now
       ON MATCH SET
         p.name           = coalesce(p.name, $name),
         p.last_active_at = $now
       RETURN p.person_id AS person_id`,
      { display_key: displayKey, name: params.actor_name, type: params.actor_type, now }
    );
    return result.records[0].get("person_id") as string;
  } finally {
    await session.close();
  }
}

/**
 * Explicitly link cross-source identities to a single canonical Person node.
 * Finds all Person nodes that match any provided identifier, picks the best
 * candidate as primary (prefer email-keyed > earliest created_at), re-points
 * all Event relationships from duplicates to primary, then deletes duplicates.
 *
 * Safe to call multiple times — idempotent when all identifiers already live
 * on the same node.
 */
export async function linkPersonIdentities(params: {
  github_login?: string;
  slack_user_id?: string;
  jira_user_id?: string;
  email?: string;
  name?: string;
}): Promise<{ person_id: string; merged_count: number }> {
  const { github_login, slack_user_id, jira_user_id, email, name } = params;

  const conditions: string[] = [];
  if (github_login)  conditions.push("p.github_login = $github_login");
  if (slack_user_id) conditions.push("p.slack_user_id = $slack_user_id");
  if (jira_user_id)  conditions.push("p.jira_user_id = $jira_user_id");
  if (email)         conditions.push("p.email = $email");
  if (conditions.length === 0) throw new Error("At least one identifier is required");

  const session = getSession();
  try {
    const now = new Date().toISOString();

    // Find all candidate nodes ordered: email-keyed first, then by created_at asc
    const findResult = await session.run(
      `MATCH (p:Person) WHERE ${conditions.join(" OR ")}
       RETURN p
       ORDER BY
         CASE WHEN p.email IS NOT NULL THEN 0 ELSE 1 END,
         p.created_at ASC`,
      { github_login: github_login ?? null, slack_user_id: slack_user_id ?? null,
        jira_user_id: jira_user_id ?? null, email: email ?? null }
    );

    const candidates = findResult.records.map(
      (r) => r.get("p").properties as Record<string, unknown>
    );

    let primaryId: string;

    if (candidates.length === 0) {
      // No existing node — create one with all provided identifiers
      const cr = await session.run(
        `CREATE (p:Person {
           person_id:    randomUUID(),
           name:         $name,
           email:        $email,
           github_login: $github_login,
           slack_user_id: $slack_user_id,
           jira_user_id: $jira_user_id,
           aliases:      [],
           provisional:  false,
           created_at:   $now,
           last_active_at: $now
         }) RETURN p.person_id AS person_id`,
        { name: name ?? "Unknown", email: email ?? null,
          github_login: github_login ?? null, slack_user_id: slack_user_id ?? null,
          jira_user_id: jira_user_id ?? null, now }
      );
      return { person_id: cr.records[0].get("person_id") as string, merged_count: 0 };
    }

    primaryId = candidates[0].person_id as string;

    // Update primary with all provided identifiers (coalesce — don't overwrite existing)
    await session.run(
      `MATCH (p:Person {person_id: $primary_id})
       SET p.github_login  = coalesce($github_login,  p.github_login),
           p.slack_user_id = coalesce($slack_user_id, p.slack_user_id),
           p.jira_user_id  = coalesce($jira_user_id,  p.jira_user_id),
           p.email         = coalesce($email,         p.email),
           p.name          = coalesce($name,          p.name),
           p.provisional   = false,
           p.last_active_at = $now`,
      { primary_id: primaryId, github_login: github_login ?? null,
        slack_user_id: slack_user_id ?? null, jira_user_id: jira_user_id ?? null,
        email: email ?? null, name: name ?? null, now }
    );

    // Merge all duplicate nodes into primary
    const secondaries = candidates.slice(1);
    for (const secondary of secondaries) {
      const secondaryId = secondary.person_id as string;

      // Re-point AUTHORED_BY edges to primary, then detach-delete the duplicate
      await session.run(
        `MATCH (e:Event)-[r:AUTHORED_BY]->(stub:Person {person_id: $secondary_id})
         MATCH (primary:Person {person_id: $primary_id})
         MERGE (e)-[:AUTHORED_BY]->(primary)
         DELETE r`,
        { secondary_id: secondaryId, primary_id: primaryId }
      );

      // Copy any identifiers the primary doesn't yet have, then delete stub
      await session.run(
        `MATCH (primary:Person {person_id: $primary_id})
         MATCH (stub:Person {person_id: $secondary_id})
         SET primary.github_login  = coalesce(primary.github_login,  stub.github_login),
             primary.slack_user_id = coalesce(primary.slack_user_id, stub.slack_user_id),
             primary.jira_user_id  = coalesce(primary.jira_user_id,  stub.jira_user_id),
             primary.email         = coalesce(primary.email,         stub.email),
             primary.aliases = primary.aliases +
               [x IN coalesce(stub.aliases, []) WHERE NOT x IN primary.aliases]
         DETACH DELETE stub`,
        { primary_id: primaryId, secondary_id: secondaryId }
      );
    }

    return { person_id: primaryId, merged_count: secondaries.length };
  } finally {
    await session.close();
  }
}

/**
 * List all Person nodes that have authored at least one Event in the given project.
 * Returns each person with their known source identifiers and event count.
 */
export async function listPeopleInProject(projectId: string): Promise<Array<{
  person_id: string;
  name: string;
  email?: string;
  github_login?: string;
  slack_user_id?: string;
  jira_user_id?: string;
  provisional: boolean;
  event_count: number;
}>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (e:Event {project_id: $project_id})-[:AUTHORED_BY]->(p:Person)
       RETURN p, count(e) AS event_count
       ORDER BY p.name ASC`,
      { project_id: projectId }
    );
    return result.records.map((r) => {
      const p = r.get("p").properties as Record<string, unknown>;
      return {
        person_id:    p.person_id as string,
        name:         (p.name as string) ?? "Unknown",
        email:        p.email as string | undefined,
        github_login: p.github_login as string | undefined,
        slack_user_id: p.slack_user_id as string | undefined,
        jira_user_id: p.jira_user_id as string | undefined,
        provisional:  (p.provisional as boolean) ?? true,
        event_count:  (r.get("event_count") as number) ?? 0,
      };
    });
  } finally {
    await session.close();
  }
}

// ── Follow-up tasks ───────────────────────────────────────────────────────────

/**
 * Create a FollowUpTask from a drift alert resolution of "reopen".
 * Fetches the alert's linked decision and event context, creates a Task node,
 * and links it: (Task)-[:ADDRESSES]->(Decision).
 * Returns the new task_id and project_id, or null if the alert is not found.
 */
export async function createFollowUpTaskFromAlert(alertId: string): Promise<{
  task_id: string;
  project_id: string;
  title: string;
  suggested_owner: string;
} | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (a:DriftAlert {alert_id: $alert_id})-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       CREATE (t:FollowUpTask {
         task_id:       randomUUID(),
         project_id:    e.project_id,
         title:         'Reopen: ' + d.summary,
         description:   coalesce(a.reason, left(a.content, 200)),
         suggested_owner: a.actor,
         source:        'drift_reopen',
         status:        'open',
         requires_approval: true,
         decision_id:   d.decision_id,
         created_at:    $now
       })
       CREATE (t)-[:ADDRESSES]->(d)
       RETURN t.task_id AS task_id, e.project_id AS project_id,
              t.title AS title, a.actor AS suggested_owner`,
      { alert_id: alertId, now: new Date().toISOString() }
    );
    if (result.records.length === 0) return null;
    const r = result.records[0];
    return {
      task_id:         r.get("task_id") as string,
      project_id:      r.get("project_id") as string,
      title:           r.get("title") as string,
      suggested_owner: r.get("suggested_owner") as string,
    };
  } finally {
    await session.close();
  }
}

/**
 * List all FollowUpTask nodes for a project, with their linked decision summary.
 */
export async function getFollowUpTasks(projectId: string, status?: string): Promise<Array<{
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  suggested_owner?: string;
  requires_approval: boolean;
  source: string;
  status: string;
  decision_id: string;
  decision_summary: string;
  created_at: string;
}>> {
  const session = getSession();
  try {
    const whereClause = status
      ? "WHERE t.project_id = $project_id AND t.status = $status"
      : "WHERE t.project_id = $project_id";
    const result = await session.run(
      `MATCH (t:FollowUpTask)-[:ADDRESSES]->(d:Decision)
       ${whereClause}
       RETURN t, d.summary AS decision_summary
       ORDER BY t.created_at DESC`,
      { project_id: projectId, status: status ?? null }
    );
    return result.records.map((r) => {
      const t = r.get("t").properties as Record<string, unknown>;
      return {
        task_id:          t.task_id as string,
        project_id:       t.project_id as string,
        title:            t.title as string,
        description:      t.description as string,
        suggested_owner:  t.suggested_owner as string | undefined,
        requires_approval: (t.requires_approval as boolean) ?? true,
        source:           t.source as string,
        status:           t.status as string,
        decision_id:      t.decision_id as string,
        decision_summary: r.get("decision_summary") as string,
        created_at:       t.created_at as string,
      };
    });
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

export async function addPersonToProject(person_id: string, project_id: string): Promise<void> {
  const session = getSession();
  try {
    await session.run(
      `MATCH (p:Person {person_id: $person_id})
       MERGE (proj:Project {project_id: $project_id})
       MERGE (p)-[:MEMBER_OF]->(proj)`,
      { person_id, project_id }
    );
  } finally {
    await session.close();
  }
}

export async function checkPersonInProject(person_id: string, project_id: string): Promise<boolean> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (:Person {person_id: $person_id})-[:MEMBER_OF]->(:Project {project_id: $project_id})
       RETURN 1 LIMIT 1`,
      { person_id, project_id }
    );
    return result.records.length > 0;
  } finally {
    await session.close();
  }
}

export async function listDecisions(projectId: string, limit = 50): Promise<Array<{
  decision_id: string;
  summary: string;
  rationale: string | null;
  confidence: string;
  alternatives_considered: string[];
  valid_from: string;
  agent_id: string;
  operator_name: string | null;
  event_id: string;
  event_source: string;
  has_lineage: boolean;
}>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event {project_id: $project_id})
       MATCH (e)-[:AUTHORED_BY]->(p:Person)
       OPTIONAL MATCH (d)-[:SUPERSEDES]->(older_d)
       OPTIONAL MATCH (newer_d)-[:SUPERSEDES]->(d)
       RETURN d.decision_id AS decision_id,
              d.summary AS summary,
              d.rationale AS rationale,
              coalesce(d.confidence, 'medium') AS confidence,
              coalesce(d.alternatives_considered, []) AS alternatives_considered,
              coalesce(d.valid_from, e.timestamp) AS valid_from,
              p.name AS agent_id,
              e.operator_name AS operator_name,
              e.event_id AS event_id,
              coalesce(e.source, 'agent') AS event_source,
              (older_d IS NOT NULL OR newer_d IS NOT NULL OR
               EXISTS { MATCH (:DriftAlert {resolution: "pending"})-[:CHALLENGES]->(d) }) AS has_lineage
       ORDER BY valid_from DESC
       LIMIT $limit`,
      { project_id: projectId, limit: neo4j.int(limit) }
    );
    return result.records.map((r) => ({
      decision_id:             r.get("decision_id") as string,
      summary:                 (r.get("summary") as string) ?? "",
      rationale:               (r.get("rationale") as string | null) ?? null,
      confidence:              (r.get("confidence") as string) ?? "medium",
      alternatives_considered: (r.get("alternatives_considered") as string[]) ?? [],
      valid_from:              r.get("valid_from") as string,
      agent_id:                (r.get("agent_id") as string) ?? "unknown",
      operator_name:           (r.get("operator_name") as string | null) ?? null,
      event_id:                r.get("event_id") as string,
      event_source:            (r.get("event_source") as string) ?? "agent",
      has_lineage:             (r.get("has_lineage") as boolean) ?? false,
    }));
  } finally {
    await session.close();
  }
}

/**
 * Walk the full SUPERSEDES chain for a decision (up to 10 hops each direction)
 * and return all decisions in chronological order, each with their drift alerts.
 * Used to build the decision evolution timeline on the detail page.
 */
export async function getDecisionChain(decisionId: string): Promise<Array<{
  decision_id: string;
  summary: string;
  rationale: string | null;
  valid_from: string;
  confidence: string;
  status: string;
  supersedes_reasoning: string | null;
  drift_alerts: Array<{
    alert_id: string;
    reason: string | null;
    content: string;
    resolution: string;
    resolution_reason: string | null;
    timestamp: string;
    source: string;
  }>;
}>> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (target:Decision {decision_id: $decision_id})
       OPTIONAL MATCH (target)-[:SUPERSEDES*1..10]->(older)
       OPTIONAL MATCH (newer)-[:SUPERSEDES*1..10]->(target)
       WITH target,
            [x IN collect(DISTINCT older) WHERE x IS NOT NULL] AS older_chain,
            [x IN collect(DISTINCT newer) WHERE x IS NOT NULL] AS newer_chain
       WITH older_chain + [target] + newer_chain AS chain
       UNWIND chain AS d
       WITH DISTINCT d
       OPTIONAL MATCH (d)-[sr:SUPERSEDES]->(prev_d:Decision)
       OPTIONAL MATCH (a:DriftAlert)-[:CHALLENGES]->(d)
       WITH d, sr, collect(DISTINCT CASE WHEN a.alert_id IS NOT NULL THEN {
         alert_id:          a.alert_id,
         reason:            a.reason,
         content:           a.content,
         resolution:        a.resolution,
         resolution_reason: a.resolution_reason,
         timestamp:         a.timestamp,
         source:            a.source
       } END) AS raw_alerts
       RETURN d.decision_id AS decision_id,
              d.summary AS summary,
              d.rationale AS rationale,
              d.valid_from AS valid_from,
              coalesce(d.confidence, 'medium') AS confidence,
              coalesce(d.status, 'confirmed') AS status,
              sr.reasoning AS supersedes_reasoning,
              raw_alerts
       ORDER BY d.valid_from ASC`,
      { decision_id: decisionId }
    );
    return result.records.map((r) => ({
      decision_id:          r.get("decision_id") as string,
      summary:              (r.get("summary") as string) ?? "",
      rationale:            (r.get("rationale") as string | null) ?? null,
      valid_from:           r.get("valid_from") as string,
      confidence:           (r.get("confidence") as string) ?? "medium",
      status:               (r.get("status") as string) ?? "confirmed",
      supersedes_reasoning: (r.get("supersedes_reasoning") as string | null) ?? null,
      drift_alerts: ((r.get("raw_alerts") as Array<Record<string, unknown>>) ?? [])
        .filter((a) => a && a.alert_id != null)
        .map((a) => ({
          alert_id:          a.alert_id as string,
          reason:            (a.reason as string | null) ?? null,
          content:           (a.content as string) ?? "",
          resolution:        (a.resolution as string) ?? "pending",
          resolution_reason: (a.resolution_reason as string | null) ?? null,
          timestamp:         (a.timestamp as string) ?? "",
          source:            (a.source as string) ?? "agent",
        })),
    }));
  } finally {
    await session.close();
  }
}

export async function getDecisionDetail(decisionId: string): Promise<{
  decision_id: string;
  summary: string;
  rationale: string | null;
  alternatives_considered: string[];
  confidence: string;
  status: string;
  valid_from: string;
  // Source event
  event_id: string;
  event_source: string;
  event_url: string | null;
  event_timestamp: string;
  agent_id: string;
  operator_name: string | null;
  project_id: string;
  // Drift alerts challenging this decision
  drift_alerts: Array<{
    alert_id: string;
    source: string;
    content: string;
    reason: string | null;
    actor: string;
    timestamp: string;
    resolution: string;
  }>;
  // Follow-up tasks created from drift on this decision
  follow_up_tasks: Array<{
    task_id: string;
    title: string;
    description: string | null;
    status: string;
    created_at: string;
  }>;
  // Lineage — what this decision replaced and what replaced it
  supersedes: { decision_id: string; summary: string; valid_from: string; reasoning: string | null } | null;
  superseded_by: { decision_id: string; summary: string; valid_from: string; reasoning: string | null } | null;
} | null> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (d:Decision {decision_id: $decision_id})-[:EXTRACTED_FROM]->(e:Event)
       MATCH (e)-[:AUTHORED_BY]->(p:Person)
       OPTIONAL MATCH (a:DriftAlert)-[:CHALLENGES]->(d)
       OPTIONAL MATCH (t:FollowUpTask)-[:ADDRESSES]->(d)
       OPTIONAL MATCH (d)-[sr:SUPERSEDES]->(older:Decision)
       OPTIONAL MATCH (newer:Decision)-[sn:SUPERSEDES]->(d)
       WITH d, e, p, older, newer,
            collect(DISTINCT {
              alert_id:   a.alert_id,
              source:     a.source,
              content:    a.content,
              reason:     a.reason,
              actor:      a.actor,
              timestamp:  a.timestamp,
              resolution: a.resolution
            }) AS raw_alerts,
            collect(DISTINCT {
              task_id:     t.task_id,
              title:       t.title,
              description: t.description,
              status:      t.status,
              created_at:  t.created_at
            }) AS raw_tasks
       RETURN d.decision_id          AS decision_id,
              d.summary              AS summary,
              d.rationale            AS rationale,
              coalesce(d.alternatives_considered, []) AS alternatives_considered,
              coalesce(d.confidence, 'medium')        AS confidence,
              coalesce(d.status, 'confirmed')         AS status,
              coalesce(d.valid_from, e.timestamp)     AS valid_from,
              e.event_id             AS event_id,
              e.source               AS event_source,
              e.url                  AS event_url,
              e.timestamp            AS event_timestamp,
              p.name                 AS agent_id,
              e.operator_name        AS operator_name,
              e.project_id           AS project_id,
              raw_alerts,
              raw_tasks,
              CASE WHEN older IS NOT NULL THEN {
                decision_id: older.decision_id,
                summary: older.summary,
                valid_from: older.valid_from,
                reasoning: sr.reasoning
              } END AS supersedes,
              CASE WHEN newer IS NOT NULL THEN {
                decision_id: newer.decision_id,
                summary: newer.summary,
                valid_from: newer.valid_from,
                reasoning: sn.reasoning
              } END AS superseded_by`,
      { decision_id: decisionId }
    );

    if (result.records.length === 0) return null;
    const r = result.records[0];

    const filterNull = <T extends Record<string, unknown>>(items: T[], keyField: string): T[] =>
      items.filter((x) => x[keyField] != null);

    return {
      decision_id:             r.get("decision_id") as string,
      summary:                 (r.get("summary") as string) ?? "",
      rationale:               (r.get("rationale") as string | null) ?? null,
      alternatives_considered: (r.get("alternatives_considered") as string[]) ?? [],
      confidence:              (r.get("confidence") as string) ?? "medium",
      status:                  (r.get("status") as string) ?? "confirmed",
      valid_from:              r.get("valid_from") as string,
      event_id:                r.get("event_id") as string,
      event_source:            (r.get("event_source") as string) ?? "agent",
      event_url:               (r.get("event_url") as string | null) ?? null,
      event_timestamp:         r.get("event_timestamp") as string,
      agent_id:                (r.get("agent_id") as string) ?? "unknown",
      operator_name:           (r.get("operator_name") as string | null) ?? null,
      project_id:              r.get("project_id") as string,
      drift_alerts:            filterNull(r.get("raw_alerts") as Array<Record<string, unknown>>, "alert_id") as Array<{
        alert_id: string; source: string; content: string; reason: string | null;
        actor: string; timestamp: string; resolution: string;
      }>,
      follow_up_tasks:         filterNull(r.get("raw_tasks") as Array<Record<string, unknown>>, "task_id") as Array<{
        task_id: string; title: string; description: string | null; status: string; created_at: string;
      }>,
      supersedes:              (r.get("supersedes") as { decision_id: string; summary: string; valid_from: string; reasoning: string | null } | null) ?? null,
      superseded_by:           (r.get("superseded_by") as { decision_id: string; summary: string; valid_from: string; reasoning: string | null } | null) ?? null,
    };
  } finally {
    await session.close();
  }
}

export interface CorpusStats {
  project_id: string;
  total_events: number;
  events_with_decisions: number;
  events_without_decisions: number;
  yield_rate: number;           // fraction 0–1: events_with_decisions / total_events
  total_decisions: number;
  avg_decisions_per_event: number; // across events that have at least one decision
  sources: Record<string, number>; // event count per source type
  last_event_at: string | null;
}

export async function getCorpusStats(projectId: string): Promise<CorpusStats> {
  const session = getSession();
  try {
    const result = await session.run(
      `MATCH (e:Event {project_id: $project_id})
       OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(e)
       WITH e, count(d) AS decision_count
       WITH
         count(e)                                                              AS total_events,
         sum(CASE WHEN decision_count > 0 THEN 1 ELSE 0 END)                  AS events_with_decisions,
         sum(CASE WHEN decision_count = 0 THEN 1 ELSE 0 END)                  AS events_without_decisions,
         sum(decision_count)                                                   AS total_decisions,
         max(e.timestamp)                                                      AS last_event_at,
         collect({source: e.source, has_decisions: decision_count > 0})        AS event_meta
       RETURN total_events, events_with_decisions, events_without_decisions,
              total_decisions, last_event_at, event_meta`,
      { project_id: projectId }
    );

    if (result.records.length === 0) {
      return {
        project_id: projectId,
        total_events: 0, events_with_decisions: 0, events_without_decisions: 0,
        yield_rate: 0, total_decisions: 0, avg_decisions_per_event: 0,
        sources: {}, last_event_at: null,
      };
    }

    const r = result.records[0];
    const totalEvents       = toNum(r.get("total_events"));
    const eventsWithDec     = toNum(r.get("events_with_decisions"));
    const eventsWithoutDec  = toNum(r.get("events_without_decisions"));
    const totalDecisions    = toNum(r.get("total_decisions"));
    const lastEventAt       = (r.get("last_event_at") as string | null) ?? null;
    const eventMeta         = (r.get("event_meta") as Array<{ source: string; has_decisions: boolean }>) ?? [];

    // Tally events per source
    const sources: Record<string, number> = {};
    for (const m of eventMeta) {
      const src = m.source ?? "unknown";
      sources[src] = (sources[src] ?? 0) + 1;
    }

    return {
      project_id: projectId,
      total_events: totalEvents,
      events_with_decisions: eventsWithDec,
      events_without_decisions: eventsWithoutDec,
      yield_rate: totalEvents > 0 ? Math.round((eventsWithDec / totalEvents) * 1000) / 1000 : 0,
      total_decisions: totalDecisions,
      avg_decisions_per_event: eventsWithDec > 0 ? Math.round((totalDecisions / eventsWithDec) * 10) / 10 : 0,
      sources,
      last_event_at: lastEventAt,
    };
  } finally {
    await session.close();
  }
}
