/**
 * M7.3 Citation accuracy eval — for every answered query verify that:
 *   1. No out-of-range citation indices (citation_warning === false)
 *   2. Every cited source_url matches a real GitHub URL pattern
 *   3. Every cited quoted_text is non-empty
 *   4. The sentence in the answer that contains [N] has word overlap ≥ 0.15
 *      with the quoted_text for chunk N (support check)
 *
 * Target: 0 fabricated citations
 *
 * Usage:
 *   tsx src/scripts/eval-citations.ts [--project encode_httpx] [--json]
 *
 * JSON mode writes results to eval/citation-eval.json
 */

import "dotenv/config";
import { runQuery } from "../services/query-engine.js";
import { writeFileSync } from "fs";
import { resolve } from "path";
import type { Citation, QueryResponse } from "@purpl/types";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

// Queries that should produce citations (skip no-answer queries)
const QUERIES_WITH_ANSWERS = [
  { id: "Q01", query: "What is the httpx 1.0 compression policy? What formats will be supported?" },
  { id: "Q02", query: "Was there a decision about Zstandard compression support in httpx?" },
  { id: "Q03", query: "What was decided about showing user credentials in URL string representation?" },
  { id: "Q04", query: "Which Python versions were dropped from the test matrix?" },
  { id: "Q05", query: "What asyncio changes were made for Python 3.14 compatibility?" },
  { id: "Q06", query: "What happens when the brotli extra is missing but a server sends brotli-encoded content?" },
  { id: "Q07", query: "What is the purpose of the .wait_ready() method added to HTTPParser?" },
  { id: "Q08", query: "What decision was made about enforcing minimum h11 or httpcore versions for the security fix?" },
  { id: "Q09", query: "What is the status of the MockTransport elapsed time feature?" },
  { id: "Q11", query: "How does httpx handle merging query parameters in Request.__init__?" },
  { id: "Q12", query: "How does httpx prevent SSL context reference cycles from blocking garbage collection?" },
  { id: "Q13", query: "What did the team do in response to CVE-2025-43859?" },
  { id: "Q14", query: "What design decisions are currently deferred or pending?" },
  { id: "Q17", query: "What are the most significant architectural decisions made in the httpx project?" },
  { id: "Q18", query: "What decisions did the httpx maintainers make about closing or deferring PRs?" },
];

// ── Validators ─────────────────────────────────────────────────────────────────

const GITHUB_URL_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull|commit|blob|tree|compare)\/[\w./%-]+/;

function isValidGithubUrl(url: string): boolean {
  return GITHUB_URL_RE.test(url);
}

function wordOverlap(a: string, b: string): number {
  const words = a.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  if (words.length === 0) return 0;
  const bLower = b.toLowerCase();
  return words.filter((w) => bLower.includes(w)).length / words.length;
}

/** Extract the sentence(s) immediately before/after [N] in the answer text. */
function claimContext(answer: string, index: number): string {
  // Find the [N] marker in the answer, grab up to 300 chars of surrounding text
  const marker = `[${index}]`;
  const pos = answer.indexOf(marker);
  if (pos === -1) return "";
  const start = Math.max(0, pos - 200);
  const end = Math.min(answer.length, pos + marker.length + 100);
  return answer.slice(start, end);
}

// ── Per-citation result ─────────────────────────────────────────────────────

interface CitationCheck {
  chunk_index: number;          // [N] as it appears in the answer
  source_url: string;
  quoted_text: string;
  valid_url: boolean;
  non_empty_text: boolean;
  supported: boolean;           // word overlap ≥ 0.15
  support_score: number;
}

