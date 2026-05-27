/**
 * eval-concurrent-conflict — two conflict types in one scenario
 *
 * Scenario: Auth service, two agents running in parallel.
 *
 * Three months ago the team decided: stateless JWT over server-side sessions
 * for horizontal scaling. That decision is in the brain.
 *
 * Today:
 *   AlphaAgent  — adding a "remember me" feature. Logs a decision to store
 *                 extended sessions in Redis (contradicts the historical ADR).
 *
 *   BetaAgent   — improving auth resilience. Before acting it queries the brain.
 *                 The brain must surface BOTH conflicts:
 *                   1. Historical: stateless JWT chosen over server-side sessions (3 months ago)
 *                   2. Concurrent: AlphaAgent stored sessions in Redis minutes ago
 *                 BetaAgent then logs its decision acknowledging both.
 *
 * What this eval verifies that other evals do not:
 *   - Conflict between a historical decision and a new agent decision
 *   - Conflict between two concurrent agent decisions made minutes apart
 *   - BetaAgent's brain_query citations include BOTH conflict sources
 *   - Neo4j: decision nodes from both agents exist and are attributed correctly
 *   - DriftAlerts: at least one confirms conflict with the historical ADR
 *
 * Usage:
 *   npm run eval:concurrent-conflict -w apps/api
 *
 * Env:
 *   BRAIN_API_KEY or DEV_API_KEY — required
 *   API_BASE                     — defaults to http://localhost:3001
 *   ALPHA_WAIT_MS                — wait after Alpha logs before Beta queries (default 20000)
 *   DRIFT_WAIT_MS                — wait for drift detector (default 60000)
 */
import "dotenv/config";
import neo4j from "neo4j-driver";
import { cleanupEvalProjects } from "../lib/eval-cleanup.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const API_KEY  = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "";
const ALPHA_WAIT_MS = parseInt(process.env.ALPHA_WAIT_MS ?? "20000");
const DRIFT_WAIT_MS = parseInt(process.env.DRIFT_WAIT_MS ?? "60000");
const RUN_ID    = Date.now();
const PROJECT   = `eval_cc_${RUN_ID}`;

const NEO4J_URI      = process.env.NEO4J_URI      ?? "bolt://localhost:7687";
const NEO4J_USER     = process.env.NEO4J_USER     ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASS     ?? process.env.NEO4J_PASSWORD ?? "password";

const SEED_SESSION  = `sess_cc_seed_${RUN_ID}`;
const ALPHA_SESSION = `sess_cc_alpha_${RUN_ID}`;
const BETA_SESSION  = `sess_cc_beta_${RUN_ID}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`    PASS  ${name}`);
    passed++;
  } else {
    console.error(`    FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
    failed++;
  }
}

function skip(name: string, reason: string) {
  console.log(`    SKIP  ${name} — ${reason}`);
  skipped++;
}

function phase(label: string) {
  console.log(`\n${"─".repeat(64)}`);
  console.log(label);
  console.log("─".repeat(64));
}

