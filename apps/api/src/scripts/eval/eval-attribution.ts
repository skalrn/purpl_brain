/**
 * eval-attribution — citation attribution accuracy
 *
 * Verifies that when a decision is recalled, the citation correctly
 * identifies WHO made it, WHERE it came from, and WHAT they said.
 *
 * Distinct from eval-citations (structural validity) — this eval checks
 * identity accuracy against known ground truth we control:
 *   - actor.id matches the expected agent that logged the decision
 *   - source matches the expected signal type ("agent")
 *   - quoted_text has meaningful overlap with the actual seeded rationale
 *   - timestamp is in the correct chronological order
 *
 * Structure:
 *   Seed 5 decisions from 5 different agent_ids with unique, verifiable
 *   rationale text. Query for each. Check attribution on the citations.
 *
 * Pass criterion per decision:
 *   actor.id correct  AND  source === "agent"  AND  quote overlap ≥ 0.25
 *
 * Aggregate pass: ≥ 4/5 (80%)
 *
 * Usage:
 *   npm run eval:attribution -w apps/api
 */
import "dotenv/config";
import { cleanupEvalProjects } from "../../lib/eval-cleanup.js";

const API    = process.env.BRAIN_API_URL ?? "http://localhost:3741";
const API_KEY = process.env.BRAIN_API_KEY ?? "dev-local";
const RUN_ID  = Date.now();
const PROJECT = `eval_attr_${RUN_ID}`;
const now     = Date.now();
const DAY     = 86_400_000;

// ── Ground truth: 5 decisions with distinct agent_ids and unique rationale ─────
// Each rationale contains a unique discriminating phrase so we can verify
// the quoted_text in the citation actually came from this decision and not
// a hallucination or cross-contamination from another session.

