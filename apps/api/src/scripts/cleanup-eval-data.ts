/**
 * One-time cleanup: remove all eval-generated data from Neo4j and Qdrant.
 *
 * Usage:
 *   npx tsx src/scripts/cleanup-eval-data.ts
 *
 * Safe to run multiple times — idempotent.
 */

import neo4j from "neo4j-driver";
import { QdrantClient } from "@qdrant/js-client-rest";

const NEO4J_URI  = process.env.NEO4J_URI  ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASS = process.env.NEO4J_PASSWORD ?? "password";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = process.env.QDRANT_COLLECTION ?? "brain_chunks";

const EVAL_PREFIXES = ["eval_", "e2e_", "helix-eval_"];
const EVAL_EXACT    = ["encode_httpx", "purpl_brain_eval"];

function isEval(pid: string): boolean {
  return EVAL_EXACT.includes(pid) || EVAL_PREFIXES.some((p) => pid.startsWith(p));
}

async function main() {
  const driver  = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));
  const qdrant  = new QdrantClient({ url: QDRANT_URL });
  const session = driver.session();

  try {
    // ── Step 1: discover all eval project IDs ──────────────────────────────
    const pidResult = await session.run(
      `MATCH (e:Event) RETURN DISTINCT e.project_id AS pid`
    );
    const allPids = pidResult.records.map((r) => r.get("pid") as string);
    const evalPids = allPids.filter(isEval);

    if (evalPids.length === 0) {
      console.log("No eval projects found — nothing to clean up.");
      return;
    }

    console.log(`Found ${evalPids.length} eval projects:`);
    evalPids.forEach((p) => console.log(`  ${p}`));
    console.log();

    // ── Step 2: Neo4j — delete in dependency order ─────────────────────────
    console.log("Deleting DriftAlerts linked to eval decisions...");
    const da = await session.run(
      `MATCH (a:DriftAlert)-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.project_id IN $pids
       DETACH DELETE a RETURN count(a) AS n`,
      { pids: evalPids }
    );
    console.log(`  Deleted ${da.records[0]?.get("n") ?? 0} DriftAlerts`);

    console.log("Deleting Decision nodes...");
    const dec = await session.run(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE e.project_id IN $pids
       DETACH DELETE d RETURN count(d) AS n`,
      { pids: evalPids }
    );
    console.log(`  Deleted ${dec.records[0]?.get("n") ?? 0} Decisions`);

    console.log("Deleting PreflightCheck nodes...");
    const pc = await session.run(
      `MATCH (c:PreflightCheck)-[:FOR_SESSION]->(e:Event)
       WHERE e.project_id IN $pids
       DETACH DELETE c RETURN count(c) AS n`,
      { pids: evalPids }
    );
    console.log(`  Deleted ${pc.records[0]?.get("n") ?? 0} PreflightChecks`);

    console.log("Deleting Event nodes...");
    const ev = await session.run(
      `MATCH (e:Event) WHERE e.project_id IN $pids DETACH DELETE e RETURN count(e) AS n`,
      { pids: evalPids }
    );
    console.log(`  Deleted ${ev.records[0]?.get("n") ?? 0} Events`);

    console.log("Deleting FollowUpTask nodes...");
    const ft = await session.run(
      `MATCH (t:FollowUpTask) WHERE t.project_id IN $pids DELETE t RETURN count(t) AS n`,
      { pids: evalPids }
    );
    console.log(`  Deleted ${ft.records[0]?.get("n") ?? 0} FollowUpTasks`);

    console.log("Deleting QueryLog nodes...");
    const ql = await session.run(
      `MATCH (q:QueryLog) WHERE q.project_id IN $pids DELETE q RETURN count(q) AS n`,
      { pids: evalPids }
    );
    console.log(`  Deleted ${ql.records[0]?.get("n") ?? 0} QueryLogs`);

    console.log("Deleting Project nodes...");
    const proj = await session.run(
      `MATCH (p:Project) WHERE p.project_id IN $pids DETACH DELETE p RETURN count(p) AS n`,
      { pids: evalPids }
    );
    console.log(`  Deleted ${proj.records[0]?.get("n") ?? 0} Project nodes`);

    console.log("Removing orphaned Person nodes...");
    const person = await session.run(
      `MATCH (p:Person)
       WHERE NOT (p)-[:MEMBER_OF]->() AND NOT (p)<-[:AUTHORED_BY]-()
         AND p.email IS NOT NULL
       DELETE p RETURN count(p) AS n`
    );
    console.log(`  Removed ${person.records[0]?.get("n") ?? 0} orphaned Persons`);

    // ── Step 3: Qdrant — delete by project_id filter ───────────────────────
    console.log("\nDeleting Qdrant vectors for eval projects...");
    await qdrant.delete(COLLECTION, {
      filter: {
        must: [{ key: "project_id", match: { any: evalPids } }],
      },
      wait: true,
    });
    console.log("  Qdrant vectors deleted.");

    console.log("\nDone. All eval data removed.");
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