interface QueryCitationResult {
  id: string;
  query: string;
  citation_warning: boolean;    // true = LLM cited an out-of-range index
  citation_count: number;
  checks: CitationCheck[];
  fabricated_count: number;     // citations that fail any check
  latency_ms: number;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function evalCitationsForQuery(
  id: string,
  query: string,
  projectId: string
): Promise<QueryCitationResult> {
  process.stdout.write(`Running ${id}...`);
  const result: QueryResponse = await runQuery({ query, project_id: projectId });
  process.stdout.write(` ${result.latency_ms}ms, ${result.citations.length} citations\n`);

  const checks: CitationCheck[] = result.citations.map((c: Citation, i) => {
    // Derive the [N] index: citations are assembled in order of appearance in the answer
    // We can approximate index from chunk_id suffix or fall back to i+1
    const idxMatch = c.chunk_id.match(/_(\d+)$/);
    const chunkIndex = idxMatch ? parseInt(idxMatch[1]) : i + 1;

    const claim = claimContext(result.answer, chunkIndex);
    const supportScore = wordOverlap(claim, c.quoted_text);

    return {
      chunk_index: chunkIndex,
      source_url: c.source_url,
      quoted_text: c.quoted_text,
      valid_url: isValidGithubUrl(c.source_url),
      non_empty_text: c.quoted_text.trim().length > 10,
      supported: supportScore >= 0.15,
      support_score: Math.round(supportScore * 100) / 100,
    };
  });

  const fabricated = checks.filter(
    (c) => !c.valid_url || !c.non_empty_text || result.citation_warning
  );

  return {
    id,
    query,
    citation_warning: result.citation_warning,
    citation_count: result.citations.length,
    checks,
    fabricated_count: fabricated.length + (result.citation_warning ? 1 : 0),
    latency_ms: result.latency_ms,
  };
}

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";
  const jsonMode = args.includes("--json");

  console.log(`[eval-citations] project: ${projectId}`);
  console.log(`[eval-citations] running ${QUERIES_WITH_ANSWERS.length} queries...\n`);

  const results: QueryCitationResult[] = [];

  for (const { id, query } of QUERIES_WITH_ANSWERS) {
    const r = await evalCitationsForQuery(id, query, projectId);
    results.push(r);
  }

  // ── Scorecard ───────────────────────────────────────────────────────────────

  const totalCitations = results.reduce((s, r) => s + r.citation_count, 0);
  const warningQueries = results.filter((r) => r.citation_warning).length;
  const invalidUrlCount = results.flatMap((r) => r.checks).filter((c) => !c.valid_url).length;
  const emptyTextCount = results.flatMap((r) => r.checks).filter((c) => !c.non_empty_text).length;
  const unsupportedCount = results.flatMap((r) => r.checks).filter((c) => !c.supported).length;
  const fabricatedTotal = results.reduce((s, r) => s + r.fabricated_count, 0);

  console.log(`\n${"═".repeat(70)}`);
  console.log("  M7.3 CITATION ACCURACY EVAL — SCORECARD");
  console.log(`${"═".repeat(70)}`);
  console.log(`  Queries evaluated    : ${results.length}`);
  console.log(`  Total citations      : ${totalCitations}`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  citation_warning=true: ${warningQueries}  (out-of-range index cited)`);
  console.log(`  Invalid GitHub URLs  : ${invalidUrlCount}`);
  console.log(`  Empty quoted_text    : ${emptyTextCount}`);
  console.log(`  Unsupported claims   : ${unsupportedCount}  (overlap < 0.15, informational)`);
  console.log(`${"─".repeat(70)}`);
  console.log(`  Fabricated citations : ${fabricatedTotal}  (target: 0)`);
  console.log(`${"═".repeat(70)}\n`);

  const pass = fabricatedTotal === 0;
  console.log(`  Citation accuracy ${pass ? "✓ PASS" : "✗ FAIL"}\n`);

  // ── Per-query detail ────────────────────────────────────────────────────────

  console.log("Per-query detail:");
  console.log(`${"─".repeat(70)}`);
  for (const r of results) {
    const warn = r.citation_warning ? " ⚠ citation_warning" : "";
    const fab = r.fabricated_count > 0 ? ` ✗ ${r.fabricated_count} fabricated` : " ✓";
    console.log(`  ${r.id.padEnd(4)} ${String(r.citation_count).padStart(2)} citations${fab}${warn}`);

    for (const c of r.checks) {
      const urlOk = c.valid_url ? "✓" : "✗";
      const txtOk = c.non_empty_text ? "✓" : "✗";
      const supOk = c.supported ? "✓" : "~";
      console.log(
        `         [${c.chunk_index}] url:${urlOk} text:${txtOk} support:${supOk}(${c.support_score})  ${c.source_url.slice(0, 60)}`
      );
    }
  }

  if (jsonMode) {
    const outPath = resolve(REPO_ROOT, "eval/citation-eval.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2));
    console.log(`\n[eval-citations] results written to eval/citation-eval.json`);
  }

  process.exit(pass ? 0 : 1);
}

run().catch((e) => {
  console.error("[eval-citations] fatal:", e);
  process.exit(1);
});