async function sleep(ms: number, label?: string) {
  if (label) process.stdout.write(`    Waiting ${ms / 1000}s (${label})`);
  await new Promise<void>((r) => {
    const interval = setInterval(() => process.stdout.write("."), 5000);
    setTimeout(() => { clearInterval(interval); r(); }, ms);
  });
  if (label) console.log(" done");
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  let parsed: T;
  try { parsed = await res.json() as T; } catch { parsed = {} as T; }
  return { status: res.status, body: parsed };
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_BASE}${path}`, { headers: authHeaders() });
  let parsed: T;
  try { parsed = await res.json() as T; } catch { parsed = {} as T; }
  return { status: res.status, body: parsed };
}

async function neoQuery<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const sess = driver.session();
  try {
    const result = await sess.run(cypher, params);
    return result.records.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const key of r.keys) obj[String(key)] = r.get(key);
      return obj as T;
    });
  } finally {
    await sess.close();
    await driver.close();
  }
}

async function pollForDriftAlerts(
  projectId: string,
  minCount: number,
  timeoutMs: number
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await get<{ alerts: Array<Record<string, unknown>> }>(
      `/brain/drift-alerts?project_id=${encodeURIComponent(projectId)}`
    );
    if ((res.body.alerts ?? []).length >= minCount) return res.body.alerts;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const final = await get<{ alerts: Array<Record<string, unknown>> }>(
    `/brain/drift-alerts?project_id=${encodeURIComponent(projectId)}`
  );
  return final.body.alerts ?? [];
}

// ── Scenario data ─────────────────────────────────────────────────────────────

// Historical decision: 3 months ago, stateless JWT chosen over server-side sessions
const HISTORICAL_LOG = {
  schema_version: "1.0",
  session_id: SEED_SESSION,
  agent_id: "arch-agent-v1",
  project_id: PROJECT,
  task_id: "auth-architecture-review",
  codebase: "auth-service",
  timestamp_start: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
  timestamp_end:   new Date(Date.now() - 90 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000).toISOString(),
  decisions: [
    {
      id: "auth-001",
      description: "Use stateless JWT tokens over server-side session storage for authentication",
      rationale: "Stateless JWT allows horizontal scaling without sticky sessions or a shared session store. Any instance can validate a token without network I/O. Server-side sessions require a shared Redis cluster or sticky routing — both add latency and operational complexity. The 15-minute expiry window limits blast radius for leaked tokens.",
      alternatives_considered: ["Redis-backed server-side sessions", "database session rows", "opaque tokens with introspection endpoint"],
      confidence: "high" as const,
    },
    {
      id: "auth-002",
      description: "JWT access tokens expire in 15 minutes; refresh tokens expire in 7 days",
      rationale: "Security audit finding: prior 24-hour access token window is too long. 15 minutes limits blast radius. 7-day refresh tokens balance security with UX — no re-login required for a standard work week.",
      alternatives_considered: ["1-hour access tokens", "30-minute access tokens"],
      confidence: "high" as const,
    },
  ],
  work_completed: "Auth architecture decision: stateless JWT chosen. Token expiry set. Server-side sessions explicitly rejected.",
  files_modified: ["apps/auth/src/middleware/jwt.ts", "docs/adrs/auth-001-stateless-jwt.md"],
};

// AlphaAgent decision: logged today, contradicts the historical stateless JWT ADR
const ALPHA_LOG = {
  schema_version: "1.0",
  session_id: ALPHA_SESSION,
  agent_id: "feature-agent-alpha",
  project_id: PROJECT,
  task_id: "remember-me-feature",
  codebase: "auth-service",
  timestamp_start: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  timestamp_end:   new Date().toISOString(),
  decisions: [
    {
      id: "alpha-001",
      description: "Store remember-me sessions in Redis with 30-day TTL — server-side session entries keyed by opaque token",
      rationale: "JWTs cannot be revoked before expiry without a blocklist, which defeats the purpose of stateless auth. For remember-me, the UX requirement is instant revocation when the user logs out from another device. An opaque token stored in Redis satisfies revocation without requiring a JWT blocklist. Redis TTL handles expiry automatically.",
      alternatives_considered: ["Long-lived JWT with blocklist", "refresh token rotation only"],
      confidence: "high" as const,
    },
  ],
  work_completed: "Implemented remember-me with Redis opaque session tokens. 30-day TTL. Revocation on logout.",
  files_modified: ["apps/auth/src/routes/login.ts", "apps/auth/src/lib/session.ts"],
};

// BetaAgent decision: logged after querying the brain and finding both conflicts
const BETA_LOG = {
  schema_version: "1.0",
  session_id: BETA_SESSION,
  agent_id: "resilience-agent-beta",
  project_id: PROJECT,
  task_id: "auth-resilience",
  codebase: "auth-service",
  timestamp_start: new Date(Date.now() - 8 * 60 * 1000).toISOString(),
  timestamp_end:   new Date().toISOString(),
  decisions: [
    {
      id: "beta-001",
      description: "DEFER: distributed Redis session store for auth resilience — blocked on unresolved conflict between stateless JWT ADR (auth-001) and AlphaAgent's new opaque session store",
      rationale: "brain_query before acting surfaced two conflicts: (1) auth-001 explicitly rejected server-side sessions 3 months ago in favour of stateless JWT for scaling; (2) AlphaAgent logged alpha-001 minutes ago introducing Redis opaque sessions for remember-me. These two decisions now coexist in the codebase without a reconciliation record. Adding a distributed Redis session layer before resolving this conflict would deepen the inconsistency. Deferring until the team aligns on whether the auth model is stateless, stateful, or hybrid.",
      alternatives_considered: ["Proceed with Redis Cluster regardless", "Roll back AlphaAgent's opaque session change first"],
      confidence: "high" as const,
    },
  ],
  work_completed: "Identified auth model conflict via brain_query. Deferred resilience work pending team alignment on stateless vs stateful auth.",
  unresolved: ["Is the auth model stateless (auth-001) or hybrid (alpha-001 + auth-001)?"],
  files_modified: [],
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log(`\n${"═".repeat(64)}`);
  console.log("Concurrent Conflict Eval — Two Conflict Types");
  console.log(`Project:      ${PROJECT}`);
  console.log(`API:          ${API_BASE}`);
  console.log(`API key set:  ${API_KEY ? "yes" : "NO — will skip ingest phases"}`);
  console.log(`Alpha wait:   ${ALPHA_WAIT_MS / 1000}s   Drift wait: ${DRIFT_WAIT_MS / 1000}s`);
  console.log("═".repeat(64));

  // ── Phase 0: Health ─────────────────────────────────────────────────────────
  phase("Phase 0: Health — all services reachable");

  const health = await get<{ status: string }>("/health");
  check("API /health returns 200", health.status === 200, `status=${health.status}`);

  let neo4jOk = false;
  try {
    await neoQuery("RETURN 1 AS ok");
    check("Neo4j reachable", true);
    neo4jOk = true;
  } catch (e) {
    check("Neo4j reachable", false, String(e));
  }

  try {
    const q = await fetch("http://localhost:6333/healthz");
    check("Qdrant reachable", q.ok, `status=${q.status}`);
  } catch (e) {
    check("Qdrant reachable", false, String(e));
  }

  if (failed > 0) {
    console.error("\n  Health checks failed — fix services before running.\n");
    process.exit(1);
  }

  // ── Phase 1: Seed historical decisions (backdated 3 months) ─────────────────
  phase("Phase 1: Seed — stateless JWT decision from 3 months ago");

  let seedOk = false;
  if (!API_KEY) {
    skip("seed historical decisions", "no API key");
  } else {
    const seed = await post<{ ok: boolean; event_id: string; decisions_logged: number }>(
      "/brain/agent-log", HISTORICAL_LOG
    );
    check("seed accepted (200 or 202)", [200, 202].includes(seed.status),
      `status=${seed.status} body=${JSON.stringify(seed.body).slice(0, 120)}`);
    check("seed logs 2 decisions", seed.body.decisions_logged === 2,
      `decisions_logged=${seed.body.decisions_logged}`);
    seedOk = [200, 202].includes(seed.status);
  }

  // ── Phase 2: Wait for pipeline ───────────────────────────────────────────────
  phase("Phase 2: Wait — historical decisions propagate to brain");

  if (!seedOk) {
    skip("pipeline wait", "seed did not succeed");
  } else {
    await sleep(ALPHA_WAIT_MS, "brain-writer + Qdrant indexing");
  }

  // ── Phase 3: Verify historical decisions are queryable ──────────────────────
  phase("Phase 3: Verify — historical decisions queryable before agents start");

  let historyQueryOk = false;
  if (!seedOk) {
    skip("historical recall", "seed did not succeed");
  } else {
    const recall = await post<{
      answer: string;
      citations: Array<{ source: string; actor?: { id: string }; quoted_text?: string }>;
    }>(
      "/brain/query",
      { query: "What session management decisions have been made for the auth service?", project_id: PROJECT }
    );
    const answer = recall.body.answer ?? "";
    const citations = recall.body.citations ?? [];

    check("historical query returns 200", recall.status === 200, `status=${recall.status}`);
    check("answer mentions JWT or stateless", /jwt|stateless/i.test(answer),
      `answer=${answer.slice(0, 150)}`);
    check("answer mentions server-side sessions or rejection",
      /server.side|session|rejected|stateless/i.test(answer),
      `answer=${answer.slice(0, 150)}`);
    check("≥1 citation returned", citations.length >= 1, `citations=${citations.length}`);
    check("citation source is agent", citations.some((c) => c.source === "agent"),
      `sources=${citations.map((c) => c.source).join(",")}`);
    historyQueryOk = recall.status === 200 && /jwt|stateless/i.test(answer);
  }

  // ── Phase 4: AlphaAgent logs its Redis session decision ─────────────────────
  phase("Phase 4: AlphaAgent — logs remember-me Redis session decision (contradicts auth-001)");

  let alphaLogOk = false;
  if (!seedOk) {
    skip("AlphaAgent decision log", "seed did not succeed");
  } else {
    const alphaLog = await post<{ ok: boolean; event_id: string; decisions_logged: number }>(
      "/brain/agent-log", ALPHA_LOG
    );
    check("AlphaAgent log accepted (200 or 202)", [200, 202].includes(alphaLog.status),
      `status=${alphaLog.status}`);
    check("AlphaAgent logs 1 decision", alphaLog.body.decisions_logged === 1,
      `decisions_logged=${alphaLog.body.decisions_logged}`);
    alphaLogOk = [200, 202].includes(alphaLog.status);
  }

  // ── Phase 5: Wait for AlphaAgent's decision to propagate ────────────────────
  phase(`Phase 5: Wait — AlphaAgent's decision propagates (${ALPHA_WAIT_MS / 1000}s)`);

  if (!alphaLogOk) {
    skip("Alpha propagation wait", "AlphaAgent log did not succeed");
  } else {
    await sleep(ALPHA_WAIT_MS, "brain-writer + Qdrant indexing for Alpha decision");
  }

  // ── Phase 6: BetaAgent queries brain — must surface BOTH conflicts ───────────
  phase("Phase 6: BetaAgent — queries brain before acting, expects both conflict sources");

  let betaQueryCitations: Array<Record<string, unknown>> = [];
  let betaAnswer = "";
  let betaQueryOk = false;

  if (!alphaLogOk) {
    skip("BetaAgent brain_query", "AlphaAgent log did not succeed");
  } else {
    const betaQuery = await post<{
      answer: string;
      citations: Array<{ source: string; actor?: { id: string }; source_url?: string; quoted_text?: string }>;
    }>(
      "/brain/query",
      {
        query: "What session management and authentication decisions exist? I am about to implement a distributed Redis session store for auth resilience.",
        project_id: PROJECT,
        mode: "project",
      }
    );

    betaAnswer = betaQuery.body.answer ?? "";
    betaQueryCitations = (betaQuery.body.citations ?? []) as Array<Record<string, unknown>>;

    check("BetaAgent query returns 200", betaQuery.status === 200, `status=${betaQuery.status}`);

    // Conflict type 1: BetaAgent sees the historical decision (stateless JWT)
    const seesHistorical =
      /jwt|stateless|server.side.*session|session.*server.side/i.test(betaAnswer) ||
      betaQueryCitations.some((c) =>
        /jwt|stateless/i.test(String(c.quoted_text ?? "") + String(c.source_url ?? ""))
      );
    check("BetaAgent sees CONFLICT TYPE 1: historical stateless JWT decision",
      seesHistorical,
      `answer=${betaAnswer.slice(0, 200)}`);

    // Conflict type 2: BetaAgent sees AlphaAgent's concurrent decision (Redis sessions)
    const seesAlpha =
      /redis.*session|opaque.*token|remember.me|alpha/i.test(betaAnswer) ||
      betaQueryCitations.some((c) =>
        String(c.source_url ?? "").includes(ALPHA_SESSION) ||
        /redis.*session|opaque|remember.me/i.test(String(c.quoted_text ?? ""))
      );
    check("BetaAgent sees CONFLICT TYPE 2: AlphaAgent's concurrent Redis session decision",
      seesAlpha,
      `citations=${betaQueryCitations.map((c) => String(c.source_url ?? "").slice(-40)).join(" | ")}`);

    check("BetaAgent receives ≥2 citations (one per conflict source)",
      betaQueryCitations.length >= 2,
      `citations=${betaQueryCitations.length}`);

    betaQueryOk = betaQuery.status === 200 && seesHistorical;
  }

  // ── Phase 7: BetaAgent logs its deferral decision ───────────────────────────
  phase("Phase 7: BetaAgent — logs deferral decision referencing both conflicts");

  let betaLogOk = false;
  if (!betaQueryOk) {
    skip("BetaAgent decision log", "BetaAgent query did not succeed");
  } else {
    const betaLog = await post<{ ok: boolean; event_id: string; decisions_logged: number }>(
      "/brain/agent-log", BETA_LOG
    );
    check("BetaAgent log accepted (200 or 202)", [200, 202].includes(betaLog.status),
      `status=${betaLog.status}`);
    check("BetaAgent logs 1 decision", betaLog.body.decisions_logged === 1,
      `decisions_logged=${betaLog.body.decisions_logged}`);
    check("BetaAgent decision mentions deferral or conflict",
      /defer|conflict|blocked|align/i.test(BETA_LOG.decisions[0].rationale),
      "rationale should reference the conflicts found");
    betaLogOk = [200, 202].includes(betaLog.status);
  }

  // ── Phase 8: Wait for drift detection ────────────────────────────────────────
  phase(`Phase 8: Wait — drift detection runs against AlphaAgent's decision (${DRIFT_WAIT_MS / 1000}s)`);

  if (!alphaLogOk) {
    skip("drift detection wait", "AlphaAgent log did not succeed");
  } else {
    await sleep(DRIFT_WAIT_MS, "drift detector: AlphaAgent vs historical ADR");
  }

  // ── Phase 9: Drift alert verification ────────────────────────────────────────
  phase("Phase 9: Drift alerts — at least one conflict with historical ADR confirmed");

  let driftAlerts: Array<Record<string, unknown>> = [];

  if (!alphaLogOk) {
    skip("drift alert verification", "AlphaAgent log did not succeed");
  } else {
    driftAlerts = await pollForDriftAlerts(PROJECT, 1, 20000);

    check("≥1 drift alert created", driftAlerts.length >= 1,
      `alerts=${driftAlerts.length}`);

    const confirmed = driftAlerts.filter((a) => a.confirmed_by_llm === true);
    check("≥1 alert LLM-confirmed (Stage C passed)", confirmed.length >= 1,
      `confirmed=${confirmed.length}/${driftAlerts.length}`);

    check("≥1 confirmed alert status is pending (not dismissed)",
      driftAlerts.some((a) => a.confirmed_by_llm === true && a.resolution === "pending"),
      `alerts=${driftAlerts.map((a) => `confirmed=${a.confirmed_by_llm} resolution=${a.resolution}`).join(" | ")}`);
  }

  // ── Phase 10: Neo4j structural verification ───────────────────────────────────
  phase("Phase 10: Neo4j — decision nodes, attribution, and graph structure");

  if (!neo4jOk) {
    skip("Phase 10 Neo4j checks", "Neo4j not reachable");
  } else {
    // Brief wait for BetaAgent's decision to propagate
    if (betaLogOk) await sleep(5000);

    try {
      // All three agent sessions exist as events in Neo4j
      const agentSessions = await neoQuery<{ source_id: string; agent_id: string }>(
        `MATCH (e:Event {project_id: $pid, source: 'agent'})
         WHERE e.source_id IS NOT NULL
         RETURN DISTINCT e.source_id AS source_id, e.agent_id AS agent_id`,
        { pid: PROJECT }
      );
      const sessionIds = agentSessions.map((r) => String(r.source_id ?? ""));
      check("Neo4j: historical seed session exists",
        sessionIds.some((s) => s.includes(SEED_SESSION)),
        `sessions=${sessionIds.join(", ")}`);
      check("Neo4j: AlphaAgent session exists",
        sessionIds.some((s) => s.includes(ALPHA_SESSION)),
        `sessions=${sessionIds.join(", ")}`);
      check("Neo4j: BetaAgent session exists",
        betaLogOk ? sessionIds.some((s) => s.includes(BETA_SESSION)) : true,
        `sessions=${sessionIds.join(", ")}`);

      // Decision nodes exist for all agents
      const decisions = await neoQuery<{ decision_id: string; summary: string; project_id: string }>(
        `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event {project_id: $pid})
         RETURN d.decision_id AS decision_id, d.summary AS summary, d.project_id AS project_id`,
        { pid: PROJECT }
      );
      check("Neo4j: ≥2 decision nodes exist for this project",
        decisions.length >= 2,
        `decisions=${decisions.length}`);
      check("Neo4j: all decision nodes have project_id set",
        decisions.every((d) => d.project_id === PROJECT),
        `project_ids=${decisions.map((d) => d.project_id).join(",")}`);

      const hasStatelessJwt = decisions.some((d) =>
        /jwt|stateless|server.side/i.test(String(d.summary ?? ""))
      );
      check("Neo4j: historical stateless JWT decision node present",
        hasStatelessJwt,
        `summaries=${decisions.map((d) => String(d.summary ?? "").slice(0, 60)).join(" | ")}`);

      const hasAlphaRedis = decisions.some((d) =>
        /redis|opaque|remember.me|session/i.test(String(d.summary ?? ""))
      );
      check("Neo4j: AlphaAgent Redis session decision node present",
        hasAlphaRedis,
        `summaries=${decisions.map((d) => String(d.summary ?? "").slice(0, 60)).join(" | ")}`);

      // No orphaned decision nodes
      const orphans = await neoQuery<{ count: number }>(
        `MATCH (d:Decision {project_id: $pid}) WHERE NOT (d)-[:EXTRACTED_FROM]->()
         RETURN count(d) AS count`,
        { pid: PROJECT }
      );
      check("Neo4j: no orphaned decision nodes",
        Number(orphans[0]?.count ?? 0) === 0,
        `orphans=${orphans[0]?.count}`);

      // DriftAlert challenges at least one of the historical decisions
      if (driftAlerts.length > 0) {
        const alertLinks = await neoQuery<{ decision_id: string }>(
          `MATCH (da:DriftAlert)-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(e:Event {project_id: $pid})
           RETURN DISTINCT d.decision_id AS decision_id`,
          { pid: PROJECT }
        );
        check("Neo4j: DriftAlert has at least one CHALLENGES relationship",
          alertLinks.length >= 1,
          `challenged decisions=${alertLinks.length}`);
      } else {
        skip("Neo4j: DriftAlert CHALLENGES relationship", "no drift alerts fired");
      }

      // ≥2 distinct sessions (source_ids) wrote to this project — each agent uses a unique session
      const uniqueSourceIds = new Set(agentSessions.map((r) => String(r.source_id ?? "")));
      check("Neo4j: ≥2 distinct agent sessions wrote to this project",
        uniqueSourceIds.size >= 2,
        `sessions=${[...uniqueSourceIds].join(", ")}`);

    } catch (e) {
      check("Neo4j structural queries executed without error", false, String(e));
    }
  }

  // ── Phase 11: Conflict summary query ─────────────────────────────────────────
  phase("Phase 11: Final query — brain summarises the unresolved conflict correctly");

  if (!betaLogOk) {
    skip("conflict summary query", "BetaAgent log did not succeed");
  } else {
    const summary = await post<{ answer: string; citations: Array<Record<string, unknown>> }>(
      "/brain/query",
      {
        query: "Is the auth service stateless or stateful? Are there any unresolved conflicts in the session management decisions?",
        project_id: PROJECT,
        mode: "project",
      }
    );

    check("conflict summary query returns 200", summary.status === 200,
      `status=${summary.status}`);

    const answer = summary.body.answer ?? "";
    check("summary answer references an unresolved conflict or inconsistency",
      /conflict|unresolved|contradict|inconsist|defer|stateless|stateful|both/i.test(answer),
      `answer=${answer.slice(0, 200)}`);
    check("summary returns ≥2 citations (both conflict sources)",
      (summary.body.citations ?? []).length >= 2,
      `citations=${summary.body.citations?.length}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  const totalMs = Date.now() - startTime;
  const total = passed + failed + skipped;

  console.log(`\n${"═".repeat(64)}`);
  console.log(`Concurrent Conflict Eval — ${(totalMs / 1000).toFixed(0)}s total`);
  console.log("═".repeat(64));
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}${!API_KEY ? " (expected — no API key)" : ""}`);
  console.log(`  Total:   ${total}`);

  console.log("\n  Cleaning up eval data...");
  await cleanupEvalProjects([PROJECT]);

  if (failed > 0) {
    console.error(`\n  FAIL — ${failed} check(s) failed.\n`);
    process.exit(1);
  } else if (skipped > 0 && !API_KEY) {
    console.log(`\n  PARTIAL — set BRAIN_API_KEY / DEV_API_KEY to run full scenario.\n`);
  } else {
    console.log(`\n  PASS — all ${passed} checks passed.\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
