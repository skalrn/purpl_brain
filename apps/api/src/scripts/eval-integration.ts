/**
 * Integration eval — full demo loop confidence check
 *
 * Runs the complete agent memory loop end-to-end against a fresh throwaway
 * project. Designed to be run immediately before a demo to verify every
 * moving part works: ingestion, pipeline, query, agent write-back, drift
 * detection, deduplication, citation quality, and graph integrity.
 *
 * Phases:
 *  0  Health — all services reachable (Neo4j, Qdrant, Redis, API)
 *  1  Seed   — agent session 1 logs decision (Qdrant for vectors)
 *  2  Seed   — supporting architecture doc
 *  3  Seed   — agent session 2 logs contradicting decision (Pinecone instead)
 *  4  Wait   — pipeline propagation (extractor + brain-writer + drift-detector)
 *  5  Loop   — session 2 query recalls session 1 decision without being told
 *  6  Cite   — answer is grounded across agent log + document (multi-source)
 *  7  Drift  — contradiction alert fired and confirmed by LLM
 *  8  Dedup  — same contradicting content ingested again → no new alert
 *  9  Scope  — query for other project returns no results (isolation)
 *  10 Graph  — white-box Neo4j integrity assertions
 *
 * Run: npm run eval:integration
 * Env: BRAIN_API_KEY required for ingest endpoints (set in .env as DEV_API_KEY)
 *      API_BASE overrides http://localhost:3001
 *      PIPELINE_WAIT_MS overrides default wait between phases (default 90000)
 */
import "dotenv/config";
import neo4j from "neo4j-driver";

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const API_KEY = process.env.BRAIN_API_KEY ?? process.env.DEV_API_KEY ?? "";
const PIPELINE_WAIT_MS = parseInt(process.env.PIPELINE_WAIT_MS ?? "90000");
const RUN_ID = Date.now();
const PROJECT_ID = `eval_integration_${RUN_ID}`;
const DECOY_PROJECT = `eval_decoy_${RUN_ID}`;

// Real tech terms with meaningful embeddings — fictional names score below the
// drift detector's cosine similarity threshold (0.55) in nomic-embed-text.
const DECISION_TERM = "Qdrant";
const CONTRADICT_TERM = "Weaviate";

const SESSION_1_ID = `sess_int_s1_${RUN_ID}`;
const SESSION_2_ID = `sess_int_s2_${RUN_ID}`;

const NEO4J_URI = process.env.NEO4J_URI ?? "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER ?? "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASS ?? process.env.NEO4J_PASSWORD ?? "password";

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const timings: Record<string, number> = {};

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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function auth(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

async function post<T>(path: string, body: unknown, useAuth = false): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: useAuth ? auth() : { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let parsed: T;
  try { parsed = await res.json() as T; } catch { parsed = {} as T; }
  return { status: res.status, body: parsed };
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API_BASE}${path}`);
  let parsed: T;
  try { parsed = await res.json() as T; } catch { parsed = {} as T; }
  return { status: res.status, body: parsed };
}

async function neoQuery<T>(cypher: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  const session = driver.session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((r) => {
      const obj: Record<string, unknown> = {};
      for (const key of r.keys) obj[String(key)] = r.get(key);
      return obj as T;
    });
  } finally {
    await session.close();
    await driver.close();
  }
}

function phase(n: number, label: string) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase ${n}: ${label}`);
  console.log(`${"─".repeat(60)}`);
  timings[label] = Date.now();
}

function looksLikeNoInfo(answer: string, citations: unknown[]): boolean {
  if ((citations ?? []).length === 0) return true;
  const a = answer.toLowerCase();
  return ["don't have", "do not have", "no information", "no relevant",
    "cannot find", "couldn't find", "unable to find", "no mention",
    "not mentioned", "not enough"].some((p) => a.includes(p));
}

// ── Data ──────────────────────────────────────────────────────────────────────

const AGENT_LOG_S1 = {
  schema_version: "1.0",
  session_id: SESSION_1_ID,
  agent_id: "claude-code-integration-eval",
  project_id: PROJECT_ID,
  task_id: "vector-store-selection",
  codebase: "purpl-brain",
  timestamp_start: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  timestamp_end: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  decisions: [
    {
      id: "vs-001",
      description: `Use ${DECISION_TERM} as the vector store for semantic retrieval`,
      rationale: `${DECISION_TERM} provides native payload filtering and named vectors, letting us scope semantic searches by project_id on a single collection without a separate index per tenant. Weaviate's schema management and Pinecone's namespace-per-project model both add operational overhead we want to avoid.`,
      alternatives_considered: ["Pinecone", "Weaviate", "pgvector"],
      confidence: "high" as const,
    },
  ],
  work_completed: `Evaluated vector stores. Selected ${DECISION_TERM}. Pinecone rejected due to namespace overhead.`,
  files_modified: ["apps/api/src/lib/qdrant.ts"],
};

