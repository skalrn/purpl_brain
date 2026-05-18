/**
 * M7 Extraction eval — computes precision and recall for the decision extractor
 * against the manually labeled scaffold in eval/label-scaffold.json.
 *
 * Evaluation is PR-scoped: a PR is predicted to have a decision if ANY event
 * related to that PR (body, reviews, comments) extracted at least one decision.
 * This matches how the brain is actually used — a returning developer queries
 * by PR, not by individual event.
 *
 * Also simulates proposed new markers against raw event content to show the
 * expected improvement after re-processing.
 *
 * Distinguishes two failure modes in FNs:
 *   - rule-based-miss: no related event had decision_candidate=true
 *   - llm-miss: at least one event was candidate=true but LLM found nothing
 *
 * Usage:
 *   tsx src/scripts/eval-extraction.ts
 */

import "dotenv/config";
import { Redis } from "ioredis";
import { readFileSync } from "fs";
import { resolve } from "path";
import type { ExtractionResult, CanonicalEvent } from "@purpl/types";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

// ── Types ──────────────────────────────────────────────────────────────────────

interface LabeledDecision { quoted_text: string; summary: string }
interface LabeledPR {
  pr_number: string;
  url: string;
  event_id: string;
  has_decision: boolean | null;
  decisions: LabeledDecision[];
  context: Array<{ event_id: string }>;
}

interface PRResult {
  pr_number: string;
  decisions_found: number;    // across all related events
  any_candidate: boolean;     // any related event had candidate=true
  all_candidate_ids: string[]; // event_ids that were candidates
  summaries: string[];
}

interface EvalRow {
  pr_number: string;
  url: string;
  labeled: boolean;
  predicted: boolean;
  any_candidate: boolean;
  outcome: "TP" | "FP" | "FN" | "TN";
  failure_mode: "rule-based-miss" | "llm-miss" | "llm-hallucination" | null;
  labeled_decisions: LabeledDecision[];
  extracted_summaries: string[];
  // Simulation
  new_markers_would_catch: boolean;
}

// ── New markers (mirrors normalizer.ts additions) ─────────────────────────────

const NEW_MARKERS = [
  /\bin favor of\b/i,
  /\bclosing in favor\b/i,
  /\bclose this for now\b/i,
  /\bpending (?:a )?(?:design )?decision\b/i,
  /\buntil we have\b/i,
  /\bno need to\b/i,
  /\bthere'?s no need\b/i,
  /\bI don'?t think (?:we|this|it)\b/i,
  /\bsensible (?:policy|default|approach|choice)\b/i,
  /\bwe'?ll go for\b/i,
  /\bthat'?s what we'?ll\b/i,
  /\bcorrect (?:default|behav[io]+r)\b/i,
  /\bwarn(?:ing)?\s+when\b/i,
  /\bexplicit(?:ly)?\s+warn\b/i,
  /\bavoid\s+silent\b/i,
  /\bno longer\s+support\b/i,
  /\bdrop(?:ped|ping)?\s+support\b/i,
  /\btest matrix\b/i,
  /\bI (?:would |strongly )?suggest\b/i,
  /\bwould suggest\b/i,
];

function newMarkersMatch(content: string): boolean {
  return NEW_MARKERS.some((r) => r.test(content));
}

// ── Read helpers ───────────────────────────────────────────────────────────────

async function readStream<T>(
  redis: Redis,
  stream: string,
  field: string,
  filter: (v: T) => boolean
): Promise<T[]> {
  const results: T[] = [];
  let lastId = "-";
  while (true) {
    const batch = await redis.xrange(stream, lastId === "-" ? "-" : lastId, "+", "COUNT", 200) as [string, string[]][];
    if (!batch || batch.length === 0) break;
    for (const [id, fields] of batch) {
      const idx = fields.indexOf(field);
      if (idx !== -1) {
        try {
          const v = JSON.parse(fields[idx + 1]) as T;
          if (filter(v)) results.push(v);
        } catch { /* skip */ }
      }
      lastId = id;
    }
    if (batch.length < 200) break;
    const [ts, seq] = lastId.split("-").map(Number);
    lastId = `${ts}-${seq + 1}`;
  }
  return results;
}

// ── Word overlap for TP quality check ─────────────────────────────────────────

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  let n = 0;
  for (const w of wordsA) if (wordsB.has(w)) n++;
  return wordsA.size === 0 ? 0 : n / wordsA.size;
}

