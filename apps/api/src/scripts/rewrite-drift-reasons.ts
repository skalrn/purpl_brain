/**
 * One-off script: rewrite DriftAlert.reason for all pending alerts.
 *
 * The original prompt produced "The message suggests..." boilerplate.
 * This re-runs the LLM with the corrected prompt against the stored
 * content + decision summary and patches the reason in-place.
 *
 * Run: npx tsx apps/api/src/scripts/rewrite-drift-reasons.ts
 */
import "dotenv/config";
import { getSession } from "../lib/neo4j.js";
import { chat, MODELS } from "../lib/llm.js";

const REWRITE_SYSTEM_PROMPT = `You are a decision drift detector for software engineering teams.

Given challenging content and an existing project decision it conflicts with, write ONE sentence describing the contradiction.

Rules:
- State what conflicts with what directly (e.g. "Removes X, contradicting the decision to keep X because Y.")
- Do NOT start with "The message", "This message", "The content", or any reference to a message.
- Focus on the substance: what changed vs what was decided.
- Output the sentence only. No JSON, no explanation, no preamble.`;

interface AlertRow {
  alert_id: string;
  content: string;
  decision_summary: string;
  decision_quoted: string;
}

async function rewriteReasons(): Promise<void> {
  const session = getSession();
  let rows: AlertRow[] = [];

  try {
    const result = await session.run(`
      MATCH (a:DriftAlert)-[:CHALLENGES]->(d:Decision)
      WHERE a.resolution = "pending"
      RETURN a.alert_id AS alert_id,
             a.content   AS content,
             d.summary   AS decision_summary,
             d.quoted_text AS decision_quoted
    `);
    rows = result.records.map((r) => ({
      alert_id: r.get("alert_id") as string,
      content: r.get("content") as string,
      decision_summary: r.get("decision_summary") as string,
      decision_quoted: r.get("decision_quoted") as string,
    }));
  } finally {
    await session.close();
  }

  console.log(`Found ${rows.length} pending drift alerts to rewrite.`);

  let updated = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const userMessage = `Challenging content:
"${row.content.slice(0, 800)}"

Existing decision it challenges:
Summary: ${row.decision_summary}
Original text: "${row.decision_quoted}"

Write one sentence describing what conflicts with what.`;

      const reason = (await chat(
        MODELS.EXTRACTION,
        [
          { role: "system", content: REWRITE_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        { maxTokens: 128, temperature: 0 }
      )).trim();

      const s = getSession();
      try {
        await s.run(
          `MATCH (a:DriftAlert {alert_id: $alert_id}) SET a.reason = $reason`,
          { alert_id: row.alert_id, reason }
        );
      } finally {
        await s.close();
      }

      console.log(`✓ ${row.alert_id.slice(0, 8)}… → ${reason}`);
      updated++;
    } catch (e) {
      console.error(`✗ ${row.alert_id}: ${(e as Error).message}`);
      failed++;
    }
  }

  console.log(`\nDone. Updated: ${updated}, Failed: ${failed}`);
  process.exit(0);
}

rewriteReasons().catch((e) => {
  console.error(e);
  process.exit(1);
});
