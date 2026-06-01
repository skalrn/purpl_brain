/**
 * eval-comparison.ts — Document mode vs Brain mode agent context comparison
 *
 * Answers the question: what does an agent actually gain by using Purpl Brain
 * instead of reading the repo's committed documentation?
 *
 * Subject: honojs/hono (seeded into the brain via seed:hono)
 *
 * Methodology:
 *
 *   DOCUMENT MODE — simulate an agent that reads committed docs at session
 *   start: fetches README.md, CONTRIBUTING.md, MIGRATION.md from the GitHub
 *   API, builds a single context blob, then calls Haiku with that context +
 *   each test question. Tracks `usage.input_tokens` from the API response.
 *
 *   BRAIN MODE — the agent calls POST /brain/query with each question.
 *   The brain does hybrid retrieval (Qdrant + Neo4j), synthesises an answer,
 *   and returns it with citations. Measures citation corpus size (the context
 *   the brain fed into the LLM) as the comparable token signal.
 *
 * Metrics per question:
 *   - doc_input_tokens:   tokens the LLM had to process in doc mode
 *   - brain_ctx_tokens:   estimated tokens retrieved by brain (citation text)
 *   - doc_answered:       whether the doc-mode answer was substantive
 *   - brain_answered:     whether the brain answer was substantive
 *   - brain_only:         whether only brain could meaningfully answer
 *
 * Usage:
 *   npm run eval:comparison -w apps/api
 *
 * Env:
 *   ANTHROPIC_API_KEY  — required for doc-mode LLM calls
 *   BRAIN_API_KEY / DEV_API_KEY  — for brain REST calls
 *   API_BASE           — defaults to http://localhost:3741
 *   GITHUB_TOKEN       — optional; avoids GitHub rate limits when fetching docs
 *   HONO_PROJECT_ID    — defaults to honojs_hono
 */
import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE     = process.env.API_BASE ?? "http://localhost:3741";
const API_KEY      = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const PROJECT_ID   = process.env.HONO_PROJECT_ID ?? "honojs_hono";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Use Haiku for doc-mode calls — this eval itself should be cheap.
const HAIKU = "claude-haiku-4-5-20251001";

// ── Types ─────────────────────────────────────────────────────────────────────

interface QuestionResult {
  question: string;
  category: "both_can_answer" | "brain_only" | "neither";
  doc_input_tokens: number;
  doc_answer_chars: number;
  doc_substantive: boolean;
  brain_ctx_tokens: number;
  brain_answer_chars: number;
  brain_substantive: boolean;
  brain_citations: number;
  token_savings: number;          // doc_input_tokens - brain_ctx_tokens
  token_reduction_pct: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Rough token estimate: 1 token ≈ 4 chars (English prose)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Non-substantive answer: short, hedged, or admits no knowledge
function isSubstantive(answer: string): boolean {
  if (!answer || answer.length < 80) return false;
  const lower = answer.toLowerCase();
  const hedges = [
    "i don't have",
    "i do not have",
    "no information",
    "not found",
    "cannot find",
    "i'm unable",
    "i am unable",
    "no context",
    "not available",
    "i cannot answer",
    "i don't know",
  ];
  return !hedges.some((h) => lower.includes(h));
}

// ── GitHub doc fetcher ────────────────────────────────────────────────────────

async function fetchGitHubFile(
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "purpl-brain-eval",
  };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  try {
    const res = await fetch(url, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return await res.text();
  } catch {
    return null;
  }
}

async function fetchHonoDocs(): Promise<{
  content: string;
  files: string[];
  totalChars: number;
}> {
  const paths = [
    "README.md",
    "docs/CONTRIBUTING.md",
    "docs/MIGRATION.md",
  ];

  const files: string[] = [];
  const parts: string[] = [];

  for (const p of paths) {
    const text = await fetchGitHubFile("honojs", "hono", p);
    if (text) {
      files.push(p);
      parts.push(`\n\n## ${p}\n\n${text}`);
    }
  }

  const content = parts.join("\n");
  return { content, files, totalChars: content.length };
}

// ── Brain query ───────────────────────────────────────────────────────────────

interface BrainCitation {
  chunk_id?: string;
  source?: string;
  source_url?: string;
  quoted_text?: string;
  // Legacy field names — kept for forward compat
  content?: string;
  snippet?: string;
  text?: string;
}

interface BrainResponse {
  answer?: string;
  citations?: BrainCitation[];
}

async function brainQuery(question: string): Promise<{
  answer: string;
  citations: BrainCitation[];
  ctxTokens: number;
}> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;

