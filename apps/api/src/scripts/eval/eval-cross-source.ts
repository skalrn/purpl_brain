/**
 * Eval: Cross-source synthesis
 *
 * Ingest a document + meeting transcript covering the same topic under the
 * same project_id. Query should synthesize across both and cite both sources.
 *
 *  1. POST /brain/ingest/document with JWT auth content returns 200 ok
 *  2. POST /brain/ingest/transcript with JWT discussion returns 200 ok
 *  3. After pipeline (35s), query returns non-empty answer
 *  4. Answer mentions JWT or authentication
 *  5. Citations include at least one "document" source
 *  6. Citations include at least one "meeting" source
 *  7. Total citation count >= 2
 *
 * Note: ingest endpoints require X-API-Key. If BRAIN_API_KEY is unset,
 * pipeline checks are skipped.
 */
import "dotenv/config";
import { cleanupEvalProjects } from "../../lib/eval-cleanup.js";

const API_BASE = process.env.API_BASE ?? "http://localhost:3741";
const API_KEY = process.env.BRAIN_API_KEY ?? "";
const RUN_ID = Date.now();
const PROJECT_ID = `eval_cross_${RUN_ID}`;

const DOC_TEXT = `# ADR-200: Authentication strategy

## Status
Accepted

## Decision
We will use authentication middleware based on JWT tokens for all API endpoints.
Token signing uses RS256 with key rotation every 90 days.

## Rationale
JWT tokens are stateless, scale horizontally without shared session storage,
and integrate cleanly with our existing microservice topology. The middleware
verifies the signature, expiry, and audience claim on every request.

## Alternatives Considered
- Session cookies stored in Redis (rejected: requires sticky sessions or central store)
- OAuth opaque tokens (rejected: extra introspection round-trip per request)
`;

const TRANSCRIPT_VTT = `WEBVTT

00:00:05.000 --> 00:00:20.000
Alice: Let's settle the auth question. We've been going back and forth between session cookies and JWT.

00:00:20.500 --> 00:00:40.000
Bob: I think JWT is the right call. Session cookies would force us to either pin users to a node or run a central session store, which adds latency and a single point of failure.

00:00:41.000 --> 00:01:05.000
Carol: Agreed. JWT also lets us pass identity through to downstream services without re-authenticating. We chose JWT over session cookies primarily for the stateless property.

00:01:06.000 --> 00:01:25.000
Alice: Decision: use JWT tokens for authentication across all services. We'll implement signature verification in shared middleware.
`;

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
  console.log(`\nEval: Cross-source synthesis  [project=${PROJECT_ID}]\n`);

  if (!API_KEY) {
    console.log("  NOTE  BRAIN_API_KEY not set — ingest will 401. Skipping pipeline checks.\n");
  }

  // ── Check 1: Ingest document ────────────────────────────────────────────────
  const docRes = await fetch(`${API_BASE}/brain/ingest/document`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      text: DOC_TEXT,
      title: "ADR-200 Authentication Strategy",
      path: "docs/adrs/200-auth-strategy.md",
      project_id: PROJECT_ID,
      source_url: `brain://eval/cross-source/doc/${RUN_ID}`,
    }),
  });
  const docBody = (await docRes.json()) as Record<string, unknown>;

  if (!API_KEY) {
    check("document ingest returns 401 without API key", docRes.status === 401,
      `status=${docRes.status}`);
  } else {
    check("document ingest returns 200 ok", docRes.status === 200 && docBody.ok !== false,
      `status=${docRes.status} body=${JSON.stringify(docBody).slice(0, 120)}`);
  }

  // ── Check 2: Ingest transcript ──────────────────────────────────────────────
  const txRes = await fetch(`${API_BASE}/brain/ingest/transcript`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      text: TRANSCRIPT_VTT,
      title: "Auth strategy meeting",
      occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      project_id: PROJECT_ID,
      source_url: `brain://eval/cross-source/meeting/${RUN_ID}`,
    }),
  });
  const txBody = (await txRes.json()) as Record<string, unknown>;

  if (!API_KEY) {
    check("transcript ingest returns 401 without API key", txRes.status === 401,
      `status=${txRes.status}`);
  } else {
    check("transcript ingest returns 200 ok", txRes.status === 200 && txBody.ok === true,
      `status=${txRes.status} body=${JSON.stringify(txBody).slice(0, 120)}`);
  }

  if (!API_KEY || docRes.status !== 200 || txRes.status !== 200) {
    console.log("\n  SKIP  pipeline + cross-source citation checks\n");
  } else {
    console.log("\n  Waiting 35s for pipeline (Ollama LLM extraction)...\n");
    await sleep(35000);

    // ── Check 3-6: Query synthesizes across sources ───────────────────────────
    const queryRes = await fetch(`${API_BASE}/brain/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "What authentication approach was decided and why?",
        project_id: PROJECT_ID,
      }),
    });
    const queryBody = (await queryRes.json()) as Record<string, unknown>;
    const answer = String(queryBody.answer ?? "");
    const citations = (queryBody.citations as Array<Record<string, unknown>>) ?? [];

    check("query returns 200", queryRes.status === 200, `status=${queryRes.status}`);
    check("answer is non-empty", answer.length > 20, `answer=${answer.slice(0, 80)}`);
    check("answer mentions JWT or authentication",
      /jwt|authentication|auth/i.test(answer),
      `answer=${answer.slice(0, 120)}`);

    const docCitation = citations.find((c) => c.source === "document");
    check("at least one citation has source=document", !!docCitation,
      `citation sources=${citations.map((c) => c.source).join(",")}`);

    const meetingCitation = citations.find((c) => c.source === "meeting");
    check("at least one citation has source=meeting", !!meetingCitation,
      `citation sources=${citations.map((c) => c.source).join(",")}`);

    check("total citation count >= 2", citations.length >= 2,
      `count=${citations.length}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Result: ${passed}/${total} passed`);

  console.log("\n  Cleaning up eval data...");
  await cleanupEvalProjects([PROJECT_ID]);

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
