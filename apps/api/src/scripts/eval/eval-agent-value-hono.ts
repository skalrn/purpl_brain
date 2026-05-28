/**
 * eval-agent-value-hono.ts — Corpus-driven A/B eval against the honojs/hono corpus
 *
 * Unlike eval-agent-value.ts (controlled scenario with hand-crafted seed data),
 * this eval uses the real honojs/hono corpus ingested from GitHub PRs and issues.
 *
 * Key design principle (EVAL-4 fix):
 *   Ground truth signals are derived from what brain_query ACTUALLY returns for each
 *   task, not from external knowledge of the project. This tests whether brain context
 *   injection causes the agent to align with the brain's own signals — not whether the
 *   brain has captured the "right" decisions about Hono.
 *
 * Flow per task:
 *   1. Run brain_query(task) → get brain context
 *   2. If brain returns no context, skip task (brain has no signal here)
 *   3. LLM extracts 2-3 specific claims from the brain context → ground truth signals
 *   4. Run cold agent on task (no context)
 *   5. Run brain-assisted agent on task (context injected)
 *   6. Judge: does brain agent align with the signals extracted from brain context?
 *      Cold agent should align less, having never seen the brain context.
 *
 * This cleanly separates two concerns:
 *   - Extraction coverage (did the brain capture the right decisions?) — tested elsewhere
 *   - Injection quality (does injected context change agent behaviour?) — what this tests
 *
 * Requires:
 *   ANTHROPIC_API_KEY — OR Ollama running (auto-detected via LLM_PROVIDER)
 *   BRAIN_API_KEY / DEV_API_KEY
 *   Corpus: run `npm run seed:hono -w apps/api` first
 *
 * Run: npm run eval:agent-value-hono -w apps/api
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE   = process.env.API_BASE ?? "http://localhost:3001";
const API_KEY    = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "";
const PROJECT_ID = "honojs_hono";

const _apiKey    = process.env.ANTHROPIC_API_KEY ?? "";
const _validKey  = _apiKey.startsWith("sk-ant-api") && _apiKey.length > 30;
const USE_ANTHROPIC = process.env.LLM_PROVIDER === "anthropic" || (!process.env.LLM_PROVIDER && _validKey);
const OLLAMA_BASE   = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const AGENT_MODEL   = USE_ANTHROPIC ? "claude-haiku-4-5-20251001" : (process.env.OLLAMA_SMART_MODEL ?? "llama3.1:8b");
const JUDGE_MODEL   = USE_ANTHROPIC ? "claude-haiku-4-5-20251001" : (process.env.OLLAMA_FAST_MODEL  ?? "qwen2.5:7b");

const anthropic = USE_ANTHROPIC ? new Anthropic({ apiKey: _apiKey }) : null;
const ollama    = !USE_ANTHROPIC ? new OpenAI({ baseURL: OLLAMA_BASE, apiKey: "ollama" }) : null;

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`    PASS  ${name}`); passed++; }
  else           { console.error(`    FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); failed++; }
}

function phase(n: number, label: string) { console.log(`\n── Phase ${n}: ${label} ──`); }

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

async function llmComplete(model: string, system: string, user: string, maxTokens: number): Promise<string> {
  if (anthropic) {
    const res = await anthropic.messages.create({
      model, max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as unknown as Anthropic.Messages.TextBlockParam[],
      messages: [{ role: "user", content: user }],
    });
    return res.content.find(b => b.type === "text")?.text ?? "";
  }
  const res = await ollama!.chat.completions.create({
    model, max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return res.choices[0]?.message?.content ?? "";
}

// ── Real-world tasks ──────────────────────────────────────────────────────────
//
// Tasks are drawn from real Hono contributor scenarios. Ground truth signals are
// NOT pre-specified here — they are derived at runtime from what brain_query
// actually returns for each task (see extractSignals below).
// Tasks where the brain returns no context are skipped automatically.

const TASKS = [
  {
    label: "T1 — New middleware conventions",
    description:
      "I want to contribute a new middleware to Hono. What conventions, patterns, " +
      "and design constraints should I follow? Specifically: how should the middleware " +
      "be structured, what should its TypeScript signature look like, and what are the " +
      "common reasons past middleware PRs were revised or rejected?",
  },
  {
    label: "T2 — URI decoding in router",
    description:
      "I'm seeing inconsistent behaviour with URI-encoded characters in Hono routes. " +
      "For example, a route matching `/users/:id` doesn't behave the same way for " +
      "`/users/foo%20bar` vs `/users/foo bar`. What has been decided about URI decoding " +
      "in Hono's router, and what approach should I take when implementing a fix?",
  },
  {
    label: "T3 — Extending Context object",
    description:
      "I need to add custom properties to Hono's Context object to carry request-scoped " +
      "data across middleware (e.g., the authenticated user, a request ID, feature flags). " +
      "What is the recommended approach? What has been decided about extending Context, " +
      "and what patterns were considered but rejected?",
  },
  {
    label: "T4 — TypeScript type inference in validators",
    description:
      "I'm building a validator integration for Hono. How should TypeScript types flow " +
      "from the validator schema through to the route handler and the RPC client? " +
      "What decisions have been made about type inference and what were the tradeoffs?",
  },
];

// ── Brain query ───────────────────────────────────────────────────────────────

async function brainQuery(taskDescription: string): Promise<{ context: string; tokens: number; citations: number }> {
  const res = await fetch(`${API_BASE}/brain/query`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query: taskDescription, project_id: PROJECT_ID, mode: "project" }),
  });
  if (!res.ok) return { context: "", tokens: 0, citations: 0 };
  const body = await res.json() as { answer?: string; citations?: Array<{ quoted_text?: string; content?: string }> };
  const answer = body.answer ?? "";
  const citationText = (body.citations ?? []).map(c => c.quoted_text ?? c.content ?? "").join(" ");
  const context = answer + (citationText ? "\n\n" + citationText : "");
  return {
    context,
    tokens: Math.round(context.length / 4),
    citations: (body.citations ?? []).length,
  };
}

// ── Signal extraction from brain context ─────────────────────────────────────
//
// Derives 2-3 specific, testable claims from the brain's answer.
// These become the ground truth — what we expect a brain-assisted agent to align
// with, and what a cold agent should miss more often.

const EXTRACTOR_SYSTEM =
  "You extract specific, concrete claims from a knowledge base answer. " +
  "Each claim must be testable: an agent either agrees with it, ignores it, or contradicts it. " +
  "Respond only with a JSON array of strings.";

async function extractSignals(brainAnswer: string): Promise<string[]> {
  const prompt =
    `From this knowledge base answer, extract 2-3 specific, concrete claims that a software ` +
    `engineer giving advice should either agree with or contradict. Each claim should be ` +
    `a single clear statement (not a question). Prefer claims about specific technical ` +
    `decisions, patterns, or constraints — not generic observations.\n\n` +
    `Answer:\n${brainAnswer}\n\n` +
    `Respond with a JSON array only: ["claim 1", "claim 2", ...]`;

  try {
    const text = await llmComplete(JUDGE_MODEL, EXTRACTOR_SYSTEM, prompt, 300);
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(0, 3);
  } catch { /* fall through */ }
  return [];
}