  const res = await fetch(`${API_BASE}/brain/query`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: question, project_id: PROJECT_ID }),
  });

  if (!res.ok) throw new Error(`Brain query failed: ${res.status}`);
  const body = (await res.json()) as BrainResponse;

  const answer = body.answer ?? "";
  const citations = body.citations ?? [];

  // Measure the citation corpus — this is what the brain retrieved and fed to
  // the LLM. It's the brain-mode equivalent of doc_input_tokens.
  const citationText = citations
    .map((c) => c.quoted_text ?? c.content ?? c.snippet ?? c.text ?? "")
    .join(" ");
  const ctxTokens = estimateTokens(citationText);

  return { answer, citations, ctxTokens };
}

// ── Doc-mode context size measurement ─────────────────────────────────────────
//
// In doc mode an agent pre-loads ALL committed docs at session start (or per
// question). We don't make a live LLM call here — we measure the token cost
// of loading the documents (which is what the LLM must process per question)
// and then use Haiku only if ANTHROPIC_API_KEY is a valid key, falling back to
// a content-based "can answer?" heuristic when the key is unavailable.

const DOC_SYSTEM = `You are a software engineering assistant. Answer the developer's question using ONLY the provided documentation. If the documentation does not contain enough information to answer, say exactly: "The documentation does not cover this." Do not speculate.`;

// Keyword heuristic — does the doc content plausibly contain an answer?
// Uses a scored approach: domain-specific terms get higher weight.
function docCanAnswerHeuristic(question: string, docContent: string): boolean {
  const lower = docContent.toLowerCase();
  const stopWords = new Set([
    "what", "which", "where", "when", "were", "have", "should", "would",
    "could", "their", "there", "about", "those", "these", "being", "some",
    "from", "with", "been", "does", "more",
  ]);
  const keywords = question.toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !stopWords.has(w));

  const matches = keywords.filter((kw) => lower.includes(kw));
  // At least 2 keyword matches, or 1 if the keyword is highly specific (>8 chars)
  const longMatches = matches.filter((w) => w.length > 8);
  return matches.length >= 2 || longMatches.length >= 1;
}

async function docQuery(
  question: string,
  docContent: string,
  docTokens: number,
): Promise<{ answer: string; inputTokens: number; outputTokens: number }> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";

  // If the API key looks valid (not a placeholder), make a real LLM call.
  if (apiKey.startsWith("sk-ant-api") && apiKey.length > 30) {
    try {
      const response = await anthropic.messages.create({
        model: HAIKU,
        max_tokens: 512,
        system: DOC_SYSTEM,
        messages: [
          {
            role: "user",
            content: `<documentation>\n${docContent}\n</documentation>\n\nQuestion: ${question}`,
          },
        ],
      });
      const answer = response.content.find((b) => b.type === "text")?.text ?? "";
      const usage = response.usage as { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number };
      const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0);
      return { answer, inputTokens, outputTokens: usage.output_tokens };
    } catch {
      // Fall through to heuristic
    }
  }

  // Fallback: use doc token size directly (the honest metric — the LLM would
  // need to process ALL these tokens to answer ANY question in doc mode).
  // Use content heuristic to estimate whether the docs contain the answer.
  const canAnswer = docCanAnswerHeuristic(question, docContent);
  // Keep answer > 80 chars so isSubstantive() doesn't reject it on length alone.
  const answer = canAnswer
    ? `[Heuristic: doc content contains relevant keywords — an LLM would likely answer this from the ${docTokens}-token document context loaded at session start.]`
    : `[Heuristic: doc content does not contain sufficient signal to answer this question. The ${docTokens}-token doc context was loaded but the information is absent.]`;
  return { answer, inputTokens: docTokens, outputTokens: 0 };
}

// ── Test questions ─────────────────────────────────────────────────────────────

// Divided into three categories:
//   A — Should be answerable by both modes (docs + brain both have the info)
//   B — Brain-only: requires PR/issue discussions, temporal context, or multi-source
//   C — Neither likely covers it (sanity check for false positives)

