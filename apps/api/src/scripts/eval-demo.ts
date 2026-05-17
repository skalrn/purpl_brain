/**
 * M7.5 Demo scenario eval — runs the standard demo queries and verifies
 * the system produces grounded, cited answers for the defined demo flow.
 *
 * This is the Phase 1 portfolio artifact: proof that the system works
 * end-to-end on a realistic catch-up scenario.
 *
 * Usage:
 *   tsx src/scripts/eval-demo.ts [--project encode_httpx]
 */

import "dotenv/config";
import { runQuery } from "../services/query-engine.js";

const DEMO_QUERIES = [
  {
    label: "Compression policy",
    query: "What is the httpx 1.0 compression policy? What formats will be supported?",
    must_mention: ["gzip"],
    must_cite: true,
  },
  {
    label: "Breaking changes — Python versions",
    query: "Which Python versions were dropped from the test matrix?",
    must_mention: ["3.10", "dropped"],
    must_cite: true,
  },
  {
    label: "Security / CVE",
    query: "What did the team do in response to CVE-2025-43859?",
    must_mention: ["h11", "httpcore"],
    must_cite: true,
  },
  {
    label: "Deferred decisions",
    query: "What design decisions are currently deferred or pending?",
    must_mention: ["deferred"],
    must_cite: true,
  },
  {
    label: "Scope honesty — unknown fact",
    query: "What is the httpx 1.0 release date?",
    must_mention: [],
    must_cite: false,
    expect_no_answer: true,
  },
];

function contains(answer: string, keywords: string[]): boolean {
  const lower = answer.toLowerCase();
  return keywords.every((k) => lower.includes(k.toLowerCase()));
}

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";
  const provider = process.env.LLM_PROVIDER ?? "ollama";

  console.log(`\n${"═".repeat(70)}`);
  console.log("  M7.5 DEMO SCENARIO — END-TO-END VERIFICATION");
  console.log(`${"═".repeat(70)}`);
  console.log(`  Provider: ${provider}  |  Project: ${projectId}\n`);

  let passed = 0;
  let failed = 0;

  for (const scenario of DEMO_QUERIES) {
    console.log(`▶ ${scenario.label}`);
    console.log(`  Q: ${scenario.query}`);

    const result = await runQuery({ query: scenario.query, project_id: projectId });

    const keywordsOk = scenario.must_mention.length === 0 || contains(result.answer, scenario.must_mention);
    const citationOk = !scenario.must_cite || result.citations.length > 0;
    const noWarn = !result.citation_warning;

    const noAnswerOk = !scenario.expect_no_answer ||
      /no (relevant|information|data|specific|mention)|not (found|available|provided)|cannot find|don't have/i.test(result.answer);

    const ok = keywordsOk && citationOk && noWarn && noAnswerOk;

    if (ok) {
      passed++;
      console.log(`  ✓ PASS  (${result.latency_ms}ms, ${result.citations.length} citations)`);
    } else {
      failed++;
      console.log(`  ✗ FAIL  (${result.latency_ms}ms, ${result.citations.length} citations)`);
      if (!keywordsOk) console.log(`    missing keywords: ${scenario.must_mention.join(", ")}`);
      if (!citationOk) console.log(`    expected citations, got 0`);
      if (!noWarn)     console.log(`    citation_warning=true`);
      if (!noAnswerOk) console.log(`    expected 'no info' answer`);
    }

    console.log(`  A: ${result.answer.slice(0, 200).replace(/\n/g, " ")}${result.answer.length > 200 ? "…" : ""}`);
    if (result.citations.length > 0) {
      console.log(`  Sources:`);
      for (const c of result.citations.slice(0, 3)) {
        console.log(`    • ${c.source_url}`);
      }
    }
    console.log();
  }

  console.log(`${"═".repeat(70)}`);
  console.log(`  Demo scenarios: ${passed} passed, ${failed} failed`);
  const pass = failed === 0;
  console.log(`  Demo eval ${pass ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`${"═".repeat(70)}\n`);

  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error("[eval-demo] fatal:", e);
  process.exit(1);
});
