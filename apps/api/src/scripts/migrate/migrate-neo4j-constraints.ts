/**
 * Adds uniqueness constraints to Neo4j for all primary key properties.
 * Safe to run multiple times — uses CREATE CONSTRAINT IF NOT EXISTS.
 * Run once after initial Neo4j setup or when deploying to a new environment.
 */
import "dotenv/config";
import { driver } from "../../lib/neo4j.js";

const CONSTRAINTS = [
  { name: "person_id_unique", label: "Person", property: "person_id" },
  { name: "event_id_unique", label: "Event", property: "event_id" },
  { name: "decision_id_unique", label: "Decision", property: "decision_id" },
  { name: "ticket_ref_unique", label: "Ticket", property: "ref" },
  { name: "drift_alert_id_unique", label: "DriftAlert", property: "alert_id" },
  { name: "follow_up_task_id_unique", label: "FollowUpTask", property: "task_id" },
];

async function run() {
  const session = driver.session();
  try {
    for (const c of CONSTRAINTS) {
      await session.run(
        `CREATE CONSTRAINT ${c.name} IF NOT EXISTS
         FOR (n:${c.label}) REQUIRE n.${c.property} IS UNIQUE`
      );
      console.log(`[migrate-constraints] ✓ ${c.label}.${c.property}`);
    }

    // Existence constraints for Person source identifiers (nullable — use node key pattern)
    // These are not unique across nodes but index them for fast lookup
    const INDEXES = [
      { name: "person_github_login_idx", label: "Person", property: "github_login" },
      { name: "person_slack_user_id_idx", label: "Person", property: "slack_user_id" },
      { name: "person_jira_user_id_idx", label: "Person", property: "jira_user_id" },
      { name: "person_email_idx", label: "Person", property: "email" },
      // Event filters used on nearly every query — critical for scale
      { name: "event_project_id_idx", label: "Event", property: "project_id" },
      { name: "event_source_idx", label: "Event", property: "source" },
      { name: "event_timestamp_idx", label: "Event", property: "timestamp" },
      // Decision filters used in drift detection and query expansion
      { name: "decision_project_id_idx", label: "Decision", property: "project_id" },
      { name: "decision_status_idx", label: "Decision", property: "status" },
      { name: "decision_valid_from_idx", label: "Decision", property: "valid_from" },
      // DriftAlert hot-path filters (global banner, inbox, reconciliation)
      { name: "drift_alert_resolution_idx", label: "DriftAlert", property: "resolution" },
      { name: "drift_alert_fingerprint_idx", label: "DriftAlert", property: "fingerprint" },
    ];

    for (const idx of INDEXES) {
      await session.run(
        `CREATE INDEX ${idx.name} IF NOT EXISTS
         FOR (n:${idx.label}) ON (n.${idx.property})`
      );
      console.log(`[migrate-constraints] ✓ index ${idx.label}.${idx.property}`);
    }

    // Backfill project_id onto DriftAlerts written before the denormalization
    // (2026-05-28). Idempotent — only touches alerts where project_id IS NULL.
    const backfill = await session.run(
      `MATCH (a:DriftAlert)-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(e:Event)
       WHERE a.project_id IS NULL
       SET a.project_id = e.project_id
       RETURN count(a) AS n`
    );
    const backfilled = backfill.records[0]?.get("n");
    const n = typeof backfilled === "number" ? backfilled : Number(backfilled?.toNumber?.() ?? 0);
    if (n > 0) console.log(`[migrate-constraints] backfilled project_id on ${n} DriftAlert(s) ✓`);

    console.log("[migrate-constraints] all constraints and indexes applied ✓");
  } finally {
    await session.close();
    await driver.close();
  }
}

run().catch((e) => {
  console.error("[migrate-constraints] fatal:", e);
  process.exit(1);
});
