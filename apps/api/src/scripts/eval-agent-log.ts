/**
 * Eval: Agent log round-trip (production pivot — core feature)
 *
 * Tests POST /brain/agent-log end-to-end:
 *  1. Valid payload returns 200 ok
 *  2. Response includes event_id and decisions_logged count
 *  3. Missing session_id returns 400
 *  4. Empty decisions array returns 400
 *  5. After pipeline (35s), query for the decision content returns non-empty answer
 *  6. At least one citation has source === "agent"
 *  7. Duplicate session_id returns 409
 *
 * Note: /brain/agent-log requires X-API-Key. If BRAIN_API_KEY is unset,
 * auth-dependent checks are skipped with a note.
 */
import "dotenv/config";

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const API_KEY = process.env.BRAIN_API_KEY ?? "";
const RUN_ID = Date.now();
const PROJECT_ID = `eval_agent_log_${RUN_ID}`;
const SESSION_ID = `sess_eval_${RUN_ID}`;

const PAYLOAD = {
  schema_version: "1.0",
  session_id: SESSION_ID,
  agent_id: "claude-sonnet-4-6",
  project_id: PROJECT_ID,
  task_id: "implement-redis-caching",
  codebase: "purpl-brain",
  timestamp_start: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  timestamp_end: new Date().toISOString(),
  decisions: [
    {
      id: "d1",
      description: "Use Redis with allkeys-lru eviction for query result caching",
      rationale:
        "Redis is already in the stack for Streams; adding Memcached would increase operational overhead without benefit",
      alternatives_considered: ["Memcached", "in-memory Map"],
      confidence: "high" as const,
    },
    {
      id: "d2",
      description: "Set cache TTL to 15 minutes for query results and 1 hour for embeddings",
      rationale:
        "Query results may become stale as new events are ingested; embeddings are deterministic so longer TTL is safe",
      alternatives_considered: ["5 minutes", "30 minutes"],
      confidence: "high" as const,
    },
  ],
  work_completed: "Implemented Redis query result cache with allkeys-lru eviction policy",
  files_modified: ["apps/api/src/services/query-engine.ts", "apps/api/src/lib/redis.ts"],
};

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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  return headers;
}

async function main() {
  console.log(`\nEval: Agent log round-trip  [project=${PROJECT_ID}]\n`);

  if (!API_KEY) {
    console.log("  NOTE  BRAIN_API_KEY not set — auth-protected ingest will return 401.");
    console.log("        Set BRAIN_API_KEY to run full round-trip.\n");
  }

  // ── Check 1+2: Valid agent-log returns 200 with event_id + decisions_logged ──
  const ingestRes = await fetch(`${API_BASE}/brain/agent-log`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(PAYLOAD),
  });
  const ingestBody = (await ingestRes.json()) as Record<string, unknown>;

  if (!API_KEY) {
    check("agent-log returns 401 without API key", ingestRes.status === 401,
      `status=${ingestRes.status}`);
  } else {
    check("agent-log returns 200 ok", ingestRes.status === 200 && ingestBody.ok === true,
      `status=${ingestRes.status} body=${JSON.stringify(ingestBody)}`);
    check("response includes event_id", typeof ingestBody.event_id === "string" &&
      (ingestBody.event_id as string).startsWith("agent_"),
      `event_id=${ingestBody.event_id}`);
    check("response includes decisions_logged count", ingestBody.decisions_logged === 2,
      `decisions_logged=${ingestBody.decisions_logged}`);
  }

  // ── Check 3: Missing session_id returns 400 ─────────────────────────────────
  if (API_KEY) {
    const noSessionRes = await fetch(`${API_BASE}/brain/agent-log`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ ...PAYLOAD, session_id: undefined, project_id: `${PROJECT_ID}_no_sess` }),
    });
    check("missing session_id returns 400", noSessionRes.status === 400,
      `status=${noSessionRes.status}`);
  } else {
    console.log("  SKIP  missing session_id 400 check (no API key)");
  }

  // ── Check 4: Empty decisions array returns 400 ──────────────────────────────
  if (API_KEY) {
    const emptyDecisionsRes = await fetch(`${API_BASE}/brain/agent-log`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        ...PAYLOAD,
        session_id: `${SESSION_ID}_empty`,
        project_id: `${PROJECT_ID}_empty`,
        decisions: [],
      }),
    });
    check("empty decisions array returns 400", emptyDecisionsRes.status === 400,
      `status=${emptyDecisionsRes.status}`);
  } else {
    console.log("  SKIP  empty decisions 400 check (no API key)");
  }

  // ── Wait for pipeline ───────────────────────────────────────────────────────
  if (API_KEY && ingestRes.status === 200) {
    console.log("\n  Waiting 35s for pipeline (Ollama LLM extraction)...\n");
    await sleep(35000);

    // ── Check 5: Query returns non-empty answer ───────────────────────────────
    const queryRes = await fetch(`${API_BASE}/brain/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "What caching eviction policy was chosen and why?",
        project_id: PROJECT_ID,
      }),
    });
    const queryBody = (await queryRes.json()) as Record<string, unknown>;
    const answer = String(queryBody.answer ?? "");
    const citations = (queryBody.citations as Array<Record<string, unknown>>) ?? [];

    check("query returns 200", queryRes.status === 200, `status=${queryRes.status}`);
    check("answer is non-empty", answer.length > 20, `answer=${answer.slice(0, 80)}`);

    // ── Check 6: At least one citation has source === "agent" ────────────────
    const agentCitation = citations.find((c) => c.source === "agent");
    check("at least one citation has source=agent", !!agentCitation,
      `citation sources=${citations.map((c) => c.source).join(",")}`);

    // ── Check 7: Duplicate session_id returns 409 ────────────────────────────
    const dupeRes = await fetch(`${API_BASE}/brain/agent-log`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(PAYLOAD),
    });
    check("duplicate session_id returns 409", dupeRes.status === 409,
      `status=${dupeRes.status}`);
  } else {
    console.log("\n  SKIP  pipeline round-trip checks (no API key or ingest failed)\n");
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Result: ${passed}/${total} passed`);
  if (failed > 0) {
    console.error(`EVAL FAILED — ${failed} check(s) failed`);
    process.exit(1);
  } else {
    console.log("EVAL PASSED ✓");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
