/**
 * Query accuracy eval — 22 queries spanning Hono open-source project decisions.
 *
 * Corpus: honojs/hono GitHub PRs, issues, CONTRIBUTING.md, MIGRATION.md
 * Scoring: each query is graded correct / partial / incorrect / no-info
 * Target: > 80% correct or partially correct
 *
 * Usage:
 *   tsx src/scripts/eval-query.ts [--project honojs_hono] [--json]
 *
 * Interactive mode (default): prints each answer and prompts for a grade.
 * JSON mode (--json): runs all queries, dumps results to eval/query-eval.json
 * for offline scoring.
 */

import "dotenv/config";
import { runQuery } from "../../services/query-engine.js";
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
  // Router architecture — core design decision
  {
    id: "Q01",
    query: "Why does Hono use RegExpRouter instead of a trie-based router?",
    expected_facts: ["performance", "regexp", "trie", "routing speed"],
    should_have_answer: true,
  },
  // v4 breaking change rationale
  {
    id: "Q02",
    query: "Why was app.head() changed to be implicit in Hono v4?",
    expected_facts: ["implicit", "HEAD", "v4", "breaking"],
    should_have_answer: true,
  },
  // Context extension decision
  {
    id: "Q03",
    query: "What did the team decide about extending the Context object in Hono?",
    expected_facts: ["context", "extend", "type"],
    should_have_answer: true,
  },
  // URI decoding
  {
    id: "Q04",
    query: "What was decided about URI decoding behavior in the Hono router?",
    expected_facts: ["URI", "decode", "router", "path"],
    should_have_answer: true,
  },
  // Middleware rejections
  {
    id: "Q05",
    query: "What middleware proposals were rejected in Hono and why?",
    expected_facts: ["middleware", "rejected"],
    should_have_answer: true,
  },
  // JSR migration
  {
    id: "Q06",
    query: "Why did Hono migrate from deno.land/x to JSR?",
    expected_facts: ["JSR", "deno.land", "migration", "registry"],
    should_have_answer: true,
  },
  // TypeScript validator types
  {
    id: "Q07",
    query: "What was decided about TypeScript type inference in Hono validators?",
    expected_facts: ["TypeScript", "type", "validator", "inference"],
    should_have_answer: true,
  },
  // Breaking changes policy
  {
    id: "Q08",
    query: "What is Hono's policy for introducing breaking changes?",
    expected_facts: ["breaking", "semver", "major", "version"],
    should_have_answer: true,
  },
  // Most contested decision
  {
    id: "Q09",
    query: "What has been the most contested design decision in Hono's history?",
    expected_facts: [],
    should_have_answer: true,
  },
  // Runtime support scope
  {
    id: "Q10",
    query: "What runtimes does Hono officially support and how was that scope decided?",
    expected_facts: ["runtime", "Cloudflare", "Deno", "Bun", "Node"],
    should_have_answer: true,
  },
  // v3 to v4 API changes
  {
    id: "Q11",
    query: "What changed in Hono's API design between v3 and v4?",
    expected_facts: ["v3", "v4", "breaking", "API"],
    should_have_answer: true,
  },
  // Contributor architecture decisions
  {
    id: "Q12",
    query: "What architectural decisions has yusukebe made about Hono's core?",
    expected_facts: ["yusukebe", "architecture", "core"],
    should_have_answer: true,
  },
  // Middleware bundling
  {
    id: "Q13",
    query: "How does Hono decide what goes into the core package vs external middleware?",
    expected_facts: ["core", "middleware", "package", "bundled"],
    should_have_answer: true,
  },
  // Testing approach
  {
    id: "Q14",
    query: "What testing approach does Hono use and why was it chosen?",
    expected_facts: ["test", "vitest", "jest"],
    should_have_answer: true,
  },
  // Negative: out-of-scope
  {
    id: "Q15",
    query: "What is the Hono v5 release date?",
    expected_facts: [],
    should_have_answer: false,  // not in data — expect "no info"
  },
  // c.json vs Response
  {
    id: "Q16",
    query: "What was decided about c.json() helper vs returning raw Response objects?",
    expected_facts: ["c.json", "Response", "helper"],
    should_have_answer: true,
  },
  // Bundler / build tooling
  {
    id: "Q17",
    query: "What build tooling decisions were made for Hono's multi-runtime output?",
    expected_facts: ["build", "bundle", "tsup", "ESM"],
    should_have_answer: true,
  },
  // Error handling
  {
    id: "Q18",
    query: "How does Hono handle errors and what decisions shaped the error API?",
    expected_facts: ["error", "handler", "HTTPException"],
    should_have_answer: true,
  },
  // Hono client (hc)
  {
    id: "Q19",
    query: "What was the rationale behind adding the Hono client (hc)?",
    expected_facts: ["hc", "client", "type", "RPC"],
    should_have_answer: true,
  },
  // Streaming
  {
    id: "Q20",
    query: "What decisions were made about streaming response support in Hono?",
    expected_facts: ["stream", "streaming", "response"],
    should_have_answer: true,
  },
  // Negative: GraphQL
  {
    id: "Q21",
    query: "Does Hono have a built-in GraphQL server and what was decided about it?",
    expected_facts: [],
    should_have_answer: false,
  },
  // Broad summary
  {
    id: "Q22",
    query: "What are the most significant architectural decisions made in the Hono project?",
    expected_facts: ["router", "middleware", "TypeScript", "runtime"],
    should_have_answer: true,
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
  const projectId  = projectIdx !== -1 ? args[projectIdx + 1] : "honojs_hono";
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
