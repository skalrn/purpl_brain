/**
 * M5 schema migration — add identity fields to existing Person nodes.
 *
 * Existing Person nodes were created with only {id, name, type}.
 * This adds: email (null), aliases ([id]), api_key (null), created_at, last_active_at
 *
 * Safe to re-run — uses SET ... WHERE property IS NULL guards.
 *
 * Usage:
 *   tsx src/scripts/migrate-m5-person-schema.ts
 */
import "dotenv/config";
import { driver } from "../lib/neo4j.js";

async function run() {
  const session = driver.session();
  try {
    // Add missing identity fields to existing Person nodes
    const result = await session.run(
      `MATCH (p:Person)
       WHERE p.aliases IS NULL
       SET p.aliases    = CASE WHEN p.id IS NOT NULL THEN [p.id] ELSE [] END,
           p.email      = COALESCE(p.email, null),
           p.api_key    = COALESCE(p.api_key, null),
           p.created_at = COALESCE(p.created_at, datetime().epochMillis + ""),
           p.last_active_at = COALESCE(p.last_active_at, datetime().epochMillis + "")
       RETURN count(p) AS updated`
    );
    const updated = result.records[0]?.get("updated") as number ?? 0;
    console.log(`[migrate-m5] updated ${updated} Person nodes with identity fields`);

    // Report total Person count
    const total = await session.run(`MATCH (p:Person) RETURN count(p) AS n`);
    console.log(`[migrate-m5] total Person nodes: ${total.records[0]?.get("n")}`);

    // Show breakdown: how many have email vs null
    const withEmail = await session.run(
      `MATCH (p:Person) WHERE p.email IS NOT NULL RETURN count(p) AS n`
    );
    console.log(`[migrate-m5] Person nodes with email: ${withEmail.records[0]?.get("n")}`);
    console.log(`[migrate-m5] done — schema migration complete`);
  } finally {
    await session.close();
    await driver.close();
  }
}

run().catch((e) => {
  console.error("[migrate-m5] fatal:", e);
  process.exit(1);
});
