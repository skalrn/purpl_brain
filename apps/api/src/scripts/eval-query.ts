/**
 * M6 multi-source query accuracy eval — 22 queries spanning GitHub, Slack,
 * meetings, and Jira sources.
 *
 * Scoring: each query is graded correct / partial / incorrect / no-info
 * Target: > 80% correct or partially correct
 *
 * Usage:
 *   tsx src/scripts/eval-query.ts [--project encode_httpx] [--json]
 *
 * Interactive mode (default): prints each answer and prompts for a grade.
 * JSON mode (--json): runs all queries, dumps results to eval/query-eval.json
 * for offline scoring.
 */

import "dotenv/config";
import { runQuery } from "../services/query-engine.js";
import { createInterface } from "readline";
import { writeFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

// ── Test suite ─────────────────────────────────────────────────────────────────

interface TestQuery {
  id: string;
  query: string;
  expected_facts: string[];     // key facts the answer should contain
  should_have_answer: boolean;  // false = "no info" is the correct answer
}

const TEST_QUERIES: TestQuery[] = [
  // Compression policy
  {
    id: "Q01",
    query: "What is the httpx 1.0 compression policy? What formats will be supported?",
    expected_facts: ["gzip only", "zstd/zstandard deferred or not included"],
    should_have_answer: true,
  },
  {
    id: "Q02",
    query: "Was there a decision about Zstandard compression support in httpx?",
    expected_facts: ["gzip only policy", "zstd not included in 1.0"],
    should_have_answer: true,
  },
  // URL credential handling
  {
    id: "Q03",
    query: "What was decided about showing user credentials in URL string representation?",
    expected_facts: ["rejected", "credentials preserved", "URL.__str__ unchanged"],
    should_have_answer: true,
  },
  // Python version support
  {
    id: "Q04",
    query: "Which Python versions were dropped from the test matrix?",
    expected_facts: ["Python 3.10 dropped"],
    should_have_answer: true,
  },
  // asyncio / event loop
  {
    id: "Q05",
    query: "What asyncio changes were made for Python 3.14 compatibility?",
    expected_facts: ["asyncio.get_event_loop() replaced", "explicit event loop creation", "background threads"],
    should_have_answer: true,
  },
  // brotli warning
  {
    id: "Q06",
    query: "What happens when the brotli extra is missing but a server sends brotli-encoded content?",
    expected_facts: ["explicit warning", "not silent", "brotli extra missing"],
    should_have_answer: true,
  },
  // HTTPParser wait_ready
  {
    id: "Q07",
    query: "What is the purpose of the .wait_ready() method added to HTTPParser?",
    expected_facts: ["distinguish clean disconnect from protocol errors", "server disconnect"],
    should_have_answer: true,
  },
  // Security / CVE
  {
    id: "Q08",
    query: "What decision was made about enforcing minimum h11 or httpcore versions for the security fix?",
    expected_facts: ["no constraint", "users can upgrade directly", "no minimum version enforced"],
    should_have_answer: true,
  },
  // MockTransport / deferred
  {
    id: "Q09",
    query: "What is the status of the MockTransport elapsed time feature?",
    expected_facts: ["deferred", "pending design decision", "closed"],
    should_have_answer: true,
  },
  // FunctionAuth
  {
    id: "Q10",
    query: "Is FunctionAuth part of the public httpx API?",
    expected_facts: ["yes", "public API", "__all__", "httpx.FunctionAuth"],
    should_have_answer: true,
  },
  // Query param merging
  {
    id: "Q11",
    query: "How does httpx handle merging query parameters in Request.__init__?",
    expected_facts: ["copy_merge_params", "URL constructor unchanged"],
    should_have_answer: true,
  },
  // Weakref / memory management
  {
    id: "Q12",
    query: "How does httpx prevent SSL context reference cycles from blocking garbage collection?",
    expected_facts: ["weakref", "reference cycle", "SSL context"],
    should_have_answer: true,
  },
  // CVE-2025-43859 phrasing variation
  {
    id: "Q13",
    query: "What did the team do in response to CVE-2025-43859?",
    expected_facts: ["no action required", "no constraint change", "h11 or httpcore"],
    should_have_answer: true,
  },
  // Temporal / "what changed recently" style
  {
    id: "Q14",
    query: "What design decisions are currently deferred or pending?",
    expected_facts: ["MockTransport", "elapsed time", "deferred"],
    should_have_answer: true,
  },
  // Negative: out-of-scope question
  {
    id: "Q15",
    query: "What is the httpx 1.0 release date?",
    expected_facts: [],
    should_have_answer: false,  // not in data — expect "no info" or honest uncertainty
  },
  // Slack-sourced signal
  {
    id: "Q16",
    query: "Is there any team discussion challenging the httpx compression policy?",
    expected_facts: ["gzip", "zstd", "reconsider"],
    should_have_answer: true,
  },
  // Broad summary
  {
    id: "Q17",
    query: "What are the most significant architectural decisions made in the httpx project?",
    expected_facts: ["compression", "asyncio", "URL credentials", "Python versions"],
    should_have_answer: true,
  },
  // Actor-scoped
  {
    id: "Q18",
    query: "What decisions did the httpx maintainers make about closing or deferring PRs?",
    expected_facts: ["deferred", "MockTransport", "closed"],
    should_have_answer: true,
  },
  // Jira-sourced: authentication API decision
  {
    id: "Q19",
    query: "What decision was made about the httpx public authentication API surface?",
    expected_facts: ["synchronous", "sync", "authentication"],
    should_have_answer: true,
  },
  // Jira-sourced: retry policy
  {
    id: "Q20",
    query: "Where should retry logic live in httpx — in the core client or elsewhere?",
    expected_facts: ["middleware", "transport", "not part of the core"],
    should_have_answer: true,
  },
  // Cross-source drift awareness
  {
    id: "Q21",
    query: "Are there signals suggesting the asyncio.get_event_loop decision should be revisited?",
    expected_facts: ["compatibility", "third-party", "revisit"],
    should_have_answer: true,
  },
  // Negative: no data from future events
  {
    id: "Q22",
    query: "What decisions were made about GraphQL support in httpx?",
    expected_facts: [],
    should_have_answer: false,
  },
];

// ── Scoring ────────────────────────────────────────────────────────────────────

type Grade = "correct" | "partial" | "incorrect" | "no-info";

interface EvalRow {
  id: string;
  query: string;
  expected_facts: string[];
  should_have_answer: boolean;
  answer: string;
  citations: number;
  latency_ms: number;
  grade?: Grade;
  notes?: string;
}

function wordOverlap(needle: string, haystack: string): number {
  const words = needle.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (words.length === 0) return 0;
  const matched = words.filter((w) => haystack.toLowerCase().includes(w));
  return matched.length / words.length;
}

function autoGrade(row: EvalRow): Grade | null {
  const lower = row.answer.toLowerCase();

  // If we expect no answer and the model admits it — correct no-info
  if (!row.should_have_answer) {
    const noInfoPhrases = [
      "no relevant", "not enough information", "don't have", "no information",
      "not found", "no data", "not available", "cannot find", "no specific",
      "does not contain", "no mention", "not provided",
    ];
    if (noInfoPhrases.some((p) => lower.includes(p))) return "no-info";
    return null; // needs human judgment
  }

  if (row.expected_facts.length === 0) return null;

  // Score each expected fact via word overlap against the answer
  const scores = row.expected_facts.map((f) =>
    Math.max(...f.toLowerCase().split("/").map((alt) => wordOverlap(alt.trim(), lower)))
  );
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  const strongMatches = scores.filter((s) => s >= 0.5).length;

  if (strongMatches === 0 && avg < 0.2) return "incorrect";
  if (strongMatches >= Math.ceil(row.expected_facts.length * 0.6)) return "correct";
  return "partial";
}

// ── Interactive prompt ────────────────────────────────────────────────────────

async function promptGrade(rl: ReturnType<typeof createInterface>, row: EvalRow): Promise<Grade> {
  const auto = autoGrade(row);
  return new Promise((resolve) => {
    const hint = auto ? ` [auto: ${auto}]` : "";
    rl.question(`  Grade (c=correct / p=partial / i=incorrect / n=no-info)${hint}: `, (ans) => {
      const map: Record<string, Grade> = { c: "correct", p: "partial", i: "incorrect", n: "no-info" };
      resolve(map[ans.trim().toLowerCase()] ?? auto ?? "incorrect");
    });
  });
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId  = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";
  const jsonMode   = args.includes("--json");

  console.log(`[eval-query] project: ${projectId}, mode: ${jsonMode ? "json" : "interactive"}`);
  console.log(`[eval-query] running ${TEST_QUERIES.length} queries (M6 multi-source)...\n`);

  const rows: EvalRow[] = [];

  for (const tq of TEST_QUERIES) {
    process.stdout.write(`Running ${tq.id}...`);
    const result = await runQuery({ query: tq.query, project_id: projectId });
    process.stdout.write(` ${result.latency_ms}ms\n`);

    rows.push({
      id: tq.id,
      query: tq.query,
      expected_facts: tq.expected_facts,
      should_have_answer: tq.should_have_answer,
      answer: result.answer,
      citations: result.citations.length,
      latency_ms: result.latency_ms,
    });
  }

  if (jsonMode) {
    // Auto-grade and dump
    for (const row of rows) {
      row.grade = autoGrade(row) ?? "incorrect";
    }
    const outPath = resolve(REPO_ROOT, "eval/query-eval.json");
    writeFileSync(outPath, JSON.stringify(rows, null, 2));
    console.log(`\n[eval-query] results written to eval/query-eval.json`);
  } else {
    // Interactive scoring
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    for (const row of rows) {
      console.log(`\n${"═".repeat(70)}`);
      console.log(`${row.id}: ${row.query}`);
      console.log(`${"─".repeat(70)}`);
      console.log(`Expected facts: ${row.expected_facts.length > 0 ? row.expected_facts.join(", ") : "(no answer expected)"}`);
      console.log(`${"─".repeat(70)}`);
      console.log(`Answer (${row.latency_ms}ms, ${row.citations} citations):\n${row.answer}`);
      console.log(`${"─".repeat(70)}`);

      row.grade = await promptGrade(rl, row);
    }

    rl.close();
  }

  // ── Scorecard ─────────────────────────────────────────────────────────────

  const graded = rows.filter((r) => r.grade !== undefined);
  const correct  = graded.filter((r) => r.grade === "correct").length;
  const partial  = graded.filter((r) => r.grade === "partial").length;
  const incorrect = graded.filter((r) => r.grade === "incorrect").length;
  const noInfo   = graded.filter((r) => r.grade === "no-info").length;
  const passCount = correct + partial + noInfo; // no-info on expected-no-info is correct
  const accuracy = graded.length === 0 ? 0 : passCount / graded.length;

  const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;

  console.log(`\n${"═".repeat(70)}`);
  console.log("  M7.2 QUERY ACCURACY EVAL — SCORECARD");
  console.log(`${"═".repeat(70)}`);
  console.log(`  Queries evaluated  : ${graded.length}`);
  console.log(`  Correct            : ${correct}`);
  console.log(`  Partial            : ${partial}`);
  console.log(`  No-info (expected) : ${noInfo}`);
  console.log(`  Incorrect          : ${incorrect}`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  Accuracy (C+P+N)   : ${(accuracy * 100).toFixed(1)}%  (target: >80%)`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  Latency p50        : ${p50}ms`);
  console.log(`  Latency p95        : ${p95}ms  (target: <5000ms)`);
  console.log(`${"═".repeat(70)}\n`);

  const pass = accuracy >= 0.80;
  console.log(`  Accuracy ${pass ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`  Latency p95 ${p95 < 5000 ? "✓ PASS" : "✗ FAIL"}`);
  console.log("");

  if (!pass) {
    const byGrade = rows.filter((r) => r.grade === "incorrect" || r.grade === "partial");
    if (byGrade.length > 0) {
      console.log("FAILURES:");
      for (const row of byGrade) {
        console.log(`  ${row.grade?.toUpperCase().padEnd(10)} ${row.id}: ${row.query.slice(0, 60)}`);
        console.log(`             Expected: ${row.expected_facts.join(", ")}`);
        console.log(`             Got:      ${row.answer.slice(0, 120)}`);
      }
    }
  }

  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error("[eval-query] fatal:", e);
  process.exit(1);
});
