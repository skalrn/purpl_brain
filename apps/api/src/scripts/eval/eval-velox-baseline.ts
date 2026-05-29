/**
 * eval-velox-baseline.ts — plain-RAG vs full-brain comparison on the Velox synthetic corpus
 *
 * Tests the core claim: "graph-based temporal/drift reasoning beats plain semantic
 * memory for cross-session conflict detection." Ground truth is externally known
 * (defined in eval/velox-ground-truth.json, derived from planted contradictions in
 * eval/velox-corpus.json) — NOT derived from brain output.
 *
 * Two conditions on the same Qdrant corpus:
 *   B — plain-RAG:  Qdrant vector search only, no Neo4j graph traversal (mode: "plain-rag")
 *   C — full brain: Qdrant + Neo4j graph expansion               (mode: "project")
 *
 * 10 questions spanning 5 categories:
 *   temporal_resolution           — which decision is current when two contradict?
 *   conflict_surfacing            — does the system detect a reversal?
 *   implicit_contradiction        — reasons across two decisions in different sessions
 *   multi_citation_synthesis      — stitches facts across 3+ sessions
 *   simple_recall (baseline)      — single-session fact, should pass both conditions
 *   multi_decision_nuance         — two decisions that look like a conflict but aren't
 *   full_temporal_synthesis       — all 3 planted reversals in one answer
 *   provenance                    — who, when, and what triggered a decision
 *
 * Requires:
 *   ANTHROPIC_API_KEY or Ollama running
 *   BRAIN_API_KEY=dev-local (or your key)
 *   Corpus seeded: npm run seed:velox -w apps/api
 *
 * Run: npm run eval:velox-baseline -w apps/api
 *
 * Results saved to eval/velox-baseline-results.json
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

// ── Config ─────────────────────────────────────────────────────────────────────

const API_BASE   = process.env.API_BASE      ?? "http://localhost:3001";
const API_KEY    = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "dev-local";
const PROJECT_ID = process.env.PROJECT_ID    ?? "eval_velox_baseline";

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
const GT_PATH      = join(__dirname, "../../../../../eval/velox-ground-truth.json");
const RESULTS_PATH = join(__dirname, "../../../../../eval/velox-baseline-results.json");

// ── Types ──────────────────────────────────────────────────────────────────────

interface GroundTruthQuestion {
  id: string;
  query: string;
  tests: string;
  contra_id: string | null;
  correct_answer: string;
  required_facts: string[];
  incorrect_if: string;
  partial_if: string;
  scoring_notes: string;
}

interface GroundTruth {
  _meta: Record<string, unknown>;
  questions: GroundTruthQuestion[];
}

type Grade = "correct" | "partial" | "incorrect";

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
  tests: string;
  plain_rag: ConditionResult;
  full_brain: ConditionResult;
  winner: "full_brain" | "plain_rag" | "tie";
}

// ── LLM helper ────────────────────────────────────────────────────────────────

async function llmComplete(system: string, user: string, maxTokens = 600): Promise<string> {
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

// ── Brain query (both conditions) ─────────────────────────────────────────────

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
  if (!res.ok) {
    return { answer: `[HTTP ${res.status}]`, citations: 0, latency_ms };
  }
  const body = await res.json() as { answer?: string; citations?: unknown[]; latency_ms?: number };
  return {
    answer: body.answer ?? "",
    citations: (body.citations ?? []).length,
    latency_ms: body.latency_ms ?? latency_ms,
  };
}

// ── Judge ─────────────────────────────────────────────────────────────────────

const JUDGE_SYSTEM = `You are evaluating whether an answer about a software project correctly addresses a question, given externally-known ground truth.

Your job:
1. Check whether each required fact appears in the answer (explicitly or clearly implied).
2. Apply the "incorrect_if" test — if the answer matches the incorrect condition, grade it INCORRECT.
3. Apply the "partial_if" test — if the answer matches the partial condition but not the incorrect, grade it PARTIAL.
4. Otherwise grade CORRECT if all required facts are present, PARTIAL if some are missing.

Respond only in JSON.`;

interface JudgeResult {
  grade: Grade;
  facts_found: string[];
  facts_missing: string[];
  reasoning: string;
}

async function judge(q: GroundTruthQuestion, answer: string): Promise<JudgeResult> {
  const prompt = `Question: ${q.query}

Answer to evaluate:
${answer}

Correct answer (reference):
${q.correct_answer}

Required facts — check which appear in the answer:
${q.required_facts.map((f, i) => `  ${i + 1}. "${f}"`).join("\n")}

Grade INCORRECT if: ${q.incorrect_if}
Grade PARTIAL if: ${q.partial_if}

Return JSON:
{
  "grade": "correct" | "partial" | "incorrect",
  "facts_found": [...fact strings that appear in the answer...],
  "facts_missing": [...fact strings absent from the answer...],
  "reasoning": "one sentence explaining the grade"
}`;

  try {
    const text = await llmComplete(JUDGE_SYSTEM, prompt, 500);
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(clean) as JudgeResult;
  } catch {
    return {
      grade: "incorrect",
      facts_found: [],
      facts_missing: q.required_facts,
      reasoning: "judge parse error",
    };
  }
}

// ── Scoring helpers ────────────────────────────────────────────────────────────

const GRADE_SCORE: Record<Grade, number> = { correct: 2, partial: 1, incorrect: 0 };

function gradeLabel(g: Grade): string {
  return g === "correct" ? "✓ correct" : g === "partial" ? "~ partial" : "✗ incorrect";
}

function winner(pr: Grade, fb: Grade): "full_brain" | "plain_rag" | "tie" {
  const ps = GRADE_SCORE[pr];
  const fs = GRADE_SCORE[fb];
  if (fs > ps) return "full_brain";
  if (ps > fs) return "plain_rag";
  return "tie";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\neval-velox-baseline: plain-RAG vs full-brain (external ground truth)\n");
  console.log(`  project_id : ${PROJECT_ID}`);
  console.log(`  judge      : ${JUDGE_MODEL}`);
  console.log(`  provider   : ${USE_ANTHROPIC ? "Anthropic" : "Ollama"}\n`);

  // Load ground truth
  let gt: GroundTruth;
  try {
    gt = JSON.parse(readFileSync(GT_PATH, "utf-8")) as GroundTruth;
  } catch (e) {
    console.error(`Cannot read ground truth from ${GT_PATH}: ${e}`);
    process.exit(1);
  }

  // Preflight
  const health = await fetch(`${API_BASE}/health`).catch(() => null);
  if (!health?.ok) {
    console.error("  Brain API not reachable. Is docker compose up?");
    process.exit(1);
  }

  const chunkCount = await fetch("http://localhost:6333/collections/brain_chunks/points/count", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { must: [{ key: "project_id", match: { value: PROJECT_ID } }] } }),
  }).then(r => r.json())
    .then((r: { result?: { count: number } }) => r.result?.count ?? 0)
    .catch(() => 0);

  console.log(`  Qdrant corpus: ${chunkCount} chunks for ${PROJECT_ID}`);
  if (chunkCount === 0) {
    console.error("  No chunks found. Run: BRAIN_API_KEY=dev-local PROJECT_ID=eval_velox_baseline npm run seed:velox -w apps/api");
    console.error("  Then wait ~30s for the extractor pipeline.");
    process.exit(1);
  }
  console.log(`  Questions: ${gt.questions.length}\n`);

  // Run all questions
  const results: QuestionResult[] = [];
  let qNum = 0;

  for (const q of gt.questions) {
    qNum++;
    console.log(`── ${q.id} (${qNum}/${gt.questions.length}) — ${q.tests} ──`);
    console.log(`   "${q.query}"`);

    // Run both conditions
    process.stdout.write("   [B] plain-RAG ... ");
    const prRaw = await queryBrain(q.query, "plain-rag");
    process.stdout.write(`${prRaw.latency_ms}ms, ${prRaw.citations} citations\n`);

    process.stdout.write("   [C] full brain ... ");
    const fbRaw = await queryBrain(q.query, "project");
    process.stdout.write(`${fbRaw.latency_ms}ms, ${fbRaw.citations} citations\n`);

    // Judge both answers
    process.stdout.write("   [judge] scoring ...\n");
    const [prJudge, fbJudge] = await Promise.all([
      judge(q, prRaw.answer),
      judge(q, fbRaw.answer),
    ]);

    const w = winner(prJudge.grade, fbJudge.grade);

    console.log(`   plain-RAG : ${gradeLabel(prJudge.grade).padEnd(12)} — ${prJudge.reasoning}`);
    console.log(`   full brain: ${gradeLabel(fbJudge.grade).padEnd(12)} — ${fbJudge.reasoning}`);
    console.log(`   winner    : ${w === "full_brain" ? "FULL BRAIN ↑" : w === "plain_rag" ? "PLAIN RAG ↑" : "TIE"}\n`);

    results.push({
      id: q.id,
      query: q.query,
      tests: q.tests,
      plain_rag: {
        answer: prRaw.answer,
        citations: prRaw.citations,
        latency_ms: prRaw.latency_ms,
        grade: prJudge.grade,
        facts_found: prJudge.facts_found,
        facts_missing: prJudge.facts_missing,
        judge_reasoning: prJudge.reasoning,
      },
      full_brain: {
        answer: fbRaw.answer,
        citations: fbRaw.citations,
        latency_ms: fbRaw.latency_ms,
        grade: fbJudge.grade,
        facts_found: fbJudge.facts_found,
        facts_missing: fbJudge.facts_missing,
        judge_reasoning: fbJudge.reasoning,
      },
      winner: w,
    });
  }

  // ── Summary table ─────────────────────────────────────────────────────────────

  console.log("\n══════════════════════════════════════════════════════════════════");
  console.log("RESULTS SUMMARY");
  console.log("══════════════════════════════════════════════════════════════════\n");

  // By question type — aggregate score (correct=2, partial=1, incorrect=0)
  const byType: Record<string, { pr: number; fb: number; n: number }> = {};
  for (const r of results) {
    const t = r.tests;
    if (!byType[t]) byType[t] = { pr: 0, fb: 0, n: 0 };
    byType[t].pr += GRADE_SCORE[r.plain_rag.grade];
    byType[t].fb += GRADE_SCORE[r.full_brain.grade];
    byType[t].n++;
  }

  console.log("  Question category              | plain-RAG | full brain | winner");
  console.log("  -------------------------------|-----------|------------|-------");
  for (const [type, s] of Object.entries(byType)) {
    const max  = s.n * 2;
    const prPct = `${s.pr}/${max}`;
    const fbPct = `${s.fb}/${max}`;
    const w = s.fb > s.pr ? "FULL BRAIN" : s.pr > s.fb ? "PLAIN RAG" : "TIE";
    console.log(`  ${type.padEnd(31)}| ${prPct.padEnd(9)} | ${fbPct.padEnd(10)} | ${w}`);
  }

  // Per-question grid
  console.log("\n  ID    | tests                       | plain-RAG    | full brain   | winner");
  console.log("  ------|-----------------------------|--------------|--------------|-----------");
  for (const r of results) {
    const pr = gradeLabel(r.plain_rag.grade).padEnd(14);
    const fb = gradeLabel(r.full_brain.grade).padEnd(14);
    const w  = r.winner === "full_brain" ? "FULL BRAIN ↑" : r.winner === "plain_rag" ? "PLAIN RAG ↑" : "TIE";
    console.log(`  ${r.id.padEnd(6)}| ${r.tests.padEnd(27)} | ${pr}| ${fb}| ${w}`);
  }

  // Totals
  const totalPR  = results.reduce((n, r) => n + GRADE_SCORE[r.plain_rag.grade], 0);
  const totalFB  = results.reduce((n, r) => n + GRADE_SCORE[r.full_brain.grade], 0);
  const maxScore = results.length * 2;

  const fbWins  = results.filter(r => r.winner === "full_brain").length;
  const prWins  = results.filter(r => r.winner === "plain_rag").length;
  const ties    = results.filter(r => r.winner === "tie").length;

  const avgLatPR = Math.round(results.reduce((n, r) => n + r.plain_rag.latency_ms, 0) / results.length);
  const avgLatFB = Math.round(results.reduce((n, r) => n + r.full_brain.latency_ms, 0) / results.length);
  const avgCitPR = (results.reduce((n, r) => n + r.plain_rag.citations, 0) / results.length).toFixed(1);
  const avgCitFB = (results.reduce((n, r) => n + r.full_brain.citations, 0) / results.length).toFixed(1);

  const correctPR  = results.filter(r => r.plain_rag.grade  === "correct").length;
  const correctFB  = results.filter(r => r.full_brain.grade === "correct").length;
  const partialPR  = results.filter(r => r.plain_rag.grade  === "partial").length;
  const partialFB  = results.filter(r => r.full_brain.grade === "partial").length;
  const incorrectPR = results.filter(r => r.plain_rag.grade  === "incorrect").length;
  const incorrectFB = results.filter(r => r.full_brain.grade === "incorrect").length;

  console.log("\n  ── Totals ───────────────────────────────────────────────────────");
  console.log(`  Score               plain-RAG: ${totalPR}/${maxScore}   full brain: ${totalFB}/${maxScore}`);
  console.log(`  Correct             plain-RAG: ${correctPR}    full brain: ${correctFB}`);
  console.log(`  Partial             plain-RAG: ${partialPR}    full brain: ${partialFB}`);
  console.log(`  Incorrect           plain-RAG: ${incorrectPR}    full brain: ${incorrectFB}`);
  console.log(`  Question wins       plain-RAG: ${prWins}    full brain: ${fbWins}    ties: ${ties}`);
  console.log(`  Avg latency (ms)    plain-RAG: ${avgLatPR}   full brain: ${avgLatFB}`);
  console.log(`  Avg citations       plain-RAG: ${avgCitPR}   full brain: ${avgCitFB}`);

  // Verdict
  console.log("\n  ── Verdict ──────────────────────────────────────────────────────");
  if (totalFB > totalPR) {
    const gap = totalFB - totalPR;
    console.log(`  FULL BRAIN WINS  (+${gap} pts, ${fbWins} question wins vs ${prWins})`);
    console.log(`  Graph traversal adds measurable value over plain-RAG on this corpus.`);
  } else if (totalPR > totalFB) {
    const gap = totalPR - totalFB;
    console.log(`  PLAIN RAG WINS  (+${gap} pts, ${prWins} question wins vs ${fbWins})`);
    console.log(`  ⚠ Graph traversal does not add value on this corpus. Architectural review warranted.`);
  } else {
    console.log(`  TIE  (${totalPR}/${maxScore} each, ${ties} ties, ${fbWins} FB wins, ${prWins} PR wins)`);
    console.log(`  Graph traversal matches but does not beat plain-RAG. Review per-category breakdown.`);
  }

  // Flag the differentiating categories specifically
  const differentiators = ["temporal_resolution", "conflict_surfacing", "implicit_contradiction_reasoning", "full_temporal_synthesis"];
  const diffResults = results.filter(r => differentiators.includes(r.tests));
  if (diffResults.length > 0) {
    const diffFBScore = diffResults.reduce((n, r) => n + GRADE_SCORE[r.full_brain.grade], 0);
    const diffPRScore = diffResults.reduce((n, r) => n + GRADE_SCORE[r.plain_rag.grade], 0);
    const diffMax = diffResults.length * 2;
    console.log(`\n  On differentiating categories (temporal + conflict + synthesis):`);
    console.log(`    plain-RAG: ${diffPRScore}/${diffMax}   full brain: ${diffFBScore}/${diffMax}`);
    if (diffFBScore <= diffPRScore) {
      console.log(`    ⚠ Full brain does NOT outperform plain-RAG on its claimed differentiators.`);
    } else {
      console.log(`    ✓ Full brain outperforms plain-RAG on its claimed differentiators.`);
    }
  }

  // Save results
  const output = {
    run_at: new Date().toISOString(),
    project_id: PROJECT_ID,
    judge_model: JUDGE_MODEL,
    provider: USE_ANTHROPIC ? "anthropic" : "ollama",
    qdrant_chunks: chunkCount,
    totals: {
      plain_rag:  { score: totalPR, correct: correctPR, partial: partialPR, incorrect: incorrectPR, avg_latency_ms: avgLatPR, avg_citations: parseFloat(avgCitPR) },
      full_brain: { score: totalFB, correct: correctFB, partial: partialFB, incorrect: incorrectFB, avg_latency_ms: avgLatFB, avg_citations: parseFloat(avgCitFB) },
      max_score: maxScore,
      question_wins: { plain_rag: prWins, full_brain: fbWins, ties },
    },
    questions: results,
  };
  writeFileSync(RESULTS_PATH, JSON.stringify(output, null, 2));
  console.log(`\n  Results saved to eval/velox-baseline-results.json\n`);

  process.exit(totalFB >= totalPR ? 0 : 1);
}

main().catch(err => {
  console.error("eval-velox-baseline crashed:", err);
  process.exit(1);
});
