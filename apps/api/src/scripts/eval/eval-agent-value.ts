/**
 * eval-agent-value.ts — A/B eval: brain-assisted agent vs cold-start agent
 *
 * Simulates the User B orchestration pattern:
 *
 *   Condition A (cold):  orchestrator dispatches task to agent with no prior context.
 *                        Agent must reason from scratch.
 *
 *   Condition B (brain): orchestrator calls POST /query with the task description,
 *                        injects the brain's response into the agent prompt, then
 *                        dispatches. Agent reasons with full prior decision context.
 *
 * The eval seeds a realistic set of prior decisions into a throwaway project,
 * waits for pipeline propagation, then runs 3 representative tasks under both
 * conditions. An LLM judge scores each output against the relevant prior decisions.
 *
 * Metrics per task:
 *   alignment_rate     — % of relevant prior decisions the agent is consistent with
 *   citation_rate      — % of prior decisions explicitly referenced
 *   contradiction_rate — % of prior decisions the agent contradicts
 *
 * Summary across all tasks:
 *   cold vs brain delta on each metric — this is the value-add signal.
 *
 * Requires (one of):
 *   ANTHROPIC_API_KEY — use Claude Haiku for agent + judge
 *   OLLAMA_BASE_URL   — use Ollama (defaults to http://localhost:11434/v1)
 *                       Models: OLLAMA_SMART_MODEL (agent), OLLAMA_FAST_MODEL (judge)
 *   BRAIN_API_KEY / DEV_API_KEY — brain REST API auth
 *   API_BASE — defaults to http://localhost:3001
 *
 * Run: npm run eval:agent-value -w apps/api
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { cleanupEvalProjects } from "../../lib/eval-cleanup.js";

// ── Config ────────────────────────────────────────────────────────────────────

const API_BASE    = process.env.API_BASE ?? "http://localhost:3001";
const API_KEY     = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "";
const RUN_ID      = Date.now();
const PROJECT_ID  = `eval_agent_value_${RUN_ID}`;
const SESSION_ID  = `eval-ab-seed-${RUN_ID}`;
const PIPELINE_WAIT_MS = parseInt(process.env.PIPELINE_WAIT_MS ?? "150000");

// ── Provider detection ────────────────────────────────────────────────────────
// Respects LLM_PROVIDER (same as the rest of the project).
// Falls back to key-format check: a real Anthropic key starts with sk-ant-api.

const _apiKey = process.env.ANTHROPIC_API_KEY ?? "";
const _validKey = _apiKey.startsWith("sk-ant-api") && _apiKey.length > 30;
const USE_ANTHROPIC = (process.env.LLM_PROVIDER === "anthropic" || (!process.env.LLM_PROVIDER && _validKey));
const OLLAMA_BASE   = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1";
const AGENT_MODEL   = USE_ANTHROPIC
  ? "claude-haiku-4-5-20251001"
  : (process.env.OLLAMA_SMART_MODEL ?? "llama3.1:8b");
const JUDGE_MODEL   = USE_ANTHROPIC
  ? "claude-haiku-4-5-20251001"
  : (process.env.OLLAMA_FAST_MODEL ?? "qwen2.5:7b");

const anthropic = USE_ANTHROPIC
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const ollama = !USE_ANTHROPIC
  ? new OpenAI({ baseURL: OLLAMA_BASE, apiKey: "ollama" })
  : null;

async function llmComplete(model: string, system: string, user: string, maxTokens: number): Promise<string> {
  if (anthropic) {
    const res = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as unknown as Anthropic.Messages.TextBlockParam[],
      messages: [{ role: "user", content: user }],
    });
    return res.content.find(b => b.type === "text")?.text ?? "";
  }
  const res = await ollama!.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return res.choices[0]?.message?.content ?? "";
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) { console.log(`    PASS  ${name}`); passed++; }
  else           { console.error(`    FAIL  ${name}${detail ? `\n          ${detail}` : ""}`); failed++; }
}

function phase(n: number, label: string) {
  console.log(`\n── Phase ${n}: ${label} ──`);
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

async function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`;
}

// ── Prior decisions to seed ───────────────────────────────────────────────────
//
// Five realistic decisions about a web API project, using real technology names
// so they embed with meaningful vectors (fictional names score below the 0.55
// cosine threshold in nomic-embed-text and won't be retrieved).
//
// KNOWN LIMITATION (EVAL-4 class): Several decisions below (JWT, Zod, RFC 7807)
// are established best practices the base model may already prefer. The
// brain-assisted condition can show inflated alignment because the model agrees
// with the decisions from prior knowledge, not because the brain transmitted
// novel information. To isolate brain value, decisions should be project-specific
// choices the model has no prior reason to prefer (e.g. "use jose not
// jsonwebtoken", a custom error field name, a non-default TTL). This eval
// measures direction-of-effect correctly but may overstate magnitude on
// well-known decisions. Run eval-agent-value-hono for the corpus-derived variant.

const PRIOR_DECISIONS = [
  {
    id: "auth-jwt-stateless",
    description: "Use stateless JWT for authentication — no server-side token store.",
    rationale:
      "Server-side sessions require a shared session store across instances and " +
      "add a Redis lookup on every authenticated request. Stateless JWT eliminates " +
      "this dependency. Access token TTL is 15 minutes; refresh tokens stored in " +
      "Redis with a 7-day TTL and single-use invalidation.",
    alternatives_considered: ["server-side sessions with Redis store", "opaque bearer tokens with database lookup"],
    confidence: "high" as const,
  },
  {
    id: "validation-zod-boundary",
    description: "All request bodies validated with Zod at the route handler boundary before any business logic runs.",
    rationale:
      "Validation at the boundary prevents malformed data from reaching services. " +
      "Zod is already a project dependency and provides TypeScript inference at zero " +
      "runtime overhead. FastifySchema JSON Schema validation was considered but Zod " +
      "gives richer error messages and works with the existing type system.",
    alternatives_considered: ["Fastify built-in JSON schema validation", "joi", "manual validation"],
    confidence: "high" as const,
  },
  {
    id: "rate-limiting-plugin-layer",
    description: "Rate limiting applied at the Fastify plugin layer via @fastify/rate-limit, not inside individual route handlers.",
    rationale:
      "Handler-level rate limiting requires duplication across routes and is easy to " +
      "miss on new routes. The Fastify plugin fires before any handler, ensuring " +
      "uniform enforcement. Per-route overrides are possible via routeConfig.",
    alternatives_considered: ["per-handler rate limiting", "API gateway rate limiting only"],
    confidence: "high" as const,
  },
  {
    id: "error-rfc7807",
    description: "All error responses follow RFC 7807 (application/problem+json): type, title, status, detail fields.",
    rationale:
      "Standardised error shape means clients have one parsing path regardless of " +
      "which route errored. RFC 7807 is broadly understood and has tooling support. " +
      "Custom error shapes were rejected — they require per-client documentation and " +
      "break any standard HTTP client error handling.",
    alternatives_considered: ["custom {error, message} shape", "GraphQL-style errors array"],
    confidence: "high" as const,
  },
  {
    id: "cache-redis-route-level",
    description: "Cache GET response bodies in Redis keyed by route path + query param hash, 5-minute TTL. Never cache authenticated or user-specific responses.",
    rationale:
      "In-memory caching was ruled out — doesn't survive restarts or scale across " +
      "instances. CDN caching was ruled out — requires cache-control header discipline " +
      "and doesn't cover internal API calls. Redis is already a project dependency " +
      "for rate limiting, so no new infrastructure.",
    alternatives_considered: ["in-memory LRU cache", "CDN edge caching", "no caching"],
    confidence: "medium" as const,
  },
];

// ── Test tasks ────────────────────────────────────────────────────────────────
//
// Three tasks, each touching 2 prior decisions. The cold agent has no context.
// The brain agent receives brain_query(task.description) injected into its prompt.

const TEST_TASKS = [
  {
    label: "T1 — User session endpoint",
    description:
      "Design a POST /sessions endpoint. It should accept email + password, " +
      "verify credentials, and return a token the client will use for subsequent " +
      "authenticated requests. Include how errors should be returned.",
    relevant_decision_ids: ["auth-jwt-stateless", "error-rfc7807"],
  },
  {
    label: "T2 — File upload endpoint",
    description:
      "Design a POST /upload endpoint that accepts a file path and metadata " +
      "(title, description, tags array). Describe input validation approach and " +
      "how invalid inputs should be handled and reported to the client.",
    relevant_decision_ids: ["validation-zod-boundary", "error-rfc7807"],
  },
  {
    label: "T3 — Rate limiting and caching for a new public route",
    description:
      "We are adding a GET /products endpoint that returns a product catalogue. " +
      "Describe how you would add rate limiting and response caching. Be specific " +
      "about where rate limiting should be applied and what caching strategy to use.",
    relevant_decision_ids: ["rate-limiting-plugin-layer", "cache-redis-route-level"],
  },
];

// ── Brain API calls ───────────────────────────────────────────────────────────

async function seedDecisions(): Promise<boolean> {
  const res = await fetch(`${API_BASE}/brain/agent-log`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      session_id: SESSION_ID,
      project_id: PROJECT_ID,
      agent_id: "eval-ab-seeder",
      work_completed: "Established core API design decisions for the web service.",
      decisions: PRIOR_DECISIONS,
    }),
  });
  return res.ok;
}

async function brainQuery(taskDescription: string): Promise<{ context: string; tokens: number }> {
  const res = await fetch(`${API_BASE}/brain/query`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      query: taskDescription,
      project_id: PROJECT_ID,
      mode: "project",
    }),
  });
  if (!res.ok) return { context: "", tokens: 0 };
  const body = await res.json() as { answer?: string; citations?: Array<{ quoted_text?: string; content?: string }> };
  const answer = body.answer ?? "";
  const citationText = (body.citations ?? [])
    .map(c => c.quoted_text ?? c.content ?? "")
    .join(" ");
  const context = answer + "\n\n" + citationText;
  const tokens = Math.round(context.length / 4); // rough estimate
  return { context, tokens };
}

// ── Agent calls ───────────────────────────────────────────────────────────────

const AGENT_SYSTEM =
  "You are a senior software engineer advising on API design. " +
  "Answer concisely. Focus on concrete implementation choices and the " +
  "reasoning behind them. Be specific about technologies and patterns.";

async function runAgent(task: string, brainContext: string): Promise<string> {
  const userContent = brainContext
    ? `Prior decisions from the project brain that are relevant to this task:\n\n${brainContext}\n\n---\n\nTask: ${task}`
    : `Task: ${task}`;
  return llmComplete(AGENT_MODEL, AGENT_SYSTEM, userContent, 600);
}

// ── LLM judge ─────────────────────────────────────────────────────────────────

interface Judgement {
  consistent: boolean;
  cited: boolean;
  contradicted: boolean;
  reasoning: string;
}

const JUDGE_SYSTEM =
  "You are an impartial evaluator assessing whether an agent's design output " +
  "is consistent with a prior architectural decision. Respond only with valid JSON.";

async function judge(decision: typeof PRIOR_DECISIONS[0], agentOutput: string): Promise<Judgement> {
  const prompt =
    `Prior decision:\n"${decision.description}"\nRationale: ${decision.rationale}\n\n` +
    `Agent output:\n${agentOutput}\n\n` +
    `Score the agent output on three dimensions:\n` +
    `1. consistent: Is the agent's approach compatible with the prior decision? (true/false)\n` +
    `2. cited: Does the agent explicitly mention or reference the prior decision's approach? (true/false)\n` +
    `3. contradicted: Does the agent recommend something that directly conflicts with the prior decision? (true/false)\n` +
    `Respond with JSON only: {"consistent": bool, "cited": bool, "contradicted": bool, "reasoning": "one sentence"}`;

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
  cold: { alignment: number; citations: number; contradictions: number; total: number };
  brain: { alignment: number; citations: number; contradictions: number; total: number; context_tokens: number };
}

async function main() {
  console.log("eval-agent-value: A/B — brain-assisted vs cold-start agent\n");
  console.log(`Project:    ${PROJECT_ID}`);
  console.log(`Agent:      ${AGENT_MODEL}  Judge: ${JUDGE_MODEL}`);
  console.log(`Tasks:      ${TEST_TASKS.length}`);
  console.log(`Decisions:  ${PRIOR_DECISIONS.length}`);

  const provider = USE_ANTHROPIC ? `Anthropic (${AGENT_MODEL})` : `Ollama (agent: ${AGENT_MODEL}, judge: ${JUDGE_MODEL})`;
  console.log(`Provider:   ${provider}`);

  if (!USE_ANTHROPIC) {
    const ollamaOk = await fetch(`${OLLAMA_BASE}/models`).then(r => r.ok).catch(() => false);
    if (!ollamaOk) {
      console.error(`\nOllama not reachable at ${OLLAMA_BASE}. Is Ollama running?`);
      process.exit(1);
    }
  }

  const results: TaskMetrics[] = [];

  try {
    // ── Phase 0: Health ────────────────────────────────────────────────────────
    phase(0, "Health check");
    const health = await fetch(`${API_BASE}/health`).catch(() => null);
    check("Brain API reachable", health?.ok === true, `GET ${API_BASE}/health`);
    if (health?.ok !== true) {
      console.error("\nBrain API not reachable — is docker compose up?");
      process.exit(1);
    }

    // ── Phase 1: Seed decisions ────────────────────────────────────────────────
    phase(1, `Seed ${PRIOR_DECISIONS.length} prior decisions`);
    const seeded = await seedDecisions();
    check("agent-log accepted", seeded);
    PRIOR_DECISIONS.forEach(d => console.log(`    seeded  ${d.id}`));

    // ── Phase 2: Pipeline propagation ─────────────────────────────────────────
    phase(2, `Wait for pipeline (${PIPELINE_WAIT_MS / 1000}s)`);
    console.log("    Decisions are flowing through normalizer → extractor → brain-writer.");
    console.log(`    Override with PIPELINE_WAIT_MS env var.\n`);
    await sleep(PIPELINE_WAIT_MS);
    console.log("    Done waiting.");

    // ── Phase 3: Run A/B tasks ─────────────────────────────────────────────────
    phase(3, "A/B task runs");

    for (const task of TEST_TASKS) {
      console.log(`\n  ${task.label}`);
      const relevantDecisions = PRIOR_DECISIONS.filter(d =>
        task.relevant_decision_ids.includes(d.id)
      );

      // Condition A — cold
      console.log("    [A] cold start — running agent with no context...");
      const coldOutput = await runAgent(task.description, "");

      // Condition B — brain-assisted
      console.log("    [B] brain-assisted — fetching context from brain...");
      const { context: brainContext, tokens: ctxTokens } = await brainQuery(task.description);
      const hasContext = brainContext.trim().length > 50;
      console.log(`    [B] context retrieved: ${hasContext ? `~${ctxTokens} tokens` : "none (brain may still be processing)"}`);
      const brainOutput = await runAgent(task.description, brainContext);

      // Judge both outputs
      const coldMetrics = { alignment: 0, citations: 0, contradictions: 0, total: relevantDecisions.length };
      const brainMetrics = { alignment: 0, citations: 0, contradictions: 0, total: relevantDecisions.length, context_tokens: ctxTokens };

      for (const decision of relevantDecisions) {
        const coldJ  = await judge(decision, coldOutput);
        const brainJ = await judge(decision, brainOutput);

        if (coldJ.consistent)    coldMetrics.alignment++;
        if (coldJ.cited)         coldMetrics.citations++;
        if (coldJ.contradicted)  coldMetrics.contradictions++;

        if (brainJ.consistent)   brainMetrics.alignment++;
        if (brainJ.cited)        brainMetrics.citations++;
        if (brainJ.contradicted) brainMetrics.contradictions++;

        console.log(`\n    Decision: ${decision.id}`);
        console.log(`      Cold  — consistent:${coldJ.consistent}  cited:${coldJ.cited}  contradicted:${coldJ.contradicted}`);
        console.log(`              ${coldJ.reasoning}`);
        console.log(`      Brain — consistent:${brainJ.consistent}  cited:${brainJ.cited}  contradicted:${brainJ.contradicted}`);
        console.log(`              ${brainJ.reasoning}`);
      }

      results.push({ label: task.label, cold: coldMetrics, brain: brainMetrics });
    }

    // ── Phase 4: Summary ───────────────────────────────────────────────────────
    phase(4, "Results summary");

    const totals = {
      cold:  { alignment: 0, citations: 0, contradictions: 0, total: 0 },
      brain: { alignment: 0, citations: 0, contradictions: 0, total: 0 },
    };

    console.log("\n  Task                          | Metric          | Cold | Brain | Delta");
    console.log("  ------------------------------|-----------------|------|-------|------");

    for (const r of results) {
      const t = r.cold.total;
      totals.cold.alignment     += r.cold.alignment;
      totals.cold.citations     += r.cold.citations;
      totals.cold.contradictions += r.cold.contradictions;
      totals.cold.total         += t;
      totals.brain.alignment    += r.brain.alignment;
      totals.brain.citations    += r.brain.citations;
      totals.brain.contradictions += r.brain.contradictions;
      totals.brain.total        += t;

      const metrics = [
        ["alignment",     r.cold.alignment,     r.brain.alignment],
        ["citations",     r.cold.citations,     r.brain.citations],
        ["contradictions",r.cold.contradictions,r.brain.contradictions],
      ] as [string, number, number][];

      for (const [name, c, b] of metrics) {
        const delta = b - c;
        const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
        console.log(
          `  ${r.label.padEnd(30)}| ${name.padEnd(15)} | ${String(c).padEnd(4)} | ${String(b).padEnd(5)} | ${deltaStr}`
        );
      }
      console.log(`  ${" ".repeat(30)}| ctx_tokens      |  n/a | ${String(r.brain.context_tokens).padEnd(5)} |`);
    }

    const ct = totals.cold.total;
    const bt = totals.brain.total;

    console.log("\n  ── Overall ─────────────────────────────────────────────────");
    console.log(`  Alignment rate     cold: ${pct(totals.cold.alignment, ct)}   brain: ${pct(totals.brain.alignment, bt)}   delta: +${totals.brain.alignment - totals.cold.alignment} decisions`);
    console.log(`  Citation rate      cold: ${pct(totals.cold.citations, ct)}   brain: ${pct(totals.brain.citations, bt)}   delta: +${totals.brain.citations - totals.cold.citations} explicit references`);
    console.log(`  Contradiction rate cold: ${pct(totals.cold.contradictions, ct)}   brain: ${pct(totals.brain.contradictions, bt)}   delta: ${totals.brain.contradictions - totals.cold.contradictions} contradictions`);

    // Assertions
    const brainAlignmentRate = bt > 0 ? totals.brain.alignment / bt : 0;
    const coldAlignmentRate  = ct > 0 ? totals.cold.alignment  / ct : 0;
    const alignmentDelta = brainAlignmentRate - coldAlignmentRate;

    check(
      "Brain condition alignment rate ≥ 60%",
      brainAlignmentRate >= 0.60,
      `Got ${pct(totals.brain.alignment, bt)}`
    );
    check(
      "Brain condition alignment rate > cold condition",
      brainAlignmentRate > coldAlignmentRate,
      `Brain: ${pct(totals.brain.alignment, bt)}, Cold: ${pct(totals.cold.alignment, ct)}`
    );
    check(
      "Brain condition citation rate > 0%",
      totals.brain.citations > 0,
      "Brain agent should explicitly reference at least one prior decision"
    );
    check(
      "Brain condition contradiction rate ≤ cold condition",
      totals.brain.contradictions <= totals.cold.contradictions,
      `Brain: ${totals.brain.contradictions}, Cold: ${totals.cold.contradictions}`
    );

    if (!hasContext(results)) {
      console.warn(
        "\n  WARNING: brain context was empty for one or more tasks." +
        "\n  Pipeline may not have finished. Re-run with a longer PIPELINE_WAIT_MS."
      );
    }

  } finally {
    phase(5, "Cleanup");
    await cleanupEvalProjects([PROJECT_ID]);
    console.log(`    Cleaned up project ${PROJECT_ID}`);
  }

  console.log(`\n── Result: ${passed} passed, ${failed} failed ──`);
  process.exit(failed > 0 ? 1 : 0);
}

function hasContext(results: TaskMetrics[]): boolean {
  return results.some(r => r.brain.context_tokens > 0);
}

main().catch(err => {
  console.error("eval-agent-value crashed:", err);
  process.exit(1);
});
