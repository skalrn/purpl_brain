/**
 * Pre-Phase-2 schema migration
 * Adds status and source_signals to all existing Decision nodes in Neo4j.
 * Safe to run multiple times (uses SET ... WHERE ... IS NULL pattern).
 */
import "dotenv/config";
import { driver } from "../lib/neo4j.js";

async function run() {
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (d:Decision)
       WHERE d.status IS NULL
       SET d.status = "confirmed",
           d.source_signals = []
       RETURN count(d) AS updated`
    );
    const updated = result.records[0]?.get("updated") ?? 0;
    console.log(`[migrate] Decision nodes updated: ${updated}`);

    // Also set source field on Event nodes that are missing it
    const evResult = await session.run(
      `MATCH (e:Event)
       WHERE e.source IS NULL OR e.source = ""
       SET e.source = "github"
       RETURN count(e) AS updated`
    );
    const evUpdated = evResult.records[0]?.get("updated") ?? 0;
    console.log(`[migrate] Event nodes source-field patched: ${evUpdated}`);

    console.log("[migrate] Phase 2 schema migration complete ✓");
  } finally {
    await session.close();
    await driver.close();
  }
}

run().catch((e) => {
  console.error("[migrate] fatal:", e);
  process.exit(1);
});