const SUPPORTING_DOC = `# Architecture Decision: Vector Store Selection

## Context

The brain store requires semantic search scoped to a project_id without maintaining
a separate index per project. Evaluated ${DECISION_TERM}, Pinecone, Weaviate, and pgvector.

## Decision

Use ${DECISION_TERM}. Its payload filter support allows project-scoped queries on a single
collection. This avoids the Pinecone namespace model, which would require one namespace
per project and complicate cross-project queries in future.

## Alternatives rejected

- **Pinecone**: namespace-per-project model adds operational overhead. Rejected.
- **Weaviate**: more complex schema management. Rejected.
- **pgvector**: adequate for small scale but lacks the filtering expressiveness needed.
`;

const AGENT_LOG_S2 = {
  schema_version: "1.0",
  session_id: SESSION_2_ID,
  agent_id: "claude-code-integration-eval",
  project_id: PROJECT_ID,
  task_id: "vector-store-migration",
  codebase: "purpl-brain",
  timestamp_start: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
  timestamp_end: new Date().toISOString(),
  decisions: [
    {
      id: "vs-002",
      description: `Switch from ${DECISION_TERM} to ${CONTRADICT_TERM} for vector storage`,
      rationale: `${CONTRADICT_TERM} offers a managed cloud tier with a GraphQL API and built-in hybrid search. The ${DECISION_TERM} vector store requires self-hosting and lacks a native hybrid search interface. Switching to ${CONTRADICT_TERM} reduces operational burden and removes the need to maintain our own Qdrant cluster.`,
      alternatives_considered: [DECISION_TERM, "Pinecone"],
      confidence: "medium" as const,
    },
  ],
  work_completed: `Proposed migration from ${DECISION_TERM} to ${CONTRADICT_TERM}. Needs team review — contradicts prior decision to use ${DECISION_TERM}.`,
  files_modified: [],
};