const QUESTIONS: Array<{ q: string; category: QuestionResult["category"]; label: string }> = [
  // Category A: both modes should be able to answer from committed docs
  {
    q: "What is Hono and what are its primary design goals?",
    category: "both_can_answer",
    label: "A1 — Project description (README)",
  },
  {
    q: "What are the breaking changes developers need to handle when migrating from Hono v3 to v4?",
    category: "both_can_answer",
    label: "A2 — Migration guide (MIGRATION.md)",
  },
  {
    q: "How should contributors submit pull requests and what is the code style expected?",
    category: "both_can_answer",
    label: "A3 — Contribution process (CONTRIBUTING.md)",
  },

  // Category B: brain has unique context from PR/issue discussions
  {
    q: "Why did the Hono team decide to support multiple router implementations instead of committing to a single routing algorithm?",
    category: "brain_only",
    label: "B1 — Architecture decision from PR debates",
  },
  {
    q: "What concerns have been raised about Hono's JSX support and how were they resolved?",
    category: "brain_only",
    label: "B2 — Design trade-offs from issue discussions",
  },
  {
    q: "What was the reasoning behind Hono's approach to middleware composition compared to Express?",
    category: "brain_only",
    label: "B3 — Design rationale from PR comments",
  },
  {
    q: "Which contributors have been most actively shaping Hono's adapter and runtime compatibility strategy?",
    category: "brain_only",
    label: "B4 — Team activity (GitHub actor data)",
  },
];

// ── Printing helpers ──────────────────────────────────────────────────────────

function hr(char = "─", width = 68) { return char.repeat(width); }

function pad(s: string, n: number) {
  const str = String(s);
  return str.length >= n ? str.slice(0, n) : str + " ".repeat(n - str.length);
}

