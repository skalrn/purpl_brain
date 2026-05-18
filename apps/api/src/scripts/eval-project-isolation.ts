/**
 * Eval: project_id isolation
 *
 * Ingest distinct content into two projects (A and B). Verify the query
 * engine never leaks content from one project into the other.
 *
 *  1. Ingest distinctive doc into project A returns 200 ok
 *  2. Ingest different distinctive doc into project B returns 200 ok
 *  3. Query A for A's content returns non-empty answer
 *  4. Query A for B's content returns empty/no-relevant-info answer (no leak)
 *  5. Query B for B's content returns non-empty answer
 *  6. Query B for A's content returns empty/no-relevant-info answer (no leak)
 *  7. Citations from A queries are scoped to A's source_url
 *
 * Distinctive vocabulary is used so accidental embedding overlap is unlikely.
 *
 * Note: ingest endpoints require X-API-Key. If BRAIN_API_KEY is unset,
 * pipeline checks are skipped.
 */
import "dotenv/config";

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const API_KEY = process.env.BRAIN_API_KEY ?? "";
const RUN_ID = Date.now();
const PROJECT_A = `eval_iso_A_${RUN_ID}`;
const PROJECT_B = `eval_iso_B_${RUN_ID}`;

const DOC_A = `# Zephyr Database Internals

The Zephyr database uses merkle trees for consistency verification across replicas.
Each write produces a new merkle root that downstream replicas compare against
their local computation. A mismatch triggers a fast-path repair using the merkle
diff to identify the divergent subtree without scanning the full dataset.

Merkle tree depth is bounded at 24 for the Zephyr storage engine.
`;

const DOC_B = `# Helios Service Architecture

The Helios deduplication service uses bloom filters to skip already-seen request
fingerprints. A 128-bit fingerprint is computed per request and tested against
a counting bloom filter sized for one billion entries with 0.1% false positive
rate.

Bloom filter rotation in Helios happens every 12 hours via the snapshot job.
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

interface QueryResult {
  answer: string;
  citations: Array<Record<string, unknown>>;
}

async function query(q: string, projectId: string): Promise<{ status: number; body: QueryResult }> {
  const res = await fetch(`${API_BASE}/brain/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: q, project_id: projectId }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return {
    status: res.status,
    body: {
      answer: String(body.answer ?? ""),
      citations: (body.citations as Array<Record<string, unknown>>) ?? [],
    },
  };
}

function looksLikeNoInfo(answer: string, citations: Array<Record<string, unknown>>): boolean {
  // Treat as "no relevant info" if citations are empty OR answer signals
  // absence of knowledge with common no-info phrasing.
  if (citations.length === 0) return true;
  const a = answer.toLowerCase();
  return (
    a.includes("don't have") ||
    a.includes("do not have") ||
    a.includes("no information") ||
    a.includes("not enough information") ||
    a.includes("no relevant") ||
    a.includes("cannot find") ||
    a.includes("couldn't find") ||
    a.includes("unable to find") ||
    a.includes("no mention") ||
    a.includes("not mentioned")
  );
}

async function main() {
  console.log(`\nEval: project_id isolation  [A=${PROJECT_A} B=${PROJECT_B}]\n`);

  if (!API_KEY) {
    console.log("  NOTE  BRAIN_API_KEY not set — ingest will 401. Skipping pipeline checks.\n");
  }

  // ── Check 1: Ingest A ───────────────────────────────────────────────────────
  const aRes = await fetch(`${API_BASE}/brain/ingest/document`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      text: DOC_A,
      title: "Zephyr Database Internals",
      path: "docs/zephyr/internals.md",
      project_id: PROJECT_A,
      source_url: `brain://eval/iso/a/${RUN_ID}`,
    }),
  });

  if (!API_KEY) {
    check("project A ingest returns 401 without API key", aRes.status === 401,
      `status=${aRes.status}`);
  } else {
    check("project A ingest returns 200 ok", aRes.status === 200,
      `status=${aRes.status}`);
  }

  // ── Check 2: Ingest B ───────────────────────────────────────────────────────
  const bRes = await fetch(`${API_BASE}/brain/ingest/document`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      text: DOC_B,
      title: "Helios Service Architecture",
      path: "docs/helios/architecture.md",
      project_id: PROJECT_B,
      source_url: `brain://eval/iso/b/${RUN_ID}`,
    }),
  });

  if (!API_KEY) {
    check("project B ingest returns 401 without API key", bRes.status === 401,
      `status=${bRes.status}`);
  } else {
    check("project B ingest returns 200 ok", bRes.status === 200,
      `status=${bRes.status}`);
  }

  if (!API_KEY || aRes.status !== 200 || bRes.status !== 200) {
    console.log("\n  SKIP  isolation checks (no API key or ingest failed)\n");
  } else {
    console.log("\n  Waiting 35s for pipeline (Ollama LLM extraction)...\n");
    await sleep(35000);

    // ── Check 3: A finds A's content ────────────────────────────────────────
    const aHit = await query("How does Zephyr use merkle trees for consistency?", PROJECT_A);
    check("query A for merkle trees returns non-empty answer",
      aHit.status === 200 && aHit.body.answer.length > 20 && /merkle/i.test(aHit.body.answer),
      `answer=${aHit.body.answer.slice(0, 120)}`);

    // ── Check 4: A does NOT find B's content ────────────────────────────────
    const aMiss = await query("How does Helios use bloom filters for deduplication?", PROJECT_A);
    check("query A for bloom filters returns no-info / no leak from B",
      looksLikeNoInfo(aMiss.body.answer, aMiss.body.citations) || !/bloom|helios/i.test(aMiss.body.answer),
      `answer=${aMiss.body.answer.slice(0, 120)} citations=${aMiss.body.citations.length}`);

    // ── Check 5: B finds B's content ────────────────────────────────────────
    const bHit = await query("How does Helios use bloom filters for deduplication?", PROJECT_B);
    check("query B for bloom filters returns non-empty answer",
      bHit.status === 200 && bHit.body.answer.length > 20 && /bloom/i.test(bHit.body.answer),
      `answer=${bHit.body.answer.slice(0, 120)}`);

    // ── Check 6: B does NOT find A's content ────────────────────────────────
    const bMiss = await query("How does Zephyr use merkle trees for consistency?", PROJECT_B);
    check("query B for merkle trees returns no-info / no leak from A",
      looksLikeNoInfo(bMiss.body.answer, bMiss.body.citations) || !/merkle|zephyr/i.test(bMiss.body.answer),
      `answer=${bMiss.body.answer.slice(0, 120)} citations=${bMiss.body.citations.length}`);

    // ── Check 7: A's citations are scoped to A ──────────────────────────────
    const aOnlyCitationsScoped = aHit.body.citations.every((c) => {
      const url = String(c.source_url ?? "");
      return !url.includes("/iso/b/");
    });
    check("project A citations do not reference project B source_url", aOnlyCitationsScoped,
      `A urls=${aHit.body.citations.map((c) => c.source_url).join(",")}`);
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
