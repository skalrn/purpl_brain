/**
 * Demo: Agent memory across sessions (the core value proof)
 *
 * Proves the pivot claim end-to-end:
 *   "A developer runs a Claude Code session that logs a decision, starts a NEW
 *    session with zero context, and the second session retrieves that decision
 *    with citation — without the developer doing anything between them."
 *
 * Flow:
 *   1. Session 1 (write):  POST /brain/agent-log with a realistic JWT-library
 *                          decision tied to project_id `demo_auth_service`.
 *   2. Pipeline wait:      Poll /brain/query every 3s (up to 10 retries) until
 *                          the answer references the logged decision.
 *   3. Session 2 (query):  Print the cited answer and the verdict.
 *
 * PASS criteria:
 *   - Final answer mentions `node-jsonwebtoken` or `jsonwebtoken`
 *   - Response has at least one citation
 *
 * Requires a live stack: API on :3001 + Redis + Neo4j + Qdrant + all three
 * pipeline workers (normalizer, extractor, brain-writer).
 *
 * Run from apps/api:
 *   BRAIN_API_KEY=... npm run demo:agent-memory
 */
import "dotenv/config";
import { randomUUID } from "crypto";

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const API_KEY = process.env.BRAIN_API_KEY ?? process.env.PURPL_API_KEY ?? "";

const PROJECT_ID = "demo_auth_service";
const SESSION_ID = `demo_sess_${randomUUID()}`;

const DECISION_PAYLOAD = {
  schema_version: "1.0",
  session_id: SESSION_ID,
  agent_id: "claude-code-demo",
  project_id: PROJECT_ID,
  task_id: "swap-jwt-library",
  codebase: "demo-auth-service",
  timestamp_start: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  timestamp_end: new Date().toISOString(),
  decisions: [
    {
      id: "d1",
      description:
        "Drop `jose` and standardize on `node-jsonwebtoken` (a.k.a. `jsonwebtoken`) for all JWT signing and verification in the auth service.",
      rationale:
        "`jose` v5 has a known JWE decryption bug that intermittently corrupts payloads when the audience claim contains an array. `node-jsonwebtoken` is battle-tested, widely audited, and our existing middleware already uses its verify() API. Migration cost is low.",
      alternatives_considered: ["jose (current)", "fast-jwt", "jws + manual claim validation"],
      confidence: "high" as const,
    },
  ],
  work_completed:
    "Replaced `jose` imports with `jsonwebtoken` across the auth middleware and token issuance routes. Updated tests.",
  files_modified: [
    "src/auth/middleware.ts",
    "src/auth/issue-token.ts",
    "src/auth/__tests__/middleware.test.ts",
  ],
  unresolved: [],
  next_steps: ["Bump `node-jsonwebtoken` to latest in package.json and lockfile"],
};

const QUERY = "What JWT library are we using and why?";

// ── Output helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  return headers;
}

interface Citation {
  source: string;
  source_url?: string;
  actor?: { name?: string };
  timestamp?: string;
}

interface QueryResponse {
  answer?: string;
  citations?: Citation[];
  latency_ms?: number;
  citation_warning?: boolean;
}