// ── Agent ─────────────────────────────────────────────────────────────────────

const AGENT_SYSTEM =
  "You are a senior software engineer advising a contributor to the Hono web framework. " +
  "Give concrete, specific guidance. Focus on what has actually been decided or established " +
  "in the project, not generic best practices. Be honest if you are uncertain.";

async function runAgent(task: string, brainContext: string): Promise<string> {
  const user = brainContext
    ? `Context from the Hono project brain (prior decisions, discussions, and maintainer guidance):\n\n${brainContext}\n\n---\n\nContributor question: ${task}`
    : `Contributor question: ${task}`;
  return llmComplete(AGENT_MODEL, AGENT_SYSTEM, user, 700);
}

// ── Judge ─────────────────────────────────────────────────────────────────────

interface Judgement {
  consistent: boolean;
  cited: boolean;
  contradicted: boolean;
  reasoning: string;
}

const JUDGE_SYSTEM =
  "You are evaluating whether an agent's response to a contributor question aligns with " +
  "a known ground-truth signal about how the Hono project works. Respond only in JSON.";

async function judge(signal: string, agentOutput: string): Promise<Judgement> {
  const prompt =
    `Ground-truth signal about this project:\n"${signal}"\n\n` +
    `Agent response:\n${agentOutput}\n\n` +
    `Score:\n` +
    `1. consistent: Is the agent response compatible with or aligned to the ground-truth signal? (true/false)\n` +
    `2. cited: Does the agent explicitly mention the specific approach or decision in the signal? (true/false)\n` +
    `3. contradicted: Does the agent recommend something that conflicts with the signal? (true/false)\n` +
    `JSON only: {"consistent": bool, "cited": bool, "contradicted": bool, "reasoning": "one sentence"}`;

  try {
    const text = await llmComplete(JUDGE_MODEL, JUDGE_SYSTEM, prompt, 200);
    const clean = text.replace(/```json\n?|\n?```/g, "").trim();
    return JSON.parse(clean) as Judgement;
  } catch {
    return { consistent: false, cited: false, contradicted: false, reasoning: "parse error" };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface TaskMetrics {
  label: string;
  cold:  { alignment: number; citations: number; contradictions: number; total: number };
  brain: { alignment: number; citations: number; contradictions: number; total: number; context_tokens: number; brain_citations: number };
}

async function main() {
  console.log("eval-agent-value-hono: corpus-driven A/B (signals derived from brain context)\n");
  console.log(`Project:   ${PROJECT_ID}`);
  console.log(`Agent:     ${AGENT_MODEL}   Judge: ${JUDGE_MODEL}`);
  console.log(`Tasks:     ${TASKS.length}`);
  console.log(`Provider:  ${USE_ANTHROPIC ? "Anthropic" : "Ollama"}`);

  // Phase 0: preflight
  phase(0, "Preflight");
  const health = await fetch(`${API_BASE}/health`).catch(() => null);
  check("Brain API reachable", health?.ok === true);

  const count = await fetch(`http://localhost:6333/collections/brain_chunks/points/count`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { must: [{ key: "project_id", match: { value: PROJECT_ID } }] } }),
  }).then(r => r.json()).then((r: { result?: { count: number } }) => r.result?.count ?? 0).catch(() => 0);

  console.log(`    Corpus: ${count} chunks in Qdrant for ${PROJECT_ID}`);
  check("Corpus has content (run seed:hono first)", count > 0, `Found ${count} chunks`);
  if (count === 0) {
    console.error("\n    Run: npm run seed:hono -w apps/api\n    Then wait ~60min for Ollama pipeline to process.");
    process.exit(1);
  }
  if (count < 20) {
    console.warn(`    WARNING: only ${count} chunks — pipeline may still be processing. Results may be incomplete.`);
  }

  // Phase 1: Discover signals from brain, then run A/B tasks
  phase(1, "Signal discovery + A/B task runs");
  const results: TaskMetrics[] = [];
  let skipped = 0;

  for (const task of TASKS) {
    console.log(`\n  ${task.label}`);

    // Step 1: query brain to get context and derive ground truth signals
    console.log("    [brain] discovering signals...");
    const { context: brainContext, tokens: ctxTokens, citations: brainCitations } = await brainQuery(task.description);
    const hasCtx = brainContext.trim().length > 100;

    if (!hasCtx) {
      console.log(`    SKIP  brain returned no context for this task — cannot derive signals`);
      skipped++;
      continue;
    }
    console.log(`    [brain] context: ~${ctxTokens} tokens, ${brainCitations} citations`);

    // Step 2: extract specific testable claims from brain context
    // These become the ground truth — derived from what the brain actually knows
    const signals = await extractSignals(brainContext);
    if (signals.length === 0) {
      console.log(`    SKIP  could not extract testable signals from brain context`);
      skipped++;
      continue;
    }
    console.log(`    [signals] derived ${signals.length} ground truth signals from brain context:`);
    signals.forEach((s, i) => console.log(`      ${i + 1}. ${s.slice(0, 80)}${s.length > 80 ? "…" : ""}`));

    // Step 3: run cold agent (no context) and brain-assisted agent
    console.log("    [A] cold start...");
    const coldOutput = await runAgent(task.description, "");
    console.log("    [B] brain-assisted...");
    const brainOutput = await runAgent(task.description, brainContext);

    // Step 4: judge both outputs against the brain-derived signals
    const cold  = { alignment: 0, citations: 0, contradictions: 0, total: signals.length };
    const brain = { alignment: 0, citations: 0, contradictions: 0, total: signals.length, context_tokens: ctxTokens, brain_citations: brainCitations };

    for (const signal of signals) {
      const coldJ  = await judge(signal, coldOutput);
      const brainJ = await judge(signal, brainOutput);

      if (coldJ.consistent)   cold.alignment++;
      if (coldJ.cited)        cold.citations++;
      if (coldJ.contradicted) cold.contradictions++;

      if (brainJ.consistent)   brain.alignment++;
      if (brainJ.cited)        brain.citations++;
      if (brainJ.contradicted) brain.contradictions++;

      const sig = signal.length > 70 ? signal.slice(0, 70) + "…" : signal;
      console.log(`\n    Signal: "${sig}"`);
      console.log(`      Cold  consistent:${coldJ.consistent}  cited:${coldJ.cited}  contradicted:${coldJ.contradicted}`);
      console.log(`             ${coldJ.reasoning}`);
      console.log(`      Brain consistent:${brainJ.consistent}  cited:${brainJ.cited}  contradicted:${brainJ.contradicted}`);
      console.log(`             ${brainJ.reasoning}`);
    }

    results.push({ label: task.label, cold, brain });
  }

  if (skipped > 0) {
    console.log(`\n  ${skipped} task(s) skipped — brain had no context for those queries.`);
  }
  if (results.length === 0) {
    console.error("\n  No tasks produced results. Brain may have too little signal on this corpus.");
    console.error("  Check corpus quality: GET /brain/corpus-stats?project_id=" + PROJECT_ID);
    process.exit(1);
  }

  // Phase 2: Summary
  phase(2, "Results summary");

  const totals = {
    cold:  { alignment: 0, citations: 0, contradictions: 0, total: 0 },
    brain: { alignment: 0, citations: 0, contradictions: 0, total: 0, ctx_tokens: 0 },
  };

  console.log("\n  Task                               | Metric           | Cold | Brain | Delta");
  console.log("  -----------------------------------|------------------|------|-------|------");

  for (const r of results) {
    totals.cold.alignment      += r.cold.alignment;
    totals.cold.citations      += r.cold.citations;
    totals.cold.contradictions += r.cold.contradictions;
    totals.cold.total          += r.cold.total;
    totals.brain.alignment     += r.brain.alignment;
    totals.brain.citations     += r.brain.citations;
    totals.brain.contradictions += r.brain.contradictions;
    totals.brain.total         += r.brain.total;
    totals.brain.ctx_tokens    += r.brain.context_tokens;

    for (const [name, c, b] of [
      ["alignment",     r.cold.alignment,     r.brain.alignment],
      ["citations",     r.cold.citations,     r.brain.citations],
      ["contradictions",r.cold.contradictions,r.brain.contradictions],
    ] as [string, number, number][]) {
      const delta = b - c;
      console.log(`  ${r.label.padEnd(35)}| ${name.padEnd(16)} | ${String(c).padEnd(4)} | ${String(b).padEnd(5)} | ${delta > 0 ? "+" : ""}${delta}`);
    }
    console.log(`  ${" ".repeat(35)}| ctx_tokens       |  n/a | ${String(r.brain.context_tokens).padEnd(5)} | (${r.brain.brain_citations} brain citations)`);
  }

  const ct = totals.cold.total;
  const bt = totals.brain.total;
  const brainAlignRate = bt > 0 ? totals.brain.alignment / bt : 0;
  const coldAlignRate  = ct > 0 ? totals.cold.alignment  / ct : 0;

  console.log("\n  ── Overall ──────────────────────────────────────────────────────────");
  console.log(`  Alignment rate      cold: ${pct(totals.cold.alignment, ct).padEnd(6)} brain: ${pct(totals.brain.alignment, bt).padEnd(6)} delta: ${totals.brain.alignment - totals.cold.alignment > 0 ? "+" : ""}${totals.brain.alignment - totals.cold.alignment}`);
  console.log(`  Citation rate       cold: ${pct(totals.cold.citations, ct).padEnd(6)} brain: ${pct(totals.brain.citations, bt).padEnd(6)} delta: ${totals.brain.citations - totals.cold.citations > 0 ? "+" : ""}${totals.brain.citations - totals.cold.citations}`);
  console.log(`  Contradiction rate  cold: ${pct(totals.cold.contradictions, ct).padEnd(6)} brain: ${pct(totals.brain.contradictions, bt).padEnd(6)} delta: ${totals.brain.contradictions - totals.cold.contradictions}`);
  console.log(`  Avg context tokens  brain: ~${Math.round(totals.brain.ctx_tokens / results.length)} per task`);
  console.log(`  Tasks with results: ${results.length}/${TASKS.length} (${skipped} skipped — no brain context)`);

  // Assertions — signals are corpus-derived so alignment expectations are higher than
  // the previous version (the brain agent has literally seen the signal source)
  check("Brain alignment rate ≥ 50%", brainAlignRate >= 0.50, `Got ${pct(totals.brain.alignment, bt)}`);
  check("Brain alignment rate > cold rate", brainAlignRate > coldAlignRate,
    `Brain: ${pct(totals.brain.alignment, bt)}, Cold: ${pct(totals.cold.alignment, ct)}`);
  check("Brain contradiction rate ≤ cold rate",
    totals.brain.contradictions <= totals.cold.contradictions,
    `Brain: ${totals.brain.contradictions}, Cold: ${totals.cold.contradictions}`);
  check("At least 1 task produced results", results.length >= 1,
    `All ${TASKS.length} tasks were skipped — corpus may be too thin`);

  console.log(`\n── Result: ${passed} passed, ${failed} failed ──`);

  // Context quality note
  const avgCtx = results.length > 0 ? Math.round(totals.brain.ctx_tokens / results.length) : 0;
  if (avgCtx > 2000) {
    console.log(`\n  NOTE: average context is ~${avgCtx} tokens — brain may be returning too much noise.`);
    console.log(`  Consider raising QUERY_MIN_SCORE or lowering QUERY_TOP_K in .env.`);
  }
  if (skipped > 0) {
    console.log(`\n  ${skipped} task(s) had no brain context — corpus signal is thin for those queries.`);
    console.log(`  Corpus quality: curl -s "http://localhost:3001/brain/corpus-stats?project_id=${PROJECT_ID}" -H "X-API-Key: <key>"`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("eval-agent-value-hono crashed:", err);
  process.exit(1);
});