const SEEDS = [
  {
    agent_id: "claude-code",
    session_id: `sess_attr_1_${RUN_ID}`,
    timestamp_start: new Date(now - 10 * DAY).toISOString(),
    timestamp_end:   new Date(now - 10 * DAY + 30 * 60_000).toISOString(),
    decision: {
      id: "d1",
      description: "Adopted connection pooling with pool size 20 for the PostgreSQL client",
      rationale:
        "Load testing at 500 concurrent requests showed connection exhaustion at the default pool size of 10. " +
        "Pool size 20 eliminated exhaustion with headroom for burst traffic. " +
        "Unique marker: CONNPOOL-ALPHA-CALIBRATION-500RPS",
      alternatives_considered: ["pool size 10", "pool size 50", "PgBouncer"],
      confidence: "high" as const,
    },
    query: "What PostgreSQL connection pool size was chosen and why?",
    expected_keywords: ["pool", "20", "connection", "500"],
    unique_marker: "CONNPOOL-ALPHA-CALIBRATION-500RPS",
  },
  {
    agent_id: "cursor",
    session_id: `sess_attr_2_${RUN_ID}`,
    timestamp_start: new Date(now - 7 * DAY).toISOString(),
    timestamp_end:   new Date(now - 7 * DAY + 20 * 60_000).toISOString(),
    decision: {
      id: "d2",
      description: "Chose SWR over React Query for client-side data fetching in the web UI",
      rationale:
        "SWR's stale-while-revalidate pattern fits the read-heavy dashboard use case better than React Query's " +
        "aggressive refetch-on-focus default. Bundle size delta: SWR 4.1KB vs React Query 12.8KB gzipped. " +
        "Unique marker: SWRBUNDLE-DELTA-4KB-VS-12KB",
      alternatives_considered: ["React Query", "Apollo Client", "plain fetch"],
      confidence: "high" as const,
    },
    query: "Why was SWR chosen over React Query for the web UI?",
    expected_keywords: ["swr", "react query", "bundle", "stale"],
    unique_marker: "SWRBUNDLE-DELTA-4KB-VS-12KB",
  },
  {
    agent_id: "windsurf",
    session_id: `sess_attr_3_${RUN_ID}`,
    timestamp_start: new Date(now - 4 * DAY).toISOString(),
    timestamp_end:   new Date(now - 4 * DAY + 45 * 60_000).toISOString(),
    decision: {
      id: "d3",
      description: "Set Qdrant HNSW ef_construction to 256 and m to 16 for the brain_chunks collection",
      rationale:
        "Benchmarked ef_construction values 64, 128, 256 at 10K vectors. " +
        "ef_construction=256 with m=16 achieved recall 0.97 at 8ms p99 vs 0.91 recall at 4ms for ef=128. " +
        "Recall improvement justified the 2x index build time. " +
        "Unique marker: HNSW-BENCH-EF256-M16-RECALL097",
      alternatives_considered: ["ef_construction=128, m=16", "ef_construction=64, m=8"],
      confidence: "high" as const,
    },
    query: "What Qdrant HNSW configuration was decided and what recall did it achieve?",
    expected_keywords: ["hnsw", "ef", "256", "recall", "qdrant"],
    unique_marker: "HNSW-BENCH-EF256-M16-RECALL097",
  },
  {
    agent_id: "gemini-cli",
    session_id: `sess_attr_4_${RUN_ID}`,
    timestamp_start: new Date(now - 2 * DAY).toISOString(),
    timestamp_end:   new Date(now - 2 * DAY + 15 * 60_000).toISOString(),
    decision: {
      id: "d4",
      description: "Decided not to implement API versioning via URL path prefix for the v1 release",
      rationale:
        "API versioning via URL prefix (/v1/, /v2/) would require duplicating route handlers and middleware. " +
        "At current stage (single active version), the overhead is not justified. " +
        "Accept header negotiation deferred — revisit when a breaking change is actually required. " +
        "Unique marker: APIVER-DEFERRED-ACCEPT-HEADER-NOGOV",
      alternatives_considered: ["/v1/ URL prefix", "Accept header negotiation", "query param ?version=1"],
      confidence: "high" as const,
    },
    query: "Was API versioning implemented? What approach was decided?",
    expected_keywords: ["versioning", "deferred", "url", "prefix"],
    unique_marker: "APIVER-DEFERRED-ACCEPT-HEADER-NOGOV",
  },
  {
    agent_id: "claude-code",
    session_id: `sess_attr_5_${RUN_ID}`,
    timestamp_start: new Date(now - 1 * DAY).toISOString(),
    timestamp_end:   new Date(now - 1 * DAY + 60 * 60_000).toISOString(),
    decision: {
      id: "d5",
      description: "Adopted structured logging with pino over winston for the API server",
      rationale:
        "Pino JSON output is natively compatible with our Datadog log aggregator without a custom formatter. " +
        "Benchmark: pino 94K ops/s vs winston 22K ops/s on the same payload at p99. " +
        "Winston's transport model is overkill for a service that only logs to stdout. " +
        "Unique marker: PINO-BENCH-94KOPS-VS-WINSTON-22K",
      alternatives_considered: ["winston", "console.log + JSON.stringify", "bunyan"],
      confidence: "high" as const,
    },
    query: "Why was pino chosen for logging instead of winston?",
    expected_keywords: ["pino", "winston", "logging", "json"],
    unique_marker: "PINO-BENCH-94KOPS-VS-WINSTON-22K",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function wordOverlap(a: string, b: string): number {
  const words = a.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (words.length === 0) return 0;
  const bLower = b.toLowerCase();
  return words.filter((w) => bLower.includes(w)).length / words.length;
}

// ── Main ───────────────────────────────────────────────────────────────────────

interface Result {
  agent_id: string;
  query: string;
  actor_correct: boolean;
  source_correct: boolean;
  quote_grounded: boolean;
  marker_present: boolean;
  citation_actor_id: string;
  citation_source: string;
  quote_overlap: number;
  content_keywords_matched: number;
  content_keywords_total: number;
  latency_ms: number;
  pass: boolean;
}

const results: Result[] = [];

console.log("\n── eval-attribution: citation attribution accuracy ──\n");
console.log(`  Project  : ${PROJECT}`);
console.log(`  Sessions : ${SEEDS.length} (distinct agent_ids with unique rationale markers)`);
console.log(`  Checks   : actor.id correct · source=agent · quote overlap ≥ 0.25 · marker present\n`);

// ── Phase 1: Seed ─────────────────────────────────────────────────────────────

console.log("── Phase 1: Seed decisions ──\n");

for (const s of SEEDS) {
  try {
    const r = await post("/brain/agent-log", {
      schema_version: "1.0",
      session_id: s.session_id,
      agent_id: s.agent_id,
      project_id: PROJECT,
      task_id: `attr-eval-${s.session_id}`,
      codebase: "eval-attribution",
      timestamp_start: s.timestamp_start,
      timestamp_end: s.timestamp_end,
      decisions: [s.decision],
      work_completed: s.decision.description,
      files_modified: [],
    }) as { decisions_logged: number };
    console.log(`  ✓ ${s.agent_id.padEnd(12)} "${s.decision.description.slice(0, 55)}..."`);
    if (r.decisions_logged !== 1) throw new Error(`expected 1 decision, got ${r.decisions_logged}`);
  } catch (e) {
    console.log(`  ✗ ${s.agent_id}: ${(e as Error).message}`);
  }
}

// ── Phase 2: Pipeline wait ────────────────────────────────────────────────────

console.log("\n── Phase 2: Wait for brain-writer + Qdrant indexing ──\n");
console.log("  Waiting 15s...");
await sleep(15_000);
console.log("  Done.\n");

// ── Phase 3: Query and check attribution ──────────────────────────────────────

console.log("── Phase 3: Attribution checks ──\n");

for (const s of SEEDS) {
  const t0 = Date.now();
  try {
    const res = await post("/brain/query", {
      query: s.query,
      project_id: PROJECT,
      mode: "project",
    }) as {
      answer: string;
      citations: Array<{ source: string; actor: { id: string; name: string; type: string }; quoted_text: string; timestamp: string }>;
    };

    const latency_ms = Date.now() - t0;

    // Find the best matching citation (by quoted_text overlap with seeded rationale)
    const bestCitation = res.citations.reduce(
      (best, c) => {
        const overlap = wordOverlap(c.quoted_text, s.decision.rationale);
        return overlap > (best?.overlap ?? -1) ? { c, overlap } : best;
      },
      null as { c: typeof res.citations[0]; overlap: number } | null
    );

    const actor_correct   = bestCitation?.c.actor.id === s.agent_id;
    const source_correct  = bestCitation?.c.source === "agent";
    const quote_overlap   = bestCitation?.overlap ?? 0;
    const quote_grounded  = quote_overlap >= 0.25;
    const marker_present  = res.answer.toLowerCase().includes(s.unique_marker.toLowerCase()) ||
                            (bestCitation?.c.quoted_text ?? "").toLowerCase().includes(s.unique_marker.toLowerCase());

    const kw_matched = s.expected_keywords.filter((kw) =>
      res.answer.toLowerCase().includes(kw.toLowerCase())
    ).length;

    const pass = actor_correct && source_correct && quote_grounded;

    results.push({
      agent_id: s.agent_id,
      query: s.query,
      actor_correct,
      source_correct,
      quote_grounded,
      marker_present,
      citation_actor_id: bestCitation?.c.actor.id ?? "(none)",
      citation_source: bestCitation?.c.source ?? "(none)",
      quote_overlap: Math.round(quote_overlap * 100) / 100,
      content_keywords_matched: kw_matched,
      content_keywords_total: s.expected_keywords.length,
      latency_ms,
      pass,
    });

    const icon = pass ? "✓" : "✗";
    console.log(`  ${icon} ${s.agent_id.padEnd(12)} "${s.query.slice(0, 50)}..."`);
    console.log(`      actor  : expected="${s.agent_id}"  got="${bestCitation?.c.actor.id ?? "none"}"  ${actor_correct ? "✓" : "✗ MISMATCH"}`);
    console.log(`      source : expected="agent"  got="${bestCitation?.c.source ?? "none"}"  ${source_correct ? "✓" : "✗ MISMATCH"}`);
    console.log(`      quote  : overlap=${quote_overlap.toFixed(2)}  ${quote_grounded ? "✓" : "✗ LOW"}`);
    console.log(`      marker : ${marker_present ? "present ✓" : "absent  ✗"}  (unique phrase from seeded rationale)`);
    console.log(`      content: ${kw_matched}/${s.expected_keywords.length} keywords  latency=${latency_ms}ms\n`);

  } catch (e) {
    const latency_ms = Date.now() - t0;
    results.push({
      agent_id: s.agent_id, query: s.query,
      actor_correct: false, source_correct: false, quote_grounded: false, marker_present: false,
      citation_actor_id: "ERROR", citation_source: "ERROR",
      quote_overlap: 0, content_keywords_matched: 0, content_keywords_total: s.expected_keywords.length,
      latency_ms, pass: false,
    });
    console.log(`  ✗ ${s.agent_id}: ${(e as Error).message}\n`);
  }
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

const passed       = results.filter((r) => r.pass).length;
const total        = results.length;
const actorCorrect = results.filter((r) => r.actor_correct).length;
const srcCorrect   = results.filter((r) => r.source_correct).length;
const grounded     = results.filter((r) => r.quote_grounded).length;
const markersFound = results.filter((r) => r.marker_present).length;
const latencies    = results.map((r) => r.latency_ms).sort((a, b) => a - b);
const p50          = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
const p95          = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const TARGET       = 0.80;
const overallPass  = passed / total >= TARGET;

console.log("── Scorecard ──\n");
console.log(`  Decisions seeded         : ${total}`);
console.log(`  Attribution correct      : ${passed}/${total}  (actor + source + quote all pass)`);
console.log(`  Actor.id correct         : ${actorCorrect}/${total}`);
console.log(`  Source type correct      : ${srcCorrect}/${total}`);
console.log(`  Quote grounded (≥ 0.25)  : ${grounded}/${total}`);
console.log(`  Unique marker in answer  : ${markersFound}/${total}  (exact phrase from seeded rationale)`);
console.log(`  Latency p50 / p95        : ${p50}ms / ${p95}ms`);
console.log();

if (overallPass) {
  console.log(`  ✓ PASS — ${passed}/${total} attribution correct (≥${TARGET * 100}% target met)`);
} else {
  console.log(`  ✗ FAIL — ${passed}/${total} attribution correct (below ${TARGET * 100}% target)`);
  console.log();
  console.log("  Failures:");
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`    ${r.agent_id}: actor=${r.actor_correct ? "ok" : `got "${r.citation_actor_id}"`}  source=${r.source_correct ? "ok" : `got "${r.citation_source}"`}  overlap=${r.quote_overlap}`);
  }
}
console.log();

console.log("  Cleaning up eval data...");
cleanupEvalProjects([PROJECT]).then(() => {
  process.exit(overallPass ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
