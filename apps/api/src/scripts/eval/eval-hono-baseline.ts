/**
 * eval-hono-baseline.ts — plain-RAG vs full-brain on the Hono real-world corpus
 *
 * Uses eval/query-eval.json as external ground truth (22 questions, manually
 * graded). Ground truth is not derived from brain output — grades were assigned
 * from the Hono GitHub history independently.
 *
 * Conditions:
 *   B — plain-RAG:  mode "plain-rag" — Qdrant only, no Neo4j graph traversal
 *   C — full brain: mode "project"   — Qdrant + Neo4j multi-hop graph expansion
 *
 * Also reports delta vs the stored baseline grade from query-eval.json so we can
 * see whether the full brain improved, regressed, or held steady since last eval.
 *
 * Run: npm run eval:hono-baseline -w apps/api
 * Requires: GITHUB_TOKEN seeded corpus (npm run seed:hono -w apps/api)
 *
 * Results saved to eval/hono-baseline-results.json
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// ── Config ─────────────────────────────────────────────────────────────────────

const API_BASE   = process.env.API_BASE      ?? "http://localhost:3741";
const API_KEY    = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "dev-local";
const PROJECT_ID = "honojs_hono";

const _apiKey       = process.env.ANTHROPIC_API_KEY ?? "";
const _validKey     = _apiKey.startsWith("sk-ant-api") && _apiKey.length > 30;
const USE_ANTHROPIC = process.env.LLM_PROVIDER === "anthropic" || (!process.env.LLM_PROVIDER && _validKey);
const OLLAMA_BASE   = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const JUDGE_MODEL   = USE_ANTHROPIC
  ? "claude-haiku-4-5-20251001"
  : (process.env.OLLAMA_SMART_MODEL ?? "llama3.1:8b");

const anthropic = USE_ANTHROPIC ? new Anthropic({ apiKey: _apiKey }) : null;
const ollama    = !USE_ANTHROPIC ? new OpenAI({ baseURL: OLLAMA_BASE, apiKey: "ollama" }) : null;

const __dirname    = fileURLToPath(new URL(".", import.meta.url));
const GT_PATH      = join(__dirname, "../../../../../eval/query-eval.json");
const RESULTS_PATH = join(__dirname, "../../../../../eval/hono-baseline-results.json");

// ── Types ──────────────────────────────────────────────────────────────────────

type Grade = "correct" | "partial" | "incorrect" | "no-info";

interface QueryEvalEntry {
  id: string;
  query: string;
  expected_facts: string[];
  should_have_answer: boolean;
  answer: string;       // stored baseline answer
  citations: number;
  latency_ms: number;
  grade: Grade;         // stored baseline grade
}

interface ConditionResult {
  answer: string;
  citations: number;
  latency_ms: number;
  grade: Grade;
  facts_found: string[];
  facts_missing: string[];
  judge_reasoning: string;
}

interface QuestionResult {
  id: string;
  query: string;
  should_have_answer: boolean;
  baseline_grade: Grade;
  plain_rag: ConditionResult;
  full_brain: ConditionResult;
  winner: "full_brain" | "plain_rag" | "tie";
  baseline_delta: { plain_rag: number; full_brain: number }; // vs stored grade
}

// ── LLM ───────────────────────────────────────────────────────────────────────

async function llmComplete(system: string, user: string, maxTokens = 400): Promise<string> {
  if (anthropic) {
    const res = await anthropic.messages.create({
      model: JUDGE_MODEL,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as unknown as Anthropic.Messages.TextBlockParam[],
      messages: [{ role: "user", content: user }],
    });
    return res.content.find(b => b.type === "text")?.text ?? "";
  }
  const res = await ollama!.chat.completions.create({
    model: JUDGE_MODEL, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return res.choices[0]?.message?.content ?? "";
}

// ── Query ──────────────────────────────────────────────────────────────────────

async function queryBrain(
  query: string,
  mode: "project" | "plain-rag"
): Promise<{ answer: string; citations: number; latency_ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${API_BASE}/brain/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
    body: JSON.stringify({ query, project_id: PROJECT_ID, mode }),
  });
  const latency_ms = Date.now() - t0;
  if (!res.ok) return { answer: `[HTTP ${res.status}]`, citations: 0, latency_ms };
  const body = await res.json() as { answer?: string; citations?: unknown[]; latency_ms?: number };
  return {
    answer: body.answer ?? "",
    citations: (body.citations ?? []).length,
    latency_ms: body.latency_ms ?? latency_ms,
  };
}

// ── Judge ──────────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are grading an answer about the Hono web framework project.

Rules:
- CORRECT: answer addresses the question and contains the expected concepts. If should_have_answer=false, CORRECT means the answer honestly says it doesn't know (no hallucination).
- PARTIAL: answer is on-topic but missing some expected concepts, or hedges too much on a question it should answer.
- INCORRECT: answer is wrong, contradicts known facts, or gives a confident answer when should_have_answer=false (hallucination).
- NO-INFO: only valid when should_have_answer=false AND the answer honestly says there is no information.

Respond only in JSON.`;

interface JudgeResult {
  grade: Grade;
  facts_found: string[];
  facts_missing: string[];
  reasoning: string;
}

async function judge(entry: QueryEvalEntry, answer: string): Promise<JudgeResult> {
  const factsSection = entry.expected_facts.length > 0
    ? `Expected concepts/keywords (check which appear in the answer):\n${entry.expected_facts.map((f, i) => `  ${i + 1}. "${f}"`).join("\n")}`
    : "No specific facts required — grade on whether answer is honest about having no information.";

  const prompt = `Question: ${entry.query}
should_have_answer: ${entry.should_have_answer}

${factsSection}

Answer to grade:
${answer.slice(0, 1200)}

Return JSON:
{
  "grade": "correct" | "partial" | "incorrect" | "no-info",
  "facts_found": [...expected concepts that appear in the answer...],
  "facts_missing": [...expected concepts absent from the answer...],
  "reasoning": "one sentence explaining the grade"
}`;

  try {
    const text = await llmComplete(JUDGE_SYSTEM, prompt);
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(clean) as JudgeResult;
  } catch {
    return { grade: "incorrect", facts_found: [], facts_missing: entry.expected_facts, reasoning: "judge parse error" };
  }
}

// ── Scoring ────────────────────────────────────────────────────────────────────

const GRADE_SCORE: Record<Grade, number> = { correct: 2, partial: 1, incorrect: 0, "no-info": 2 };

function gradeLabel(g: Grade): string {
  return { correct: "✓ correct", partial: "~ partial", incorrect: "✗ incorrect", "no-info": "○ no-info" }[g];
}

function winner(pr: Grade, fb: Grade): "full_brain" | "plain_rag" | "tie" {
  const d = GRADE_SCORE[fb] - GRADE_SCORE[pr];
  return d > 0 ? "full_brain" : d < 0 ? "plain_rag" : "tie";
}

function deltaSymbol(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : " 0";
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\neval-hono-baseline: plain-RAG vs full-brain (Hono real corpus)\n");
  console.log(`  project_id : ${PROJECT_ID}`);
  console.log(`  judge      : ${JUDGE_MODEL}`);
  console.log(`  provider   : ${USE_ANTHROPIC ? "Anthropic" : "Ollama"}\n`);

  let gt: QueryEvalEntry[];
  try {
    gt = JSON.parse(readFileSync(GT_PATH, "utf-8")) as QueryEvalEntry[];
  } catch (e) {
    console.error(`Cannot read ground truth from ${GT_PATH}: ${e}`);
    process.exit(1);
  }

  const health = await fetch(`${API_BASE}/health`).catch(() => null);
  if (!health?.ok) { console.error("Brain API not reachable."); process.exit(1); }

  const chunkCount = await fetch("http://localhost:6333/collections/brain_chunks/points/count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { must: [{ key: "project_id", match: { value: PROJECT_ID } }] } }),
  }).then(r => r.json())
    .then((r: { result?: { count: number } }) => r.result?.count ?? 0)
    .catch(() => 0);

  console.log(`  Qdrant chunks : ${chunkCount} for ${PROJECT_ID}`);
  if (chunkCount === 0) {
    console.error("  No chunks. Run: GITHUB_TOKEN=... npm run seed:hono -w apps/api");
    process.exit(1);
  }
  if (chunkCount < 30) {
    console.warn(`  WARNING: only ${chunkCount} chunks — pipeline may still be processing.`);
  }
  console.log(`  Questions     : ${gt.length}\n`);

  const results: QuestionResult[] = [];

  for (const entry of gt) {
    const qNum = results.length + 1;
    console.log(`── ${entry.id} (${qNum}/${gt.length})  baseline:${entry.grade} ──`);
    console.log(`   "${entry.query}"`);

    process.stdout.write("   [B] plain-RAG ... ");
    const prRaw = await queryBrain(entry.query, "plain-rag");
    process.stdout.write(`${prRaw.latency_ms}ms, ${prRaw.citations} cit\n`);

    process.stdout.write("   [C] full brain ... ");
    const fbRaw = await queryBrain(entry.query, "project");
    process.stdout.write(`${fbRaw.latency_ms}ms, ${fbRaw.citations} cit\n`);

    const [prJ, fbJ] = await Promise.all([
      judge(entry, prRaw.answer),
      judge(entry, fbRaw.answer),
    ]);

    const w = winner(prJ.grade, fbJ.grade);
    const bScore = GRADE_SCORE[entry.grade];

    console.log(`   plain-RAG : ${gradeLabel(prJ.grade).padEnd(12)} — ${prJ.reasoning}`);
    console.log(`   full brain: ${gradeLabel(fbJ.grade).padEnd(12)} — ${fbJ.reasoning}`);
    console.log(`   winner    : ${w === "full_brain" ? "FULL BRAIN ↑" : w === "plain_rag" ? "PLAIN RAG ↑" : "TIE"}\n`);

    results.push({
      id: entry.id,
      query: entry.query,
      should_have_answer: entry.should_have_answer,
      baseline_grade: entry.grade,
      plain_rag: { ...prRaw, grade: prJ.grade, facts_found: prJ.facts_found, facts_missing: prJ.facts_missing, judge_reasoning: prJ.reasoning },
      full_brain: { ...fbRaw, grade: fbJ.grade, facts_found: fbJ.facts_found, facts_missing: fbJ.facts_missing, judge_reasoning: fbJ.reasoning },
      winner: w,
      baseline_delta: {
        plain_rag:  GRADE_SCORE[prJ.grade] - bScore,
        full_brain: GRADE_SCORE[fbJ.grade] - bScore,
      },
    });
  }

  // ── Summary ───────────────────────────────────────────────────────────────────

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("RESULTS SUMMARY — Hono corpus");
  console.log("══════════════════════════════════════════════════════════════════\n");

  const totalPR  = results.reduce((n, r) => n + GRADE_SCORE[r.plain_rag.grade], 0);
  const totalFB  = results.reduce((n, r) => n + GRADE_SCORE[r.full_brain.grade], 0);
  const totalBL  = results.reduce((n, r) => n + GRADE_SCORE[r.baseline_grade], 0);
  const maxScore = results.length * 2;

  const fbWins = results.filter(r => r.winner === "full_brain").length;
  const prWins = results.filter(r => r.winner === "plain_rag").length;
  const ties   = results.filter(r => r.winner === "tie").length;

  const avgLatPR = Math.round(results.reduce((n, r) => n + r.plain_rag.latency_ms, 0) / results.length);
  const avgLatFB = Math.round(results.reduce((n, r) => n + r.full_brain.latency_ms, 0) / results.length);
  const avgCitPR = (results.reduce((n, r) => n + r.plain_rag.citations, 0) / results.length).toFixed(1);
  const avgCitFB = (results.reduce((n, r) => n + r.full_brain.citations, 0) / results.length).toFixed(1);

  // Per-question grid
  console.log("  ID    | baseline | plain-RAG    | Δ  | full brain   | Δ  | winner");
  console.log("  ------|----------|--------------|----|--------------|----|------------");
  for (const r of results) {
    const bl  = gradeLabel(r.baseline_grade).padEnd(12);
    const pr  = gradeLabel(r.plain_rag.grade).padEnd(12);
    const fb  = gradeLabel(r.full_brain.grade).padEnd(12);
    const dpr = deltaSymbol(r.baseline_delta.plain_rag).padEnd(3);
    const dfb = deltaSymbol(r.baseline_delta.full_brain).padEnd(3);
    const w   = r.winner === "full_brain" ? "FULL BRAIN ↑" : r.winner === "plain_rag" ? "PLAIN RAG ↑" : "TIE";
    console.log(`  ${r.id.padEnd(6)}| ${bl}| ${pr}| ${dpr}| ${fb}| ${dfb}| ${w}`);
  }

  // Correct/partial/incorrect breakdown
  const count = (arr: QuestionResult[], cond: "plain_rag" | "full_brain" | "baseline_grade", val: Grade) =>
    arr.filter(r => {
      if (cond === "baseline_grade") return r.baseline_grade === val;
      return r[cond].grade === val;
    }).length;

  console.log("\n  ── Totals ───────────────────────────────────────────────────────");
  console.log(`  ${"".padEnd(16)} baseline  plain-RAG  full brain`);
  console.log(`  correct            ${String(count(results,"baseline_grade","correct")).padEnd(9)} ${String(count(results,"plain_rag","correct")).padEnd(10)} ${count(results,"full_brain","correct")}`);
  console.log(`  partial            ${String(count(results,"baseline_grade","partial")).padEnd(9)} ${String(count(results,"plain_rag","partial")).padEnd(10)} ${count(results,"full_brain","partial")}`);
  console.log(`  incorrect          ${String(count(results,"baseline_grade","incorrect")).padEnd(9)} ${String(count(results,"plain_rag","incorrect")).padEnd(10)} ${count(results,"full_brain","incorrect")}`);
  console.log(`  no-info            ${String(count(results,"baseline_grade","no-info")).padEnd(9)} ${String(count(results,"plain_rag","no-info")).padEnd(10)} ${count(results,"full_brain","no-info")}`);
  console.log(`  score              ${String(totalBL).padEnd(3)}/${maxScore}     ${String(totalPR).padEnd(3)}/${maxScore}      ${totalFB}/${maxScore}`);
  console.log(`  question wins                 plain-RAG: ${prWins}   full brain: ${fbWins}   ties: ${ties}`);
  console.log(`  avg latency (ms)              plain-RAG: ${avgLatPR}   full brain: ${avgLatFB}`);
  console.log(`  avg citations                 plain-RAG: ${avgCitPR}   full brain: ${avgCitFB}`);

  // Regression check vs baseline
  const fbRegressions = results.filter(r => r.baseline_delta.full_brain < 0);
  const fbImprovements = results.filter(r => r.baseline_delta.full_brain > 0);
  if (fbRegressions.length > 0) {
    console.log(`\n  ⚠ Full brain REGRESSIONS vs baseline (${fbRegressions.length}):`);
    fbRegressions.forEach(r => console.log(`    ${r.id}: ${gradeLabel(r.baseline_grade)} → ${gradeLabel(r.full_brain.grade)}`));
  }
  if (fbImprovements.length > 0) {
    console.log(`\n  ✓ Full brain IMPROVEMENTS vs baseline (${fbImprovements.length}):`);
    fbImprovements.forEach(r => console.log(`    ${r.id}: ${gradeLabel(r.baseline_grade)} → ${gradeLabel(r.full_brain.grade)}`));
  }

  // Verdict
  console.log("\n  ── Verdict ──────────────────────────────────────────────────────");
  if (totalFB > totalPR) {
    console.log(`  FULL BRAIN WINS  (+${totalFB - totalPR} pts, ${fbWins} question wins vs ${prWins})`);
    console.log(`  Graph traversal adds measurable value on the Hono corpus.`);
  } else if (totalPR > totalFB) {
    console.log(`  PLAIN RAG WINS  (+${totalPR - totalFB} pts, ${prWins} question wins vs ${fbWins})`);
    console.log(`  ⚠ Graph traversal does not add value on this corpus. Architectural review warranted.`);
  } else {
    console.log(`  TIE  (${totalPR}/${maxScore} each, ${ties} ties)`);
    console.log(`  Graph traversal matches but does not beat plain-RAG. Review per-question breakdown.`);
  }

  // Save
  const output = {
    run_at: new Date().toISOString(),
    project_id: PROJECT_ID,
    judge_model: JUDGE_MODEL,
    provider: USE_ANTHROPIC ? "anthropic" : "ollama",
    qdrant_chunks: chunkCount,
    totals: {
      baseline:   { score: totalBL, correct: count(results,"baseline_grade","correct"), partial: count(results,"baseline_grade","partial"), incorrect: count(results,"baseline_grade","incorrect") },
      plain_rag:  { score: totalPR, correct: count(results,"plain_rag","correct"),  partial: count(results,"plain_rag","partial"),  incorrect: count(results,"plain_rag","incorrect"),  avg_latency_ms: avgLatPR, avg_citations: parseFloat(avgCitPR) },
      full_brain: { score: totalFB, correct: count(results,"full_brain","correct"), partial: count(results,"full_brain","partial"), incorrect: count(results,"full_brain","incorrect"), avg_latency_ms: avgLatFB, avg_citations: parseFloat(avgCitFB) },
      max_score: maxScore,
      question_wins: { plain_rag: prWins, full_brain: fbWins, ties },
    },
    questions: results,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2));
  console.log(`\n  Results saved to eval/hono-baseline-results.json\n`);

  process.exit(totalFB >= totalPR ? 0 : 1);
}

main().catch(err => { console.error("eval-hono-baseline crashed:", err); process.exit(1); });
