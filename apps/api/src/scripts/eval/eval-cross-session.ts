/**
 * eval-cross-session — cross-session decision recall
 *
 * Tests the core promise of purpl_brain: a new session can recall decisions
 * logged by different agents at different points in time — without any of
 * that history being passed in the current context window.
 *
 * Structure:
 *   Seed 5 decisions across 5 sessions, spread over simulated 3-week window,
 *   logged by different agent IDs. Then open a "new session" and run 5 queries,
 *   each targeting a specific prior session's decision.
 *
 * Pass criterion per query:
 *   - Answer contains the key decision facts (keyword match)
 *   - At least one citation has source === "agent"
 *
 * Aggregate pass: ≥ 4/5 queries pass (80% cross-session recall)
 *
 * Usage:
 *   npm run eval:cross-session -w apps/api
 */
import "dotenv/config";
import { cleanupEvalProjects } from "../lib/eval-cleanup.js";

const API = process.env.BRAIN_API_URL ?? "http://localhost:3001";
const API_KEY = process.env.BRAIN_API_KEY ?? "dev-local";
const RUN_ID = Date.now();
const PROJECT = `eval_xsess_${RUN_ID}`;

const now = Date.now();
const DAY = 86_400_000;

// ── 5 sessions seeded at different simulated timestamps ────────────────────────
// Each uses a different agent_id to simulate real cross-agent usage.
// The timestamps are backdated so they look like real historical decisions.