function decisionsOverlap(labeled: LabeledDecision[], summaries: string[]): boolean {
  for (const l of labeled) {
    for (const s of summaries) {
      if (wordOverlap(l.summary, s) >= 0.25 || wordOverlap(l.quoted_text, s) >= 0.25) return true;
    }
  }
  return false;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  const scaffold: LabeledPR[] = JSON.parse(
    readFileSync(resolve(REPO_ROOT, "eval/label-scaffold.json"), "utf8")
  );
  const labeled = scaffold.filter((pr) => pr.has_decision !== null);
  console.log(`[eval] ${labeled.length} labeled PRs\n`);

  const redis = new Redis(REDIS_URL);

  // Collect all event_ids for each PR (PR body + all context events)
  const allEventIds = new Map<string, string>(); // event_id → pr_number
  for (const pr of labeled) {
    allEventIds.set(pr.event_id, pr.pr_number);
    for (const ctx of pr.context) allEventIds.set(ctx.event_id, pr.pr_number);
  }

  // Read extracted results grouped by PR
  type ExtResult = ExtractionResult & { decision_candidate?: boolean };
  const allExtracted = await readStream<ExtResult>(
    redis, "events:extracted", "result",
    (r) => allEventIds.has(r.event_id)
  );

  // Read raw events for new-marker simulation
  type RawEvent = CanonicalEvent & { raw_content: string };
  const allRaw = await readStream<RawEvent>(
    redis, "events:raw", "event",
    (r) => allEventIds.has(r.event_id)
  );
  const rawByEventId = new Map(allRaw.map((r) => [r.event_id, r]));

  await redis.quit();

  // Group extracted results by PR number
  const prResults = new Map<string, PRResult>();
  for (const pr of labeled) {
    prResults.set(pr.pr_number, {
      pr_number: pr.pr_number,
      decisions_found: 0,
      any_candidate: false,
      all_candidate_ids: [],
      summaries: [],
    });
  }

  for (const r of allExtracted) {
    const prNum = allEventIds.get(r.event_id);
    if (!prNum) continue;
    const pr = prResults.get(prNum)!;
    pr.decisions_found += r.decisions.length;
    if (r.decision_candidate) {
      pr.any_candidate = true;
      pr.all_candidate_ids.push(r.event_id);
    }
    pr.summaries.push(...r.decisions.map((d) => `${d.summary} ${d.quoted_text}`));
  }

  // Simulate new markers: would any related raw event trigger them?
  const newMarkerWouldHelp = new Map<string, boolean>();
  for (const pr of labeled) {
    const ids = [pr.event_id, ...pr.context.map((c) => c.event_id)];
    const wouldCatch = ids.some((id) => {
      const raw = rawByEventId.get(id);
      return raw ? newMarkersMatch(raw.raw_content) : false;
    });
    newMarkerWouldHelp.set(pr.pr_number, wouldCatch);
  }

  // ── Build eval rows ──────────────────────────────────────────────────────────

  const rows: EvalRow[] = [];
  for (const pr of labeled) {
    const result = prResults.get(pr.pr_number)!;
    const labeledHas = pr.has_decision as boolean;
    const predictedHas = result.decisions_found > 0;
    const anyCandidate = result.any_candidate;

    let outcome: EvalRow["outcome"];
    let failure_mode: EvalRow["failure_mode"] = null;

    if (labeledHas && predictedHas)        { outcome = "TP"; }
    else if (!labeledHas && predictedHas)  { outcome = "FP"; failure_mode = "llm-hallucination"; }
    else if (labeledHas && !predictedHas)  { outcome = "FN"; failure_mode = anyCandidate ? "llm-miss" : "rule-based-miss"; }
    else                                   { outcome = "TN"; }

    rows.push({
      pr_number: pr.pr_number,
      url: pr.url,
      labeled: labeledHas,
      predicted: predictedHas,
      any_candidate: anyCandidate,
      outcome,
      failure_mode,
      labeled_decisions: pr.decisions,
      extracted_summaries: result.summaries,
      new_markers_would_catch: newMarkerWouldHelp.get(pr.pr_number) ?? false,
    });
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────

  const TP = rows.filter((r) => r.outcome === "TP").length;
  const FP = rows.filter((r) => r.outcome === "FP").length;
  const FN = rows.filter((r) => r.outcome === "FN").length;
  const TN = rows.filter((r) => r.outcome === "TN").length;

  const precision = TP + FP === 0 ? 0 : TP / (TP + FP);
  const recall    = TP + FN === 0 ? 0 : TP / (TP + FN);
  const f1        = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);

  const ruleMisses      = rows.filter((r) => r.failure_mode === "rule-based-miss").length;
  const llmMisses       = rows.filter((r) => r.failure_mode === "llm-miss").length;
  const hallucinations  = rows.filter((r) => r.failure_mode === "llm-hallucination").length;

  // Simulated: FNs where new markers would have promoted a related event to candidate
  const newMarkerRecoverable = rows.filter(
    (r) => r.outcome === "FN" && r.failure_mode === "rule-based-miss" && r.new_markers_would_catch
  ).length;
  const projectedTP = TP + newMarkerRecoverable;
  const projectedRecall = projectedTP / (projectedTP + (FN - newMarkerRecoverable));

  // ── Scorecard ─────────────────────────────────────────────────────────────────

  console.log("═══════════════════════════════════════════════════════");
  console.log("  M7 EXTRACTION EVAL — SCORECARD  (PR-scoped)");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  PRs evaluated : ${labeled.length}`);
  console.log(`  TP            : ${TP}  (found at least one decision)`);
  console.log(`  FP            : ${FP}  (hallucinated a decision)`);
  console.log(`  FN            : ${FN}  (missed a real decision)`);
  console.log(`  TN            : ${TN}  (correctly found none)`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Precision     : ${(precision * 100).toFixed(1)}%  (target: >90%)`);
  console.log(`  Recall        : ${(recall * 100).toFixed(1)}%  (target: >65%)`);
  console.log(`  F1            : ${(f1 * 100).toFixed(1)}%`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  FN breakdown:`);
  console.log(`    Rule-based misses (no candidate in any event) : ${ruleMisses}`);
  console.log(`      → new markers would recover                 : ${newMarkerRecoverable}`);
  console.log(`    LLM misses  (candidate=true but no decision)  : ${llmMisses}`);
  console.log(`  FP breakdown:`);
  console.log(`    LLM hallucinations                            : ${hallucinations}`);
  console.log("───────────────────────────────────────────────────────");
  console.log(`  Projected recall after re-processing            : ${(projectedRecall * 100).toFixed(1)}%`);
  console.log("═══════════════════════════════════════════════════════\n");

  const precisionPass = precision >= 0.90;
  const recallPass    = recall >= 0.65;
  console.log(`  Precision ${precisionPass ? "✓ PASS" : "✗ FAIL"}`);
  console.log(`  Recall    ${recallPass    ? "✓ PASS" : "✗ FAIL"}`);
  console.log("");

  // ── Per-PR breakdown ──────────────────────────────────────────────────────────

  console.log("PER-PR BREAKDOWN:");
  console.log("──────────────────────────────────────────────────────────────────────");
  const sorted = [...rows].sort((a, b) => ({ FP:0, FN:1, TP:2, TN:3 }[a.outcome] - { FP:0, FN:1, TP:2, TN:3 }[b.outcome]));

  for (const row of sorted) {
    const flag = row.outcome === "TP" ? "✓" : row.outcome === "TN" ? "·" : "✗";
    const sim  = row.outcome === "FN" && row.new_markers_would_catch ? " [new markers →TP]" : "";
    console.log(`${flag} #${row.pr_number.padEnd(6)} ${row.outcome}  candidate=${String(row.any_candidate).padEnd(5)}  ${row.failure_mode ?? ""}${sim}`);

    if (row.outcome === "FN") {
      console.log(`         labeled:   ${row.labeled_decisions[0]?.summary ?? "(none)"}`);
    }
    if (row.outcome === "FP") {
      console.log(`         extracted: ${row.extracted_summaries[0]?.slice(0, 100) ?? "(none)"}`);
    }
    if (row.outcome === "TP" && !decisionsOverlap(row.labeled_decisions, row.extracted_summaries)) {
      console.log(`         ⚠ low text overlap — verify manually`);
      console.log(`         labeled:   ${row.labeled_decisions[0]?.summary}`);
      console.log(`         extracted: ${row.extracted_summaries[0]?.slice(0, 100) ?? "(none)"}`);
    }
  }
  console.log("");

  if (!precisionPass || !recallPass) {
    console.log("TUNING GUIDANCE:");
    if (ruleMisses > 0) console.log(`  → add new markers to normalizer.ts (${newMarkerRecoverable} recoverable)`);
    if (llmMisses > 0)  console.log(`  → tighten extractor prompt: add examples of deferred/rejected decisions`);
    if (hallucinations > 0) console.log(`  → reinforce "never fabricate" in extractor prompt`);
    console.log(`  → re-seed to re-process events with updated markers`);
  } else {
    console.log("Both targets met — extraction quality sufficient for Phase 1.");
  }

  process.exit(precisionPass && recallPass ? 0 : 1);
}

run().catch((e) => { console.error("[eval] fatal:", e); process.exit(1); });