const DECOY_DOC = `# Decoy project document

This content belongs to a separate project and must never appear in
integration eval project queries. If it does, project isolation is broken.

Unique marker: DECOY_ISOLATION_CANARY_${RUN_ID}
`;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const startTime = Date.now();
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Integration Eval — full demo loop`);
  console.log(`Project: ${PROJECT_ID}`);
  console.log(`API:     ${API_BASE}`);
  console.log(`Key set: ${API_KEY ? "yes" : "NO — ingest phases will be skipped"}`);
  console.log(`Pipeline wait: ${PIPELINE_WAIT_MS / 1000}s`);
  console.log(`${"═".repeat(60)}`);

  // ── Phase 0: Health ─────────────────────────────────────────────────────────
  phase(0, "Health — all services reachable");

  const health = await get<{ status: string }>("/health");
  check("API /health returns 200", health.status === 200, `status=${health.status}`);

  try {
    await neoQuery("RETURN 1 AS ok");
    check("Neo4j is reachable", true);
  } catch (e) {
    check("Neo4j is reachable", false, String(e));
  }

  try {
    const qdrantRes = await fetch("http://localhost:6333/healthz");
    check("Qdrant is reachable", qdrantRes.ok, `status=${qdrantRes.status}`);
  } catch (e) {
    check("Qdrant is reachable", false, String(e));
  }

  try {
    const redisRes = await fetch(`${API_BASE}/health`);
    check("Redis accessible via API health", redisRes.ok);
  } catch (e) {
    check("Redis accessible via API health", false, String(e));
  }

  if (failed > 0) {
    console.error("\n  Health checks failed — aborting. Fix services before running demo.\n");
    process.exit(1);
  }

  if (!API_KEY) {
    console.log("\n  WARN  BRAIN_API_KEY / DEV_API_KEY not set.");
    console.log("        Ingest phases will be skipped. Set the key to run the full loop.\n");
  }

  // ── Phase 1: Seed agent session 1 ──────────────────────────────────────────
  phase(1, "Seed — agent session 1 (vector store decision)");

  let session1Ok = false;
  if (!API_KEY) {
    skip("agent session 1 ingest", "no API key");
  } else {
    const s1 = await post<{ ok: boolean; event_id: string; decisions_logged: number }>(
      "/brain/agent-log", AGENT_LOG_S1, true
    );
    check("session 1 returns 200", s1.status === 200, `status=${s1.status} body=${JSON.stringify(s1.body)}`);
    check("session 1 event_id has agent_ prefix",
      typeof s1.body.event_id === "string" && s1.body.event_id.startsWith("agent_"),
      `event_id=${s1.body.event_id}`);
    check("session 1 logs 1 decision", s1.body.decisions_logged === 1,
      `decisions_logged=${s1.body.decisions_logged}`);
    session1Ok = s1.status === 200;
  }

  // ── Phase 2: Seed supporting document ──────────────────────────────────────
  phase(2, "Seed — supporting architecture document");

  let docOk = false;
  if (!API_KEY) {
    skip("document ingest", "no API key");
  } else {
    const doc = await post<{ ok: boolean }>(
      "/brain/ingest/document",
      {
        text: SUPPORTING_DOC,
        title: "Architecture Decision: Vector Store Selection",
        path: "docs/adr/vector-store.md",
        project_id: PROJECT_ID,
        source_url: `brain://eval/integration/adr/${RUN_ID}`,
      },
      true
    );
    check("document ingest returns 200", doc.status === 200, `status=${doc.status}`);
    docOk = doc.status === 200;
  }

  // ── Phase 2b: Seed decoy project (isolation test) ───────────────────────────
  if (API_KEY) {
    const decoy = await post<{ ok: boolean }>(
      "/brain/ingest/document",
      {
        text: DECOY_DOC,
        title: "Decoy project document",
        path: "docs/decoy.md",
        project_id: DECOY_PROJECT,
        source_url: `brain://eval/integration/decoy/${RUN_ID}`,
      },
      true
    );
    check("decoy project document ingest returns 200", decoy.status === 200, `status=${decoy.status}`);
  }

  // ── Phase 3: Seed agent session 2 (contradiction) ──────────────────────────
  phase(3, "Seed — agent session 2 (contradicting decision)");

  let session2Ok = false;
  if (!API_KEY) {
    skip("agent session 2 ingest", "no API key");
  } else {
    const s2 = await post<{ ok: boolean; event_id: string; decisions_logged: number }>(
      "/brain/agent-log", AGENT_LOG_S2, true
    );
    check("session 2 returns 200", s2.status === 200, `status=${s2.status}`);
    check("session 2 logs 1 decision", s2.body.decisions_logged === 1,
      `decisions_logged=${s2.body.decisions_logged}`);
    session2Ok = s2.status === 200;

    // Duplicate session_id must be rejected
    const dupe = await post<{ error: string }>("/brain/agent-log", AGENT_LOG_S2, true);
    check("duplicate session_id returns 409", dupe.status === 409, `status=${dupe.status}`);
  }

  // ── Phase 4: Wait for pipeline ──────────────────────────────────────────────
  phase(4, `Wait — pipeline propagation (${PIPELINE_WAIT_MS / 1000}s)`);

  if (!API_KEY || (!session1Ok && !docOk && !session2Ok)) {
    skip("pipeline wait", "no ingest succeeded");
  } else {
    const waitStart = Date.now();
    process.stdout.write(`    Waiting ${PIPELINE_WAIT_MS / 1000}s`);
    for (let i = 0; i < PIPELINE_WAIT_MS / 5000; i++) {
      await sleep(5000);
      process.stdout.write(".");
    }
    console.log(` done (${((Date.now() - waitStart) / 1000).toFixed(0)}s)`);
  }

  // ── Phase 5: Agent memory loop ──────────────────────────────────────────────
  phase(5, "Loop — session 2 recalls session 1 decision");

  if (!session1Ok) {
    skip("recall query", "session 1 ingest did not succeed");
  } else {
    const t0 = Date.now();
    const recall = await post<{ answer: string; citations: Array<Record<string, unknown>>; latency_ms: number }>(
      "/brain/query",
      { query: `What vector store was chosen and why was Pinecone rejected?`, project_id: PROJECT_ID },
      true
    );
    const latencyMs = Date.now() - t0;
    const answer = recall.body.answer ?? "";
    const citations = recall.body.citations ?? [];

    check("recall query returns 200", recall.status === 200, `status=${recall.status}`);
    check("answer mentions the chosen vector store",
      answer.toLowerCase().includes(DECISION_TERM.toLowerCase()),
      `answer=${answer.slice(0, 150)}`);
    check("answer mentions Pinecone rejection",
      /pinecone/i.test(answer),
      `answer=${answer.slice(0, 150)}`);
    check("answer is non-trivial (>50 chars)", answer.length > 50, `len=${answer.length}`);
    check(`recall query completes within 60s`, latencyMs < 60000, `latency=${latencyMs}ms`);
    console.log(`    INFO  query latency: ${latencyMs}ms (internal: ${recall.body.latency_ms}ms)`);
  }

  // ── Phase 6: Citation quality ───────────────────────────────────────────────
  phase(6, "Cite — answer grounded across agent log + document");

  if (!session1Ok || !docOk) {
    skip("citation quality check", "session 1 or document ingest did not succeed");
  } else {
    const cite = await post<{ answer: string; citations: Array<Record<string, unknown>> }>(
      "/brain/query",
      { query: `Explain the ${DECISION_TERM} vector store decision and its rationale`, project_id: PROJECT_ID },
      true
    );
    const citations = cite.body.citations ?? [];
    const sources = citations.map((c) => c.source as string);
    const hasAgentSource = sources.includes("agent");
    const hasDocSource = sources.includes("document");

    check("response has at least 1 citation", citations.length >= 1,
      `citation count=${citations.length}`);
    check("at least one citation from agent log", hasAgentSource,
      `sources=${sources.join(",")}`);
    check("at least one citation from document", hasDocSource,
      `sources=${sources.join(",")}`);

    const allHaveUrl = citations.every((c) => typeof c.source_url === "string" && c.source_url.length > 0);
    check("all citations include source_url", allHaveUrl,
      `urls=${citations.map((c) => c.source_url).join(" | ")}`);

    const allHaveActor = citations.every((c) => {
      const actor = c.actor as Record<string, unknown> | undefined;
      return actor && typeof actor.id === "string" && actor.id.length > 0;
    });
    check("all citations include actor", allHaveActor);
  }

  // ── Phase 7: Drift detection ────────────────────────────────────────────────
  phase(7, "Drift — contradiction alert fired");

  if (!session1Ok || !session2Ok) {
    skip("drift alert check", "one or both agent sessions did not succeed");
  } else {
    const alerts = await get<{ alerts: Array<Record<string, unknown>> }>(
      `/brain/drift-alerts?project_id=${encodeURIComponent(PROJECT_ID)}`
    );
    const alertList = alerts.body.alerts ?? [];

    check("at least one drift alert exists for this project", alertList.length >= 1,
      `alert count=${alertList.length}`);

    const llmConfirmed = alertList.filter((a) => a.confirmed_by_llm === true);
    check("at least one alert is LLM-confirmed", llmConfirmed.length >= 1,
      `confirmed=${llmConfirmed.length}/${alertList.length}`);

    const allHaveFingerprint = alertList.every((a) => typeof a.fingerprint === "string");
    check("all alerts have fingerprint set (dedup working)", allHaveFingerprint,
      `missing fp on ${alertList.filter((a) => !a.fingerprint).length} alert(s)`);

    const allPending = alertList.every((a) => a.resolution === "pending");
    check("all new alerts have resolution=pending", allPending);
  }

  // ── Phase 8: Drift deduplication ────────────────────────────────────────────
  phase(8, "Dedup — same content ingested again → no new alert");

  if (!session1Ok || !session2Ok || !API_KEY) {
    skip("dedup check", "prerequisite phases did not succeed or no API key");
  } else {
    // Re-ingest session 2 log with a NEW session_id so it isn't rejected as a duplicate session.
    // The content is identical — the fingerprint should prevent a new DriftAlert.
    const dedupeLog = {
      ...AGENT_LOG_S2,
      session_id: `sess_int_s2_dedup_${RUN_ID}`,
    };
    const reingest = await post<{ ok: boolean }>(
      "/brain/agent-log", dedupeLog, true
    );
    check("re-ingest of identical content returns 200", reingest.status === 200,
      `status=${reingest.status}`);

    // Short wait for the drift detector to process
    await sleep(30000);

    const alertsAfter = await get<{ alerts: Array<Record<string, unknown>> }>(
      `/brain/drift-alerts?project_id=${encodeURIComponent(PROJECT_ID)}`
    );
    const alertsBefore = (await get<{ alerts: Array<Record<string, unknown>> }>(
      `/brain/drift-alerts?project_id=${encodeURIComponent(PROJECT_ID)}`
    )).body.alerts ?? [];

    const fingerprints = alertsBefore.map((a) => a.fingerprint as string);
    const unique = new Set(fingerprints);
    check("no duplicate fingerprints after re-ingest", fingerprints.length === unique.size,
      `total=${fingerprints.length} unique=${unique.size}`);
  }

  // ── Phase 9: Project isolation ───────────────────────────────────────────────
  phase(9, "Scope — decoy project content does not leak into eval project");

  if (!docOk || !API_KEY) {
    skip("isolation check", "decoy doc ingest did not succeed or no API key");
  } else {
    const canaryQuery = await post<{ answer: string; citations: Array<Record<string, unknown>> }>(
      "/brain/query",
      {
        query: `DECOY_ISOLATION_CANARY_${RUN_ID}`,
        project_id: PROJECT_ID,
      },
      true
    );
    const answer = canaryQuery.body.answer ?? "";
    const citations = canaryQuery.body.citations ?? [];

    // Check retrieved context (citations), not the LLM answer — local models confabulate
    // by echoing the query term back even when no matching document was retrieved.
    const canaryInCitations = citations.some((c) =>
      String(c.quoted_text ?? "").includes(`DECOY_ISOLATION_CANARY_${RUN_ID}`) ||
      String(c.source_url ?? "").includes(DECOY_PROJECT)
    );
    check("canary term from decoy project not found in eval project query",
      !canaryInCitations,
      `answer=${answer.slice(0, 120)} citations=${citations.length}`);
  }

  // ── Phase 10: Graph integrity ────────────────────────────────────────────────
  phase(10, "Graph — Neo4j integrity assertions");

  try {
    // 1. No null project_id on Decision nodes for this project's events
    const nullProjectDecisions = await neoQuery<{ count: number }>(
      `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event {project_id: $pid})
       WHERE d.project_id IS NULL RETURN count(d) AS count`,
      { pid: PROJECT_ID }
    );
    check("all new Decision nodes have project_id set",
      Number(nullProjectDecisions[0]?.count ?? 0) === 0,
      `null count=${nullProjectDecisions[0]?.count}`);

    // 2. No orphaned Decision nodes
    const orphans = await neoQuery<{ count: number }>(
      `MATCH (d:Decision {project_id: $pid}) WHERE NOT (d)-[:EXTRACTED_FROM]->()
       RETURN count(d) AS count`,
      { pid: PROJECT_ID }
    );
    check("no orphaned Decision nodes in eval project",
      Number(orphans[0]?.count ?? 0) === 0,
      `orphans=${orphans[0]?.count}`);

    // 3. Drift alerts for this project have fingerprints and CHALLENGES relationships
    const alertsNeo = await neoQuery<{ alert_id: string; fp: string; has_challenge: boolean }>(
      `MATCH (da:DriftAlert)-[:CHALLENGES]->(d:Decision)-[:EXTRACTED_FROM]->(e:Event {project_id: $pid})
       RETURN da.alert_id AS alert_id, da.fingerprint AS fp, true AS has_challenge`,
      { pid: PROJECT_ID }
    );
    const allHaveFp = alertsNeo.every((a) => typeof a.fp === "string" && a.fp.length > 0);
    check("all eval project DriftAlerts have fingerprint in Neo4j", allHaveFp || alertsNeo.length === 0,
      alertsNeo.length === 0 ? "no alerts found (drift may not have fired yet)" : "");

    // 4. No duplicate fingerprints across all DriftAlerts globally
    const dupFp = await neoQuery<{ fp: string; count: number }>(
      `MATCH (da:DriftAlert) WHERE da.fingerprint IS NOT NULL
       WITH da.fingerprint AS fp, count(da) AS cnt WHERE cnt > 1
       RETURN fp, cnt AS count`
    );
    check("no duplicate DriftAlert fingerprints globally",
      dupFp.length === 0,
      dupFp.length > 0 ? `${dupFp.length} fingerprint(s) duplicated` : "");
  } catch (e) {
    check("Neo4j integrity queries executed without error", false, String(e));
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const totalMs = Date.now() - startTime;
  const total = passed + failed + skipped;

  console.log(`\n${"═".repeat(60)}`);
  console.log(`Integration Eval — ${(totalMs / 1000).toFixed(0)}s total`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped} (${API_KEY ? "unexpected" : "expected — no API key"})`);
  console.log(`  Total:   ${total}`);

  if (failed > 0) {
    console.error(`\n  NOT READY FOR DEMO — ${failed} check(s) failed.\n`);
    process.exit(1);
  } else if (skipped > 0 && !API_KEY) {
    console.log(`\n  PARTIALLY VERIFIED — set BRAIN_API_KEY / DEV_API_KEY to run full loop.\n`);
  } else {
    console.log(`\n  READY FOR DEMO ✓\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
