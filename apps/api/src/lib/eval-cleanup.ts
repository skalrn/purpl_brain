/**
 * Shared cleanup utility for eval scripts.
 *
 * Call cleanupEvalProjects(projectIds) in a finally block at the end of every
 * eval that writes data — keeps Neo4j and Qdrant free of test artifacts.
 */

import { getSession } from "./neo4j.js";
import { qdrant, COLLECTION } from "./qdrant.js";

/**
 * Delete all Neo4j and Qdrant data for the given project IDs.
 * Safe to call with an empty array (no-op).
 */
export async function cleanupEvalProjects(projectIds: string[]): Promise<void> {
  if (projectIds.length === 0) return;

  const neo = getSession();
  try {
    // Delete in dependency order to avoid constraint violations.
    // DriftAlerts → Decisions → PreflightChecks → Events → FollowUpTasks →
    // QueryLogs → Project nodes → orphaned Person nodes.

    await neo.run(
      `MATCH (a:DriftAlert)-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.project_id IN $pids
       DETACH DELETE a`,
      { pids: projectIds }
    );

    await neo.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.project_id IN $pids
       DETACH DELETE d`,
      { pids: projectIds }
    );

    await neo.run(
      `MATCH (c:PreflightCheck)-[:FOR_SESSION]->(e:Event)
       WHERE e.project_id IN $pids
       DETACH DELETE c`,
      { pids: projectIds }
    );

    await neo.run(
      `MATCH (e:Event) WHERE e.project_id IN $pids DETACH DELETE e`,
      { pids: projectIds }
    );

    await neo.run(
      `MATCH (t:FollowUpTask) WHERE t.project_id IN $pids DELETE t`,
      { pids: projectIds }
    );

    await neo.run(
      `MATCH (q:QueryLog) WHERE q.project_id IN $pids DELETE q`,
      { pids: projectIds }
    );

    await neo.run(
      `MATCH (p:Project) WHERE p.project_id IN $pids DETACH DELETE p`,
      { pids: projectIds }
    );

    // Remove Person nodes that are now fully disconnected (no project membership,
    // no events, no authorship). Bot/system persons (no email) are excluded.
    await neo.run(
      `MATCH (p:Person)
       WHERE NOT (p)-[:MEMBER_OF]->() AND NOT (p)<-[:AUTHORED_BY]-()
         AND p.email IS NOT NULL
       DELETE p`,
      {}
    );
  } finally {
    await neo.close();
  }

  // Delete Qdrant points for all project IDs in one filter call.
  await qdrant.delete(COLLECTION, {
    filter: {
      must: [
        {
          key: "project_id",
          match: { any: projectIds },
        },
      ],
    },
    wait: true,
  });
}

/** Patterns that identify eval-generated project IDs. */
const EVAL_PREFIXES = ["eval_", "e2e_", "helix-eval_"];
const EVAL_EXACT = new Set(["encode_httpx", "purpl_brain_eval"]);

export function isEvalProject(projectId: string): boolean {
  return (
    EVAL_EXACT.has(projectId) ||
    EVAL_PREFIXES.some((p) => projectId.startsWith(p))
  );
}