function mentionsJwtLib(answer: string): boolean {
  const lower = answer.toLowerCase();
  return lower.includes("node-jsonwebtoken") || lower.includes("jsonwebtoken");
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n──────────────────────────────────────────────────────────────");
  console.log("  Demo: Agent memory across sessions");
  console.log(`  project=${PROJECT_ID}  session=${SESSION_ID}`);
  console.log("──────────────────────────────────────────────────────────────\n");

  if (!API_KEY) {
    console.error(
      "  ERROR  BRAIN_API_KEY (or PURPL_API_KEY) is not set. The /brain/agent-log\n" +
      "         endpoint requires authentication — set it in apps/api/.env or export it.\n"
    );
    process.exit(1);
  }

  // ── Session 1: write decision via /brain/agent-log ──────────────────────────
  console.log("Session 1 — writing decision to brain via POST /brain/agent-log");
  console.log(`  decision: ${DECISION_PAYLOAD.decisions[0].description.slice(0, 80)}...`);

  let ingestRes: Response;
  try {
    ingestRes = await fetch(`${API_BASE}/brain/agent-log`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(DECISION_PAYLOAD),
    });
  } catch (e) {
    console.error(`\n  ERROR  Could not reach ${API_BASE}. Is the API running? (${(e as Error).message})\n`);
    process.exit(1);
  }

  const ingestBody = (await ingestRes.json().catch(() => ({}))) as Record<string, unknown>;
  check(
    "agent-log returns 200/202 ok",
    [200, 202].includes(ingestRes.status) && ingestBody.ok === true,
    `status=${ingestRes.status} body=${JSON.stringify(ingestBody).slice(0, 200)}`
  );

  if (![200, 202].includes(ingestRes.status)) {
    console.error("\n  Cannot continue without successful ingest. Aborting.\n");
    process.exit(1);
  }

  console.log(`  event_id: ${ingestBody.event_id}`);
  console.log(`  decisions_logged: ${ingestBody.decisions_logged}\n`);

  // ── Wait for the pipeline ───────────────────────────────────────────────────
  console.log("Waiting for pipeline (raw → normalized → extracted → brain store)...");
  console.log("  polling /brain/query every 3s, up to 10 retries (~30s max)\n");

  const MAX_RETRIES = 10;
  const POLL_INTERVAL_MS = 3000;

  let finalQuery: QueryResponse | undefined;
  let finalAttempt = 0;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await sleep(POLL_INTERVAL_MS);
    finalAttempt = attempt;

    let qRes: Response;
    try {
      qRes = await fetch(`${API_BASE}/brain/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-Key": API_KEY },
        body: JSON.stringify({ query: QUERY, project_id: PROJECT_ID }),
      });
    } catch (e) {
      console.log(`  attempt ${attempt}/${MAX_RETRIES}: network error (${(e as Error).message})`);
      continue;
    }

    if (qRes.status !== 200) {
      console.log(`  attempt ${attempt}/${MAX_RETRIES}: query status=${qRes.status}`);
      continue;
    }

    const qBody = (await qRes.json()) as QueryResponse;
    const answer = String(qBody.answer ?? "");
    const citationCount = (qBody.citations ?? []).length;
    const mentions = mentionsJwtLib(answer);

    console.log(
      `  attempt ${attempt}/${MAX_RETRIES}: answer_len=${answer.length} citations=${citationCount} mentions_lib=${mentions}`
    );

    finalQuery = qBody;
    if (mentions && citationCount > 0) {
      console.log(`\n  Pipeline ready after ~${attempt * (POLL_INTERVAL_MS / 1000)}s\n`);
      break;
    }
  }

  if (!finalQuery) {
    console.error(
      `\n  ERROR  Pipeline did not produce a queryable answer within ${MAX_RETRIES * POLL_INTERVAL_MS / 1000}s.\n` +
      "         Likely causes:\n" +
      "           • A pipeline worker is not running. Make sure all three are up:\n" +
      "               npm run worker:normalizer\n" +
      "               npm run worker:extractor\n" +
      "               npm run worker:brain-writer\n" +
      "           • Redis, Qdrant, or Neo4j is unreachable.\n" +
      "           • The extractor LLM (Ollama / Anthropic) is misconfigured.\n"
    );
    process.exit(1);
  }

  // ── Session 2: query (zero prior context) ───────────────────────────────────
  console.log("Session 2 — querying brain as a fresh agent (no shared state)");
  console.log(`  query: "${QUERY}"\n`);

  const answer = String(finalQuery.answer ?? "");
  const citations = finalQuery.citations ?? [];

  console.log("  ── Answer ──────────────────────────────────────────────────");
  for (const line of answer.split("\n")) {
    console.log(`    ${line}`);
  }
  console.log("  ────────────────────────────────────────────────────────────\n");

  if (citations.length > 0) {
    console.log("  Citations:");
    citations.forEach((c, i) => {
      const actor = c.actor?.name ?? "unknown";
      const ts = c.timestamp ? new Date(c.timestamp).toISOString() : "n/a";
      console.log(`    [${i + 1}] ${actor} via ${c.source} (${ts}) — ${c.source_url ?? ""}`);
    });
    console.log("");
  }

  // ── Verdict ─────────────────────────────────────────────────────────────────
  check("answer is non-empty", answer.length > 20, `answer_len=${answer.length}`);
  check(
    "answer mentions node-jsonwebtoken / jsonwebtoken",
    mentionsJwtLib(answer),
    `answer="${answer.slice(0, 120)}..."`
  );
  check(
    "response has at least one citation",
    citations.length > 0,
    `citation_count=${citations.length}`
  );
  const agentCitation = citations.find((c) => c.source === "agent");
  check(
    "at least one citation has source=agent",
    !!agentCitation,
    `citation sources=${citations.map((c) => c.source).join(",") || "(none)"}`
  );

  // ── Summary ─────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n──────────────────────────────────────────────────────────────`);
  console.log(`  Result: ${passed}/${total} checks passed`);
  console.log(`  Pipeline latency: ~${finalAttempt * (POLL_INTERVAL_MS / 1000)}s`);
  console.log("──────────────────────────────────────────────────────────────\n");

  if (failed > 0) {
    console.error("DEMO FAILED — the agent memory loop is not closing end-to-end.\n");
    process.exit(1);
  }

  console.log("DEMO PASSED ✓  Session 2 retrieved Session 1's decision with citation.");
  console.log("This is the core value proof of purpl-brain.\n");
}

main().catch((e) => {
  console.error("\nUNEXPECTED ERROR:", e);
  process.exit(1);
});