function pct(n: number) { return n >= 0 ? `${n}%` : `—`; }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + hr("═"));
  console.log("  Purpl Brain — Document mode vs Brain mode comparison");
  console.log("  Subject: honojs/hono    Project ID: " + PROJECT_ID);
  console.log(hr("═"));

  // ── Step 1: Fetch committed docs ─────────────────────────────────────────
  console.log("\n📄  Fetching Hono committed documentation from GitHub...");
  const { content: docContent, files, totalChars } = await fetchHonoDocs();
  const docTotalTokens = estimateTokens(docContent);

  console.log(`   Files fetched   : ${files.join(", ")}`);
  console.log(`   Total chars     : ${totalChars.toLocaleString()}`);
  console.log(`   Estimated tokens: ${docTotalTokens.toLocaleString()}`);

  // ── Step 2: Run each question through both modes ──────────────────────────
  console.log("\n" + hr());
  console.log("  Running " + QUESTIONS.length + " questions through both modes...");
  console.log(hr());

  const results: QuestionResult[] = [];
  let totalDocTokens = 0;
  let totalBrainTokens = 0;

  for (let i = 0; i < QUESTIONS.length; i++) {
    const { q, category, label } = QUESTIONS[i];
    console.log(`\n  [${i + 1}/${QUESTIONS.length}] ${label}`);
    console.log(`  "${q.slice(0, 80)}${q.length > 80 ? "..." : ""}"`);

    // Doc mode
    process.stdout.write("  📄  Doc mode   ... ");
    let docResult: { answer: string; inputTokens: number };
    try {
      docResult = await docQuery(q, docContent, docTotalTokens);
    } catch (e) {
      docResult = { answer: "", inputTokens: docTotalTokens };
      console.log(`WARN: ${e}`);
    }
    console.log(`${docResult.inputTokens.toLocaleString()} input tokens`);

    // Brain mode
    process.stdout.write("  🧠  Brain mode ... ");
    let brainResult: { answer: string; citations: BrainCitation[]; ctxTokens: number };
    try {
      brainResult = await brainQuery(q);
    } catch (e) {
      brainResult = { answer: "", citations: [], ctxTokens: 0 };
      console.log(`WARN: ${e}`);
    }
    console.log(`${brainResult.ctxTokens.toLocaleString()} ctx tokens  |  ${brainResult.citations.length} citations`);

    const docSub  = isSubstantive(docResult.answer);
    const brainSub = isSubstantive(brainResult.answer);
    const savings = docResult.inputTokens - brainResult.ctxTokens;
    const reductionPct = docResult.inputTokens > 0
      ? Math.round((savings / docResult.inputTokens) * 100)
      : 0;

    totalDocTokens   += docResult.inputTokens;
    totalBrainTokens += brainResult.ctxTokens;

    results.push({
      question: q,
      category,
      doc_input_tokens:    docResult.inputTokens,
      doc_answer_chars:    docResult.answer.length,
      doc_substantive:     docSub,
      brain_ctx_tokens:    brainResult.ctxTokens,
      brain_answer_chars:  brainResult.answer.length,
      brain_substantive:   brainSub,
      brain_citations:     brainResult.citations.length,
      token_savings:       savings,
      token_reduction_pct: reductionPct,
    });
  }

  // ── Step 3: Comparison table ──────────────────────────────────────────────
  console.log("\n\n" + hr("═"));
  console.log("  COMPARISON RESULTS");
  console.log(hr("═"));

  const colW = [36, 10, 10, 8, 8, 10];
  const header = [
    "Question (category)",
    "Doc tokens",
    "Brain ctx",
    "Doc ✓",
    "Brain ✓",
    "Savings",
  ];
  console.log("\n  " + header.map((h, i) => pad(h, colW[i])).join("  "));
  console.log("  " + hr("-", colW.reduce((a, b) => a + b, 0) + colW.length * 2));

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { label } = QUESTIONS[i];
    const shortLabel = label.split("—")[0].trim();
    console.log(
      "  " +
      [
        pad(shortLabel, colW[0]),
        pad(r.doc_input_tokens.toLocaleString(), colW[1]),
        pad(r.brain_ctx_tokens.toLocaleString(), colW[2]),
        pad(r.doc_substantive ? "✓" : "✗", colW[3]),
        pad(r.brain_substantive ? "✓" : "✗", colW[4]),
        pad(pct(r.token_reduction_pct), colW[5]),
      ].join("  ")
    );
  }

  console.log("  " + hr("-", colW.reduce((a, b) => a + b, 0) + colW.length * 2));

  // Totals
  const totalSavings = totalDocTokens - totalBrainTokens;
  const totalReduction = totalDocTokens > 0
    ? Math.round((totalSavings / totalDocTokens) * 100) : 0;
  console.log(
    "  " +
    [
      pad("TOTAL (" + QUESTIONS.length + " questions)", colW[0]),
      pad(totalDocTokens.toLocaleString(), colW[1]),
      pad(totalBrainTokens.toLocaleString(), colW[2]),
      pad(results.filter((r) => r.doc_substantive).length + "/" + results.length, colW[3]),
      pad(results.filter((r) => r.brain_substantive).length + "/" + results.length, colW[4]),
      pad(pct(totalReduction), colW[5]),
    ].join("  ")
  );

  // ── Step 4: Coverage breakdown ────────────────────────────────────────────
  const bothAnswered   = results.filter((r) => r.doc_substantive && r.brain_substantive);
  const brainOnlyAns  = results.filter((r) => !r.doc_substantive && r.brain_substantive);
  const docOnlyAns    = results.filter((r) => r.doc_substantive && !r.brain_substantive);
  const neitherAns    = results.filter((r) => !r.doc_substantive && !r.brain_substantive);

  console.log("\n" + hr("═"));
  console.log("  COVERAGE BREAKDOWN");
  console.log(hr("═"));
  console.log(`\n  Both answered        : ${bothAnswered.length}  (parity — brain cheaper, same coverage)`);
  console.log(`  Brain only answered  : ${brainOnlyAns.length}  (brain advantage — docs had no signal)`);
  console.log(`  Doc only answered    : ${docOnlyAns.length}  (doc advantage — brain missing content)`);
  console.log(`  Neither answered     : ${neitherAns.length}  (out of scope for both)`);

  if (brainOnlyAns.length > 0) {
    console.log("\n  Questions only brain could answer:");
    for (const r of brainOnlyAns) {
      console.log(`    • ${r.question.slice(0, 90)}`);
    }
  }
  if (docOnlyAns.length > 0) {
    console.log("\n  Questions only docs could answer:");
    for (const r of docOnlyAns) {
      console.log(`    • ${r.question.slice(0, 90)}`);
    }
  }

  // ── Step 5: Advantages that can't be tokenised ────────────────────────────
  console.log("\n" + hr("═"));
  console.log("  STRUCTURAL ADVANTAGES OF BRAIN MODE (not measurable in this eval)");
  console.log(hr("═"));

  const advantages = [
    {
      title: "Decision history with rationale",
      doc:   "Docs show the final decision. The *why* is buried in PR comments or lost.",
      brain: "Brain stores decisions with rationale, alternatives considered, and confidence. Every brain_query answer cites the source event.",
    },
    {
      title: "Multi-source context (Slack + Jira + meetings)",
      doc:   "Committed docs only capture what someone bothered to write down.",
      brain: "Brain ingests Slack threads, Jira tickets, and meeting transcripts. A question about a feature surfaces the PR *and* the Slack debate that shaped it.",
    },
    {
      title: "Drift detection",
      doc:   "Docs go stale. No automated mechanism flags when code has diverged from the documented decision.",
      brain: "Drift detector runs continuously. When new PRs contradict a documented decision, a DriftAlert is written to Neo4j and surfaced in queries.",
    },
    {
      title: "Cross-session agent memory",
      doc:   "Each agent session starts cold. If a prior session hit a constraint or made a discovery, the next session re-derives it from scratch.",
      brain: "Agent sessions write decisions back via brain_log_decision. The next session queries brain_query and resumes with full prior context — no re-derivation.",
    },
    {
      title: "Temporal and causal queries",
      doc:   "Docs have no timeline. You can't ask 'what changed after the v4 migration?' or 'what decisions were made before we switched routers?'",
      brain: "Every event has a timestamp. Temporal queries ('last 7 days', 'before the migration') are first-class query modes.",
    },
    {
      title: "Impact analysis before changes",
      doc:   "Agent must manually trace which docs are affected by a change.",
      brain: "brain_analyze_impact takes a proposed change description and returns which past decisions it affects, with risk level.",
    },
    {
      title: "Zero maintenance context freshness",
      doc:   "Someone has to update CLAUDE.md, ADRs, and README when things change. Teams rarely do this consistently.",
      brain: "Brain auto-ingests every merged PR and closed issue. Context freshness is a byproduct of normal team activity.",
    },
  ];

  for (const a of advantages) {
    console.log(`\n  ${a.title}`);
    console.log(`    Doc mode : ${a.doc}`);
    console.log(`    Brain    : ${a.brain}`);
  }

  // ── Step 6: Full cost accounting (including brain-side costs) ───────────────
  //
  // Three cost buckets:
  //   1. Downstream agent context — tokens the calling agent processes per question
  //   2. Brain query synthesis    — LLM call inside brain_query to compose the answer
  //   3. Brain ingestion          — one-time extraction cost when seeding the brain
  //
  // Pricing (Anthropic Sonnet input: $3/1M, output: $15/1M; Haiku: $0.25/$1.25)
  console.log("\n" + hr("═"));
  console.log("  FULL COST ACCOUNTING (Anthropic Sonnet pricing, 50 questions/day)");
  console.log(hr("═"));

  const avgDocTokens   = totalDocTokens / QUESTIONS.length;
  const avgBrainCtxTokens = totalBrainTokens / QUESTIONS.length;

  // Estimated brain query synthesis cost per call:
  //   Input  = system prompt (~600 tok, cached after first) + ctx (~151 tok) + question (~20 tok)
  //   Output = answer (~300 tok based on observed ~1200 char avg)
  //   Using cache-warm estimate: ~170 fresh input + 300 output per call
  const SONNET_INPUT_PER_1M  = 3.0;
  const SONNET_OUTPUT_PER_1M = 15.0;
  const HAIKU_INPUT_PER_1M   = 0.25;
  const HAIKU_OUTPUT_PER_1M  = 1.25;

  const brainSynthInputTokens  = 170;  // fresh (system prompt cached)
  const brainSynthOutputTokens = 300;
  const brainSynthCostPerCall  =
    (brainSynthInputTokens  / 1_000_000) * SONNET_INPUT_PER_1M +
    (brainSynthOutputTokens / 1_000_000) * SONNET_OUTPUT_PER_1M;

  // Ingestion cost: 50 PRs × ~5 chunks × Haiku extraction (~500 in + 150 out per chunk)
  // One-time cost, amortised over 30 days of questions
  const ingestCalls = 250;  // 50 PRs × 5 chunks each
  const ingestCostOneTime =
    (ingestCalls * 500 / 1_000_000) * HAIKU_INPUT_PER_1M +
    (ingestCalls * 150 / 1_000_000) * HAIKU_OUTPUT_PER_1M;
  const ingestCostPerDay = ingestCostOneTime / 30;  // amortised

  const DAILY_QUESTIONS = 50;

  // Doc mode: agent loads full docs per question (no synthesis call needed — docs go directly into agent context)
  const dailyDocContextCost = (avgDocTokens * DAILY_QUESTIONS / 1_000_000) * SONNET_INPUT_PER_1M;
  const dailyDocTotalCost   = dailyDocContextCost;  // no brain infra

  // Brain mode: agent context (tiny — it reads the brain answer) + brain synthesis + ingestion amortised
  const avgBrainAnswerTokens  = 300;  // tokens the calling agent reads from the brain answer
  const dailyBrainAgentCost   = (avgBrainAnswerTokens * DAILY_QUESTIONS / 1_000_000) * SONNET_INPUT_PER_1M;
  const dailyBrainSynthCost   = brainSynthCostPerCall * DAILY_QUESTIONS;
  const dailyBrainTotalCost   = dailyBrainAgentCost + dailyBrainSynthCost + ingestCostPerDay;

  const dailySavings   = dailyDocTotalCost - dailyBrainTotalCost;
  const monthlySavings = dailySavings * 30;

  console.log(`\n  ── Doc mode (${DAILY_QUESTIONS} questions/day) ──`);
  console.log(`  Context loaded per question     : ~${Math.round(avgDocTokens).toLocaleString()} tokens`);
  console.log(`  Agent context cost              : $${dailyDocContextCost.toFixed(4)}/day`);
  console.log(`  Brain infra cost                : $0.0000  (none)`);
  console.log(`  Total daily cost                : $${dailyDocTotalCost.toFixed(4)}/day`);

  console.log(`\n  ── Brain mode (${DAILY_QUESTIONS} questions/day) ──`);
  console.log(`  Agent reads brain answer        : ~${avgBrainAnswerTokens} tokens (not full docs)`);
  console.log(`  Agent context cost              : $${dailyBrainAgentCost.toFixed(4)}/day`);
  console.log(`  Brain synthesis per query       : ~${brainSynthInputTokens}t in + ${brainSynthOutputTokens}t out (cache-warm)`);
  console.log(`  Brain synthesis cost            : $${dailyBrainSynthCost.toFixed(4)}/day`);
  console.log(`  Ingestion cost (amortised/day)  : $${ingestCostPerDay.toFixed(4)}  [one-time: $${ingestCostOneTime.toFixed(4)} over 30 days]`);
  console.log(`  Total daily cost                : $${dailyBrainTotalCost.toFixed(4)}/day`);

  console.log(`\n  ── Net comparison ──`);
  console.log(`  Daily savings (brain vs doc)    : $${dailySavings.toFixed(4)}`);
  console.log(`  Monthly savings (30 days)       : $${monthlySavings.toFixed(2)}`);
  console.log(`  Break-even (if brain costs more): ${dailySavings < 0 ? "brain is more expensive" : "brain is cheaper per day"}`);
  console.log(`\n  Note: at larger scale (200 questions/day, active team), ingestion is`);
  console.log(`  amortised further and brain synthesis caching benefits compound.`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n" + hr("═"));
  console.log("  SUMMARY");
  console.log(hr("═"));
  console.log(`\n  Questions tested    : ${QUESTIONS.length}`);
  console.log(`  Doc mode coverage   : ${results.filter((r) => r.doc_substantive).length}/${QUESTIONS.length} questions answered`);
  console.log(`  Brain coverage      : ${results.filter((r) => r.brain_substantive).length}/${QUESTIONS.length} questions answered`);
  console.log(`  Brain-only answers  : ${brainOnlyAns.length} (questions docs cannot answer at all)`);
  console.log(`  Token reduction     : ${pct(totalReduction)} fewer context tokens per session`);
  console.log(`  Structural advantages: ${advantages.length} (decision history, drift alerts, multi-source, etc.)`);
}

main().catch((e) => {
  console.error("Comparison eval crashed:", e);
  process.exit(1);
});
