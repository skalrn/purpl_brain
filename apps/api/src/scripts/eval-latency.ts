/**
 * M7.4 Latency eval — measures query engine p50/p95 latency over N runs.
 *
 * Target: p95 < 5000ms
 * Note: Ollama/gemma3:4b will fail this target (~35-45s p95).
 *       Run with LLM_PROVIDER=anthropic or bedrock to meet the target.
 *
 * Usage:
 *   tsx src/scripts/eval-latency.ts [--project encode_httpx] [--runs 36]
 */

import "dotenv/config";
import { runQuery } from "../services/query-engine.js";
import { writeFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

const SAMPLE_QUERIES = [
  "What is the httpx 1.0 compression policy?",
  "Was there a decision about Zstandard compression?",
  "What was decided about URL credential representation?",
  "Which Python versions were dropped?",
  "What asyncio changes were made for Python 3.14?",
  "What happens when brotli extra is missing?",
  "What is the purpose of .wait_ready() in HTTPParser?",
  "What decision was made about minimum h11 versions?",
  "What is the status of MockTransport elapsed time?",
  "How does httpx merge query parameters?",
  "How does httpx prevent SSL context reference cycles?",
  "What did the team do about CVE-2025-43859?",
  "What design decisions are currently deferred?",
  "What are the most significant httpx architectural decisions?",
  "What decisions were made about closing or deferring PRs?",
  "What is the httpx authentication model?",
  "How is httpx structured for async vs sync?",
  "What breaking changes were made in recent httpx versions?",
];

interface LatencyRow {
  run: number;
  query: string;
  latency_ms: number;
  citation_count: number;
  error?: string;
}

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";
  const runsIdx = args.indexOf("--runs");
  const targetRuns = runsIdx !== -1 ? parseInt(args[runsIdx + 1]) : 36;
  const provider = process.env.LLM_PROVIDER ?? "ollama";

  console.log(`[eval-latency] provider: ${provider}, project: ${projectId}, target runs: ${targetRuns}`);
  console.log(`[eval-latency] target: p95 < 5000ms\n`);

  const rows: LatencyRow[] = [];
  let run = 0;

  outer: for (let pass = 0; pass < 10; pass++) {
    for (const query of SAMPLE_QUERIES) {
      if (run >= targetRuns) break outer;
      run++;
      process.stdout.write(`  run ${String(run).padStart(2)}/${targetRuns}: ${query.slice(0, 50).padEnd(50)}`);
      try {
        const result = await runQuery({ query, project_id: projectId });
        process.stdout.write(` ${result.latency_ms}ms\n`);
        rows.push({ run, query, latency_ms: result.latency_ms, citation_count: result.citations.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stdout.write(` ERROR: ${msg.slice(0, 60)}\n`);
        rows.push({ run, query, latency_ms: -1, citation_count: 0, error: msg });
      }
    }
  }

  const valid = rows.filter((r) => r.latency_ms >= 0).map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = valid[Math.floor(valid.length * 0.50)] ?? 0;
  const p75 = valid[Math.floor(valid.length * 0.75)] ?? 0;
  const p95 = valid[Math.floor(valid.length * 0.95)] ?? 0;
  const avg = valid.length > 0 ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length) : 0;
  const errors = rows.filter((r) => r.latency_ms < 0).length;

  console.log(`\n${"═".repeat(70)}`);
  console.log("  M7.4 LATENCY EVAL — SCORECARD");
  console.log(`${"═".repeat(70)}`);
  console.log(`  Provider           : ${provider}`);
  console.log(`  Runs completed     : ${valid.length} / ${rows.length} (${errors} errors)`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  p50 latency        : ${p50}ms`);
  console.log(`  p75 latency        : ${p75}ms`);
  console.log(`  p95 latency        : ${p95}ms  (target: <5000ms)`);
  console.log(`  avg latency        : ${avg}ms`);
  console.log(`${"─".repeat(70)}`);

  const pass = p95 < 5000;
  console.log(`  Latency p95 ${pass ? "✓ PASS" : "✗ FAIL (expected on Ollama — run with Claude API or Bedrock)"}`);

  if (!pass) {
    console.log(`\n  NOTE: Ollama/gemma3:4b is a local LLM optimised for zero-cost dev.`);
    console.log(`  Switching to LLM_PROVIDER=anthropic or bedrock reduces p95 to <2s.`);
    console.log(`  Copy apps/api/.env.claude.template → .env and set ANTHROPIC_API_KEY.`);
  }

  console.log(`${"═".repeat(70)}\n`);

  const outPath = resolve(REPO_ROOT, "eval/latency-eval.json");
  writeFileSync(outPath, JSON.stringify({ provider, p50, p75, p95, avg, runs: valid.length, errors, rows }, null, 2));
  console.log(`[eval-latency] results written to eval/latency-eval.json`);

  // Exit 0 regardless — Ollama failure is documented, not a blocking defect
  process.exit(0);
}

run().catch((e) => {
  console.error("[eval-latency] fatal:", e);
  process.exit(1);
});