const SESSIONS = [
  {
    label: "S1 (3 weeks ago, claude-code)",
    agent_id: "claude-code",
    timestamp_start: new Date(now - 21 * DAY).toISOString(),
    timestamp_end:   new Date(now - 21 * DAY + 45 * 60_000).toISOString(),
    session_id: `sess_s1_${RUN_ID}`,
    decisions: [
      {
        id: "d1",
        description: "Chose Qdrant over pgvector for semantic search",
        rationale:
          "Qdrant's HNSW index sustains sub-10ms p99 at 2M+ vectors with payload filtering; " +
          "pgvector degrades past 500K rows without IVFFlat tuning and lacks native ANN-with-filter support",
        alternatives_considered: ["pgvector", "Weaviate", "Pinecone"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Evaluated vector DB options and selected Qdrant",
    files_modified: ["docs/adrs/001-hybrid-brain-store.md"],
  },
  {
    label: "S2 (2 weeks ago, cursor)",
    agent_id: "cursor",
    timestamp_start: new Date(now - 14 * DAY).toISOString(),
    timestamp_end:   new Date(now - 14 * DAY + 30 * 60_000).toISOString(),
    session_id: `sess_s2_${RUN_ID}`,
    decisions: [
      {
        id: "d2",
        description: "Adopted Redis Streams over Apache Kafka for event ingestion pipeline",
        rationale:
          "Team has no operational Kafka experience; Redis is already in the stack for caching. " +
          "Kafka adds broker management overhead that isn't justified at current event volumes below 10K/day",
        alternatives_considered: ["Apache Kafka", "RabbitMQ", "in-process queue"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Implemented ingestion pipeline with Redis Streams",
    files_modified: ["apps/api/src/lib/redis.ts", "docs/adrs/003-event-driven-ingestion.md"],
  },
  {
    label: "S3 (1 week ago, claude-code)",
    agent_id: "claude-code",
    timestamp_start: new Date(now - 7 * DAY).toISOString(),
    timestamp_end:   new Date(now - 7 * DAY + 60 * 60_000).toISOString(),
    session_id: `sess_s3_${RUN_ID}`,
    decisions: [
      {
        id: "d3",
        description: "Rejected Elasticsearch for full-text search; Qdrant payload filtering is sufficient",
        rationale:
          "Adding Elasticsearch would double infrastructure cost and require a third data store. " +
          "Qdrant's payload filtering with BM25 pre-filter covers all query patterns identified so far. " +
          "Revisit if query volume exceeds 50K/day or faceted search is required.",
        alternatives_considered: ["Elasticsearch", "Typesense", "Meilisearch"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Validated Qdrant query patterns, rejected Elasticsearch",
    files_modified: ["apps/api/src/services/query-engine.ts"],
  },
  {
    label: "S4 (3 days ago, windsurf)",
    agent_id: "windsurf",
    timestamp_start: new Date(now - 3 * DAY).toISOString(),
    timestamp_end:   new Date(now - 3 * DAY + 20 * 60_000).toISOString(),
    session_id: `sess_s4_${RUN_ID}`,
    decisions: [
      {
        id: "d4",
        description: "Set JWT access token expiry to 15 minutes; refresh tokens expire in 7 days",
        rationale:
          "Security audit flagged the previous 24-hour access token window as too long. " +
          "15 minutes limits the blast radius of a leaked token. " +
          "7-day refresh tokens balance security with user experience — no re-login required for a work week.",
        alternatives_considered: ["1 hour access tokens", "30-minute access tokens", "opaque session tokens"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Shortened JWT expiry after security audit findings",
    files_modified: ["apps/api/src/middleware/auth.ts"],
  },
  {
    label: "S5 (yesterday, cursor)",
    agent_id: "cursor",
    timestamp_start: new Date(now - 1 * DAY).toISOString(),
    timestamp_end:   new Date(now - 1 * DAY + 15 * 60_000).toISOString(),
    session_id: `sess_s5_${RUN_ID}`,
    decisions: [
      {
        id: "d5",
        description: "Deferred TypeScript strict mode migration until after 1.0 beta release",
        rationale:
          "Enabling strict mode would require fixing ~340 implicit-any errors across the codebase. " +
          "This blocks beta shipping by an estimated 2 weeks. " +
          "Decision: enable strictNullChecks only, defer noImplicitAny until post-1.0.",
        alternatives_considered: ["full strict mode now", "no strict mode at all"],
        confidence: "high" as const,
      },
    ],
    work_completed: "Investigated TypeScript strict mode migration cost",
    files_modified: ["tsconfig.json"],
  },
];

// ── Queries targeting each session specifically ────────────────────────────────
// Each query's answer is ONLY derivable from one specific session's decisions.
// None of this information is passed in the current query context.

const QUERIES = [
  {
    session_label: "S1",
    query: "Why did we choose Qdrant over pgvector for semantic search? What alternatives were considered?",
    required_keywords: ["qdrant", "pgvector", "hnsw", "vector"],
    description: "Session 1 decision: vector DB selection",
  },
  {
    session_label: "S2",
    query: "Why did we use Redis Streams instead of Kafka for the event ingestion pipeline?",
    required_keywords: ["kafka", "redis", "streams", "operational"],
    description: "Session 2 decision: event queue selection",
  },
  {
    session_label: "S3",
    query: "Was Elasticsearch considered for search? Why was it rejected?",
    required_keywords: ["elasticsearch", "qdrant", "infrastructure", "payload"],
    description: "Session 3 decision: search engine rejection",
  },
  {
    session_label: "S4",
    query: "What is the JWT token expiry and why was it changed from the original setting?",
    required_keywords: ["jwt", "15", "expiry", "security", "audit"],
    description: "Session 4 decision: auth token expiry",
  },
  {
    session_label: "S5",
    query: "What is the status of TypeScript strict mode? When will it be enabled?",
    required_keywords: ["typescript", "strict", "beta", "deferred"],
    description: "Session 5 decision: TypeScript migration",
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
  };
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function matchesKeywords(answer: string, keywords: string[]): string[] {
  const lower = answer.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw.toLowerCase()));
}

// ── Main ───────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: Array<{
  query: string;
  session_label: string;
  pass: boolean;
  matched: string[];
  missing: string[];
  has_agent_citation: boolean;
  answer_snippet: string;
  latency_ms: number;
}> = [];

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log("\n── eval-cross-session: cross-session decision recall ──\n");
console.log(`  Project : ${PROJECT}`);
console.log(`  Sessions: ${SESSIONS.length} (spanning simulated 3-week window)`);
console.log(`  Agents  : ${[...new Set(SESSIONS.map((s) => s.agent_id))].join(", ")}`);
console.log(`  Queries : ${QUERIES.length} (each targeting a specific prior session)\n`);

// ── Phase 1: Seed sessions ────────────────────────────────────────────────────

console.log("── Phase 1: Seed sessions via brain_log_decision ──\n");

for (const session of SESSIONS) {
  await check(`Log ${session.label}`, async () => {
    const result = await post("/brain/agent-log", {
      schema_version: "1.0",
      session_id: session.session_id,
      agent_id: session.agent_id,
      project_id: PROJECT,
      task_id: `eval-task-${session.session_id}`,
      codebase: "eval-cross-session",
      timestamp_start: session.timestamp_start,
      timestamp_end: session.timestamp_end,
      decisions: session.decisions,
      work_completed: session.work_completed,
      files_modified: session.files_modified,
    }) as { event_id: string; decisions_logged: number };

    if (result.decisions_logged !== session.decisions.length) {
      throw new Error(`Expected ${session.decisions.length} decisions logged, got ${result.decisions_logged}`);
    }
  });
}

// ── Phase 2: Wait for pipeline ────────────────────────────────────────────────

console.log("\n── Phase 2: Wait for pipeline ──\n");
console.log("  Agent logs bypass the extractor — straight to brain-writer.");
console.log("  Waiting 15s for brain-writer + Qdrant indexing...\n");
await sleep(15_000);
console.log("  Done.\n");

// ── Phase 3: Cross-session queries ────────────────────────────────────────────

console.log("── Phase 3: Cross-session recall queries ──\n");
console.log("  Each query is run in a fresh context with no prior session history.");
console.log("  The only way to answer correctly is to retrieve from the brain.\n");

for (const q of QUERIES) {
  const t0 = Date.now();
  let pass = false;
  let matched: string[] = [];
  let missing: string[] = [];
  let has_agent_citation = false;
  let answer_snippet = "";

  try {
    const res = await post("/brain/query", {
      query: q.query,
      project_id: PROJECT,
      mode: "project",
    }) as { answer: string; citations: Array<{ source: string }> };

    const latency_ms = Date.now() - t0;
    answer_snippet = res.answer.slice(0, 200);
    matched = matchesKeywords(res.answer, q.required_keywords);
    missing = q.required_keywords.filter((kw) => !matched.includes(kw));
    has_agent_citation = res.citations.some((c) => c.source === "agent");
    pass = matched.length >= Math.ceil(q.required_keywords.length * 0.6) && has_agent_citation;

    results.push({ query: q.query, session_label: q.session_label, pass, matched, missing, has_agent_citation, answer_snippet, latency_ms });

    const icon = pass ? "✓" : "✗";
    console.log(`  ${icon} [${q.session_label}] ${q.description}`);
    console.log(`      Keywords matched: ${matched.length}/${q.required_keywords.length} [${matched.join(", ")}]`);
    if (missing.length) console.log(`      Missing        : [${missing.join(", ")}]`);
    console.log(`      Agent citation : ${has_agent_citation ? "yes" : "NO"}`);
    console.log(`      Latency        : ${latency_ms}ms`);
    console.log(`      Answer         : "${answer_snippet}..."\n`);

    if (pass) passed++;
    else failed++;
  } catch (e) {
    const latency_ms = Date.now() - t0;
    results.push({ query: q.query, session_label: q.session_label, pass: false, matched: [], missing: q.required_keywords, has_agent_citation: false, answer_snippet: (e as Error).message, latency_ms });
    console.log(`  ✗ [${q.session_label}] ${q.description}: ${(e as Error).message}\n`);
    failed++;
  }
}

// ── Scorecard ─────────────────────────────────────────────────────────────────

const queryPassed = results.filter((r) => r.pass).length;
const queryTotal  = results.length;
const recallPct   = (queryPassed / queryTotal * 100).toFixed(0);
const latencies   = results.map((r) => r.latency_ms).sort((a, b) => a - b);
const p50         = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
const p95         = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
const TARGET      = 0.80;
const recallPass  = queryPassed / queryTotal >= TARGET;

console.log("── Scorecard ──\n");
console.log(`  Sessions seeded   : ${SESSIONS.length}`);
console.log(`  Agents involved   : ${[...new Set(SESSIONS.map((s) => s.agent_id))].join(", ")}`);
console.log(`  Simulated window  : 3 weeks`);
console.log(`  Queries run       : ${queryTotal}`);
console.log(`  Queries recalled  : ${queryPassed}/${queryTotal}`);
console.log(`  Recall rate       : ${recallPct}%  (target: ≥${TARGET * 100}%)`);
console.log(`  Latency p50/p95   : ${p50}ms / ${p95}ms`);
console.log();

if (recallPass) {
  console.log(`  ✓ PASS — ${recallPct}% cross-session recall (≥80% target met)`);
} else {
  console.log(`  ✗ FAIL — ${recallPct}% cross-session recall (below 80% target)`);
  console.log();
  console.log("  Failed queries:");
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`    [${r.session_label}] ${r.query.slice(0, 60)}`);
    console.log(`      matched=${r.matched.join(",") || "none"}  agent_citation=${r.has_agent_citation}`);
    console.log(`      answer: "${r.answer_snippet.slice(0, 120)}"`);
  }
}
console.log();

console.log("  Cleaning up eval data...");
cleanupEvalProjects([PROJECT]).then(() => {
  process.exit(recallPass ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
