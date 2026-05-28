/**
 * M6/M4 drift detection eval — verifies the drift detector catches known
 * conflict messages from Slack and Jira, and does not false-positive on noise.
 *
 * Test set:
 *   - 2 Slack drift messages (asyncio, gzip) from seed-slack.ts
 *   - 2 Jira drift messages (zstd/gzip, asyncio) from seed-jira.ts
 *   - 10+ noise messages (no decision content)
 *
 * Targets:
 *   - Recall ≥ 80% (catch at least 3 of 4 drift messages)
 *   - Precision ≥ 70% (< 30% false positive rate on noise)
 *
 * Usage:
 *   tsx src/scripts/eval-drift.ts [--project encode_httpx]
 */
import "dotenv/config";
import { getDriftAlerts } from "../../lib/neo4j.js";

const KNOWN_DRIFT_CONTENT = [
  // Slack drift signals
  "gzip-only compression policy",       // Slack: challenges Phase 1 gzip decision
  "asyncio.get_event_loop() removal",   // Slack: challenges Phase 1 asyncio decision
  // Jira drift signals (HTTPX-104, HTTPX-105)
  "zstd",                               // Jira HTTPX-104: reconsider zstd/gzip
  "asyncio.get_event_loop() deprecation", // Jira HTTPX-105: asyncio compat shims
];

const KNOWN_NOISE_KEYWORDS = [
  // Slack noise
  "test flake",
  "address the nits",
  "release branch is cut",
  "standup in 15",
  "rebased #3812",
  "docs build is failing",
  "4 PRs merged",
  "take a look at #3819",
  "bumped certifi",
  // Jira noise
  "CI test matrix",
  "installation guide",
  "0.28.1",
  "httpcore 1.0.5",
  "Sprint velocity",
];

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";

  console.log(`[eval-drift] checking drift alerts for project: ${projectId}\n`);

  const alerts = await getDriftAlerts(projectId);

  // Also get resolved ones for full picture
  console.log(`  Total pending alerts: ${alerts.length}`);
  console.log(`  Alerts:`);
  for (const a of alerts) {
    console.log(`    [${a.source}] ${a.content.slice(0, 80)}`);
    console.log(`    → challenges: "${a.decision_summary?.slice(0, 70)}"`);
  }

  // Recall: did we catch the known drift messages?
  let truePositives = 0;
  const missedDrifts: string[] = [];

  for (const drift of KNOWN_DRIFT_CONTENT) {
    const keyword = drift.split(" ")[0].toLowerCase();
    const caught = alerts.some((a) => a.content.toLowerCase().includes(keyword));
    if (caught) {
      truePositives++;
      console.log(`\n  ✓ CAUGHT: "${drift}"`);
    } else {
      missedDrifts.push(drift);
      console.log(`\n  ✗ MISSED: "${drift}"`);
    }
  }

  // Precision: are any alerts actually noise?
  let falsePositives = 0;
  for (const a of alerts) {
    const isNoise = KNOWN_NOISE_KEYWORDS.some((k) =>
      a.content.toLowerCase().includes(k.toLowerCase())
    );
    if (isNoise) {
      falsePositives++;
      console.log(`\n  ✗ FALSE POSITIVE: "${a.content.slice(0, 80)}"`);
    }
  }

  const recall = KNOWN_DRIFT_CONTENT.length > 0
    ? truePositives / KNOWN_DRIFT_CONTENT.length
    : 1;
  const precision = alerts.length > 0
    ? (alerts.length - falsePositives) / alerts.length
    : 1;

  console.log(`\n${"═".repeat(70)}`);
  console.log("  M6+M4 DRIFT DETECTION EVAL — SCORECARD (Slack + Jira)");
  console.log(`${"═".repeat(70)}`);
  console.log(`  Known drift messages : ${KNOWN_DRIFT_CONTENT.length}`);
  console.log(`  Caught (TP)          : ${truePositives}`);
  console.log(`  Missed (FN)          : ${missedDrifts.length}`);
  console.log(`  False positives      : ${falsePositives}`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  Recall               : ${(recall * 100).toFixed(0)}%  (target: ≥80%)`);
  console.log(`  Precision            : ${(precision * 100).toFixed(0)}%  (target: ≥70%)`);
  console.log(`${"═".repeat(70)}\n`);

  const recallPass = recall >= 0.8;
  const precisionPass = precision >= 0.7;
  console.log(`  Recall    ${recallPass ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`  Precision ${precisionPass ? "✓ PASS" : "✗ FAIL"}\n`);

  process.exit(recallPass && precisionPass ? 0 : 1);
}

run().catch((e) => {
  console.error("[eval-drift] fatal:", e);
  process.exit(1);
});
