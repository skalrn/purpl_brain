/**
 * Eval: Drift detector false-positive rate
 *
 * Seeds a project with a decision (via agent-log), then ingests unrelated
 * benign content. The drift detector should NOT raise an alert. We also
 * sanity-check with directly contradictory content that SHOULD raise one.
 *
 *  1. agent-log seed for a Redis-caching decision returns 200 ok
 *  2. Pre-existing drift alerts for project are empty (baseline)
 *  3. After benign unrelated ingest + 50s wait, drift-alerts list is empty (no FP)
 *  4. After contradictory ingest + 50s wait, drift-alerts list is non-empty (sanity)
 *  5. At least one of the new alerts references the seeded decision's project
 *
 * Note: ingest endpoints require X-API-Key. /brain/drift-alerts does not.
 * If BRAIN_API_KEY is unset, ingest-dependent checks are skipped.
 */
import "dotenv/config";
import { cleanupEvalProjects } from "../../lib/eval-cleanup.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:3741";
const API_KEY = process.env.BRAIN_API_KEY ?? "";
const RUN_ID = Date.now();
const PROJECT_ID = `eval_drift_fp_${RUN_ID}`;
const SESSION_ID = `sess_drift_fp_${RUN_ID}`;

const SEED_AGENT_LOG = {
  schema_version: "1.0",
  session_id: SESSION_ID,
  agent_id: "claude-sonnet-4-6",
  project_id: PROJECT_ID,
  task_id: "seed-caching-decision",
  codebase: "purpl-brain",
  timestamp_start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  timestamp_end: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  decisions: [
    {
      id: "d1",
      description: "Use Redis with allkeys-lru eviction for query result caching",
      rationale:
        "Redis is already in the stack for Streams; adding Memcached would increase operational overhead without benefit",
      alternatives_considered: ["Memcached", "in-memory Map"],
      confidence: "high" as const,
    },
  ],
  work_completed: "Decided on Redis allkeys-lru caching for query results.",
  files_modified: ["apps/api/src/lib/redis.ts"],
};

const BENIGN_TRANSCRIPT = `WEBVTT

00:00:05.000 --> 00:00:20.000
Alice: Today's topic is sorting algorithm performance benchmarks.

00:00:21.000 --> 00:00:45.000
Bob: Quicksort beats mergesort on our typical input sizes, but its worst case is O(n²). Heapsort is more predictable.

00:00:46.000 --> 00:01:05.000
Carol: I ran the benchmarks on a million-element array. Quicksort took 180ms median, mergesort 220ms, heapsort 260ms.

00:01:06.000 --> 00:01:25.000
Alice: Let's stick with the standard library sort. Nothing actionable here, just informational.
`;

const CONTRADICTORY_TRANSCRIPT = `WEBVTT

00:00:05.000 --> 00:00:25.000
Alice: We need to revisit the caching choice. Redis with allkeys-lru is the wrong call.

00:00:26.000 --> 00:00:50.000
Bob: I agree. We should rip out Redis and switch to Memcached for query result caching. Memcached's slab allocator gives us more predictable memory behavior than Redis allkeys-lru eviction.

00:00:51.000 --> 00:01:15.000
Carol: Decision: replace Redis caching with Memcached. The allkeys-lru policy has been causing eviction storms under load.
`;

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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  return headers;
}

async function getAlerts(projectId: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${API_BASE}/brain/drift-alerts?project_id=${encodeURIComponent(projectId)}`);
  if (!res.ok) return [];
  const body = (await res.json()) as Record<string, unknown>;
  return (body.alerts as Array<Record<string, unknown>>) ?? [];
}

async function main() {
  console.log(`\nEval: Drift detector FP rate  [project=${PROJECT_ID}]\n`);

  if (!API_KEY) {
    console.log("  NOTE  BRAIN_API_KEY not set — ingest will 401. Skipping pipeline checks.\n");
  }

  // ── Check 1: Seed a decision via agent-log ─────────────────────────────────
  const seedRes = await fetch(`${API_BASE}/brain/agent-log`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(SEED_AGENT_LOG),
  });

  if (!API_KEY) {
    check("agent-log seed returns 401 without API key", seedRes.status === 401,
      `status=${seedRes.status}`);
  } else {
    check("agent-log seed returns 200 ok", seedRes.status === 200,
      `status=${seedRes.status}`);
  }

  if (!API_KEY || seedRes.status !== 200) {
    console.log("\n  SKIP  drift detection checks (no API key or seed failed)\n");
  } else {
    // Wait for the seed to flow through extraction + brain-writer so the
    // Decision node exists in Neo4j and is searchable by Qdrant.
    console.log("\n  Waiting 35s for seed to propagate through pipeline...\n");
    await sleep(35000);

    // ── Check 2: baseline — no drift alerts yet ──────────────────────────────
    const baseline = await getAlerts(PROJECT_ID);
    check("baseline: project has zero drift alerts", baseline.length === 0,
      `alerts=${baseline.length}`);

    // ── Ingest benign unrelated content ──────────────────────────────────────
    const benignRes = await fetch(`${API_BASE}/brain/ingest/transcript`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        text: BENIGN_TRANSCRIPT,
        title: "Sorting algorithm benchmarks",
        project_id: PROJECT_ID,
        source_url: `brain://eval/drift-fp/benign/${RUN_ID}`,
      }),
    });
    check("benign transcript ingest returns 200 ok", benignRes.status === 200,
      `status=${benignRes.status}`);

    // Wait for extractor + drift detector to run
    console.log("\n  Waiting 50s for benign ingest → drift detector cycle...\n");
    await sleep(50000);

    // ── Check 3: no FP from benign content ────────────────────────────────────
    const afterBenign = await getAlerts(PROJECT_ID);
    check("no drift alert raised from benign unrelated content (no FP)",
      afterBenign.length === 0,
      `alerts=${afterBenign.length} — ${afterBenign
        .map((a) => `${a.alert_id}:${(a.content as string ?? "").slice(0, 40)}`)
        .join(" | ")}`);

    // ── Ingest contradictory content (positive sanity case) ─────────────────
    const contraRes = await fetch(`${API_BASE}/brain/ingest/transcript`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        text: CONTRADICTORY_TRANSCRIPT,
        title: "Re-open caching choice",
        project_id: PROJECT_ID,
        source_url: `brain://eval/drift-fp/contra/${RUN_ID}`,
      }),
    });
    check("contradictory transcript ingest returns 200 ok", contraRes.status === 200,
      `status=${contraRes.status}`);

    console.log("\n  Waiting 50s for contradictory ingest → drift detector cycle...\n");
    await sleep(50000);

    // ── Check 4+5: sanity — drift alert is raised on real contradiction ─────
    const afterContra = await getAlerts(PROJECT_ID);
    check("drift alert raised on contradictory content (positive sanity)",
      afterContra.length >= 1, `alerts=${afterContra.length}`);

    const hasMeetingAlert = afterContra.some((a) => a.source === "meeting");
    check("at least one alert has source=meeting (from contradictory transcript)",
      hasMeetingAlert,
      `sources=${afterContra.map((a) => a.source).join(",")}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Result: ${passed}/${total} passed`);

  console.log("\n  Cleaning up eval data...");
  await cleanupEvalProjects([PROJECT_ID]);

  if (failed > 0) {
    console.error(`EVAL FAILED — ${failed} check(s) failed`);
    process.exit(1);
  } else {
    console.log("EVAL PASSED ✓");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
