/**
 * Eval: graph integrity assertions
 *
 * White-box assertions directly against Neo4j. These catch structural
 * data quality issues that black-box query evals miss because the query
 * engine can return correct answers even with bad underlying graph state.
 *
 * Invariants asserted:
 *  1. Every Decision has project_id set
 *  2. Every Decision has an EXTRACTED_FROM relationship (no orphans)
 *  3. Every DriftAlert has a CHALLENGES relationship (no orphaned alerts)
 *  4. No two DriftAlert nodes share a fingerprint (dedup working)
 *  5. No Ticket ref matches false-positive patterns (ADR-N, model names, hash names)
 *  6. DriftAlert nodes only exist for projects that have the challenged decision
 *
 * Run: npm run eval:graph-integrity
 */
import "dotenv/config";
import neo4j from "neo4j-driver";

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASS ?? process.env.NEO4J_PASSWORD ?? "password";

// Ticket ref patterns that are never real Jira/GitHub tickets
const FALSE_POSITIVE_TICKET_PATTERNS = [
  /^ADR-\d+$/,           // internal doc cross-references
  /^SHA-\d+$/,           // hash algorithm names
  /^GPT-\d+/,            // model names
  /^RFC-\d+$/,           // RFC numbers
  /^PR-\d+$/,            // "PR-123" style (real refs use plain #123)
  /^v\d+\.\d+/,          // version strings
];

const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

async function query<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const session = driver.session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const key of r.keys) obj[key] = r.get(key);
      return obj as T;
    });
  } finally {
    await session.close();
  }
}

async function main() {
  console.log("\nEval: graph integrity\n");

  // ── 1. Every Decision has project_id ───────────────────────────────────────
  const nullProjectDecisions = await query<{ count: number }>(
    "MATCH (d:Decision) WHERE d.project_id IS NULL RETURN count(d) AS count"
  );
  const nullCount = nullProjectDecisions[0]?.count ?? 0;
  check(
    "all Decision nodes have project_id set",
    Number(nullCount) === 0,
    `${nullCount} decision(s) missing project_id`
  );

  // ── 2. Every Decision has EXTRACTED_FROM (no orphans) ──────────────────────
  const orphanDecisions = await query<{ count: number }>(
    "MATCH (d:Decision) WHERE NOT (d)-[:EXTRACTED_FROM]->() RETURN count(d) AS count"
  );
  const orphanCount = orphanDecisions[0]?.count ?? 0;
  check(
    "no orphaned Decision nodes (all have EXTRACTED_FROM relationship)",
    Number(orphanCount) === 0,
    `${orphanCount} orphaned decision(s) with no source event`
  );

  // ── 3. Every DriftAlert has CHALLENGES (no orphaned alerts) ────────────────
  const orphanAlerts = await query<{ count: number }>(
    "MATCH (da:DriftAlert) WHERE NOT (da)-[:CHALLENGES]->() RETURN count(da) AS count"
  );
  const orphanAlertCount = orphanAlerts[0]?.count ?? 0;
  check(
    "no orphaned DriftAlert nodes (all have CHALLENGES relationship)",
    Number(orphanAlertCount) === 0,
    `${orphanAlertCount} drift alert(s) not linked to any decision`
  );

  // ── 4. No duplicate DriftAlert fingerprints ────────────────────────────────
  const dupFingerprints = await query<{ fingerprint: string; count: number }>(
    `MATCH (da:DriftAlert) WHERE da.fingerprint IS NOT NULL
     WITH da.fingerprint AS fp, count(da) AS cnt
     WHERE cnt > 1
     RETURN fp AS fingerprint, cnt AS count`
  );
  check(
    "no duplicate DriftAlert fingerprints (dedup working)",
    dupFingerprints.length === 0,
    dupFingerprints.length > 0
      ? `${dupFingerprints.length} fingerprint(s) appear on multiple nodes`
      : ""
  );

  // ── 5. DriftAlerts without fingerprint are legacy — warn, don't fail ────────
  const noFingerprintAlerts = await query<{ count: number }>(
    "MATCH (da:DriftAlert) WHERE da.fingerprint IS NULL RETURN count(da) AS count"
  );
  const noFpCount = Number(noFingerprintAlerts[0]?.count ?? 0);
  check(
    "all DriftAlert nodes have fingerprint set",
    noFpCount === 0,
    `${noFpCount} legacy alert(s) missing fingerprint — re-run drift detector to backfill`
  );

  // ── 6. No false-positive Ticket refs ──────────────────────────────────────
  const allTicketRefs = await query<{ ref: string }>(
    "MATCH (t:Ticket) RETURN t.ref AS ref"
  );
  const falsePositives = allTicketRefs
    .map((r) => r.ref)
    .filter((ref) => FALSE_POSITIVE_TICKET_PATTERNS.some((p) => p.test(ref)));

  check(
    "no false-positive Ticket refs (ADR-N, SHA-N, model names, version strings)",
    falsePositives.length === 0,
    falsePositives.length > 0 ? `bad refs: ${falsePositives.slice(0, 5).join(", ")}` : ""
  );

  // ── 7. DriftAlerts are project-consistent ─────────────────────────────────
  // Alert source event and challenged decision must belong to the same project.
  const crossProjectAlerts = await query<{ alert_id: string; alert_project: string; decision_project: string }>(
    `MATCH (da:DriftAlert)-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(de:Event)
     MATCH (da) WHERE da.event_id IS NOT NULL
     MATCH (ae:Event {event_id: da.event_id})
     WHERE ae.project_id <> de.project_id
     RETURN da.alert_id AS alert_id, ae.project_id AS alert_project, de.project_id AS decision_project`
  );
  check(
    "all DriftAlerts challenge decisions within the same project",
    crossProjectAlerts.length === 0,
    crossProjectAlerts.length > 0
      ? `${crossProjectAlerts.length} alert(s) cross project boundaries`
      : ""
  );

  // ── Summary ─────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Result: ${passed}/${total} passed`);
  if (failed > 0) {
    console.error(`EVAL FAILED — ${failed} check(s) failed`);
    await driver.close();
    process.exit(1);
  } else {
    console.log("EVAL PASSED ✓");
    await driver.close();
  }
}

main().catch((e) => {
  console.error(e);
  driver.close().catch(() => undefined);
  process.exit(1);
});
