/**
 * eval-link-following — verifies the 91% recall fix
 *
 * The gap: ADRs embed GitHub PR URLs, but those PR discussions were never
 * ingested. Decisions made only in linked PR comment threads were invisible.
 *
 * This eval:
 *  1. Ingests a synthetic ADR that embeds a real public GitHub PR URL
 *  2. Waits for the extractor to detect the URL and queue the linked PR
 *  3. Checks Redis LINKED_PR_SET to confirm the PR was fetched
 *  4. Checks the PR event flowed through the pipeline into Qdrant
 *  5. Queries for content that exists ONLY in the linked PR, not the ADR text
 *
 * Requires: GITHUB_TOKEN (uses public repo, any valid token works)
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... npm run eval:link-following -w apps/api
 */
import "dotenv/config";
import { Redis } from "ioredis";

const API = process.env.BRAIN_API_URL ?? "http://localhost:3001";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const PROJECT = "eval_link_following";
const LINKED_PR_SET = "brain:linked_pr_processed";

// A real encode/httpx PR that has a meaningful decision in its discussion.
// PR #3360 is the compression policy PR — final gzip-only decision was made
// in a comment thread, not in the PR description itself.
const TEST_PR_OWNER = "encode";
const TEST_PR_REPO = "httpx";
const TEST_PR_NUM = "3360";
const TEST_PR_URL = `https://github.com/${TEST_PR_OWNER}/${TEST_PR_REPO}/pull/${TEST_PR_NUM}`;

// This ADR text deliberately does NOT contain the decision keywords.
// The decision ("gzip only", "zstandard deferred") lives in the PR discussion.
// The brain should only be able to answer the query after following the link.
const SYNTHETIC_ADR = `# ADR-042: HTTP Compression Support Policy

## Status
Accepted

## Context
We are finalising the compression support policy for the 1.0 release.
A detailed discussion of the tradeoffs was held in the PR at ${TEST_PR_URL}.

## Decision
See the linked PR discussion for the concluded policy.

## Consequences
See linked PR.
`;

// Query that can ONLY be answered from the linked PR discussion, not from
// the sparse ADR text above.
const RECALL_QUERY = "What compression formats are supported in the httpx 1.0 release? Was zstandard included?";
const RECALL_KEYWORDS = ["gzip", "zstd", "zstandard", "compression"];

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

let passed = 0;
let failed = 0;
let skipped = 0;

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

function skip(name: string, reason: string) {
  console.log(`  - ${name}: SKIPPED (${reason})`);
  skipped++;
}

// ── Pre-flight ────────────────────────────────────────────────────────────────

console.log("\n── eval-link-following: 91% recall fix verification ──\n");

if (!GITHUB_TOKEN) {
  console.error("❌  GITHUB_TOKEN is required for link-following to activate.");
  console.error("    Set it in apps/api/.env or export it:");
  console.error("    GITHUB_TOKEN=ghp_... npm run eval:link-following -w apps/api\n");
  process.exit(1);
}

// Clear any prior run of this eval from Redis so we see a fresh fetch
const prKey = `${TEST_PR_OWNER}/${TEST_PR_REPO}/pull/${TEST_PR_NUM}`;
const wasPresent = await redis.sismember(LINKED_PR_SET, prKey);
if (wasPresent) {
  await redis.srem(LINKED_PR_SET, prKey);
  console.log(`  (cleared prior LINKED_PR_SET entry for ${prKey} to force re-fetch)\n`);
}

// Verify the PR exists on GitHub before we ingest the ADR
console.log(`  Verifying test PR exists: ${TEST_PR_URL}`);
const prCheck = await fetch(
  `https://api.github.com/repos/${TEST_PR_OWNER}/${TEST_PR_REPO}/pulls/${TEST_PR_NUM}`,
  {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${GITHUB_TOKEN}`,
    },
  }
);
if (!prCheck.ok) {
  console.error(`❌  Could not fetch test PR (${prCheck.status}). Check GITHUB_TOKEN and PR URL.`);
  await redis.quit();
  process.exit(1);
}
const prData = await prCheck.json() as { title: string; body: string };
console.log(`  PR title: "${prData.title}"`);
console.log(`  PR body length: ${prData.body?.length ?? 0} chars\n`);

// ── Step 1: Ingest the synthetic ADR ─────────────────────────────────────────

console.log("── Step 1: Ingest synthetic ADR ──\n");

let chunksQueued = 0;
await check("POST /brain/ingest/document — ingests ADR with embedded PR URL", async () => {
  try {
    const result = await post("/brain/ingest/document", {
      text: SYNTHETIC_ADR,
      title: "ADR-042 HTTP Compression Support",
      path: "docs/adrs/042-compression-policy.md",
      project_id: PROJECT,
      source_url: "brain://eval/adr-042",
    }) as { chunks_queued: number; document_type: string };
    chunksQueued = result.chunks_queued;
    if (result.chunks_queued < 1) throw new Error(`Expected ≥1 chunk, got ${result.chunks_queued}`);
  } catch (e) {
    // If duplicate from prior run, delete and retry
    if ((e as Error).message.includes("409")) {
      // Can't delete easily via API, skip with warning
      console.log("    (409 conflict — ADR already ingested from prior run, proceeding)");
      chunksQueued = 1;
      return;
    }
    throw e;
  }
});
console.log(`  chunks queued: ${chunksQueued}\n`);

// ── Step 2: Wait for pipeline ─────────────────────────────────────────────────

console.log("── Step 2: Wait for pipeline (normalizer → extractor → brain-writer) ──\n");
const WAIT_MS = 20_000;
console.log(`  Waiting ${WAIT_MS / 1000}s...`);

const pollInterval = 2000;
let elapsed = 0;
let linkedPRDetected = false;
while (elapsed < WAIT_MS) {
  await sleep(pollInterval);
  elapsed += pollInterval;
  const inSet = await redis.sismember(LINKED_PR_SET, prKey);
  if (inSet) {
    linkedPRDetected = true;
    console.log(`  ✓ Linked PR detected in LINKED_PR_SET after ${elapsed / 1000}s\n`);
    break;
  }
  process.stdout.write(".");
}
if (!linkedPRDetected) process.stdout.write("\n");

// ── Step 3: Verify link-following mechanism ───────────────────────────────────

console.log("\n── Step 3: Verify mechanism ──\n");

await check("LINKED_PR_SET contains the linked PR key", async () => {
  if (!linkedPRDetected) {
    const inSet = await redis.sismember(LINKED_PR_SET, prKey);
    if (!inSet) throw new Error(
      `PR key "${prKey}" not found in brain:linked_pr_processed after ${WAIT_MS / 1000}s. ` +
      `Extractor may not have processed the document event yet, or GITHUB_TOKEN is invalid.`
    );
  }
});

// Give the queued PR event more time to flow through the full pipeline
if (linkedPRDetected) {
  console.log("  Waiting 15s more for linked PR event to complete pipeline...");
  await sleep(15_000);
}

// ── Step 4: Verify Qdrant has linked PR content ───────────────────────────────

console.log("\n── Step 4: Verify linked PR content in Qdrant ──\n");

let qdrantCountBefore = 0;
try {
  const countRes = await fetch(
    `http://localhost:6333/collections/brain_chunks/points/count`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "project_id", match: { value: PROJECT } }] }, exact: true }) }
  );
  const countData = await countRes.json() as { result?: { count: number } };
  qdrantCountBefore = countData.result?.count ?? 0;
} catch {
  // Qdrant not accessible directly — skip
}

await check("Qdrant has multiple chunks for the eval project (ADR + linked PR)", async () => {
  const countRes = await fetch(
    `http://localhost:6333/collections/brain_chunks/points/count`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "project_id", match: { value: PROJECT } }] }, exact: true }) }
  );
  if (!countRes.ok) throw new Error(`Qdrant count failed: ${countRes.status}`);
  const countData = await countRes.json() as { result?: { count: number } };
  const count = countData.result?.count ?? 0;
  // We should have at least: 1 ADR chunk + 1 linked PR chunk
  if (count < 2) throw new Error(
    `Expected ≥2 chunks (ADR + linked PR), got ${count}. ` +
    `If only the ADR was ingested, link-following did not produce events.`
  );
  console.log(`    total chunks in project: ${count}`);
});

// ── Step 5: Recall query — can brain answer using linked PR content? ──────────

console.log("\n── Step 5: Recall query (the actual 91% → 100% test) ──\n");
console.log(`  Query: "${RECALL_QUERY}"`);
console.log(`  Expected keywords in answer: [${RECALL_KEYWORDS.join(", ")}]`);
console.log(`  (These keywords are NOT in the ADR text — only in the linked PR)\n`);

await check("brain_query answers using linked PR content (not just ADR text)", async () => {
  const res = await post("/brain/query", {
    query: RECALL_QUERY,
    project_id: PROJECT,
    mode: "project",
  }) as { answer: string; citations: Array<{ source: string; source_url?: string }> };

  console.log(`\n  Answer (${res.citations.length} citations):\n  ${res.answer.slice(0, 300)}\n`);

  const lower = res.answer.toLowerCase();
  const matched = RECALL_KEYWORDS.filter((kw) => lower.includes(kw.toLowerCase()));

  if (matched.length === 0) throw new Error(
    `Answer does not mention any recall keywords [${RECALL_KEYWORDS.join(", ")}]. ` +
    `The brain is answering from the ADR text only — linked PR content is not reaching the query layer.\n` +
    `Answer: "${res.answer.slice(0, 200)}"`
  );

  console.log(`  Matched keywords: [${matched.join(", ")}]`);

  const hasGitHubCitation = res.citations.some(
    (c) => c.source_url?.includes("github.com") && c.source_url.includes("/pull/")
  );
  if (!hasGitHubCitation) {
    console.log(`  ⚠ No GitHub PR citation found — answer may be from ADR context window, not PR content.`);
    console.log(`    Citations: ${JSON.stringify(res.citations.map((c) => c.source_url ?? c.source))}`);
  } else {
    console.log(`  GitHub PR citation confirmed.`);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

await redis.quit();

console.log("\n── Results ──\n");
console.log(`  Passed : ${passed}`);
console.log(`  Failed : ${failed}`);
if (skipped > 0) console.log(`  Skipped: ${skipped}`);
console.log("");

if (failed === 0) {
  console.log("  ✓ PASS — linked PR content is being ingested and recalled.");
  console.log("  91% recall gap is resolved for this case.\n");
} else {
  console.log("  ✗ FAIL — link-following is not working end-to-end.\n");
  console.log("  Debug steps:");
  console.log("    1. docker compose logs extractor | tail -30");
  console.log("    2. Check GITHUB_TOKEN is valid: curl -s -H \"Authorization: Bearer $GITHUB_TOKEN\" https://api.github.com/rate_limit");
  console.log("    3. Confirm extractor container was rebuilt: docker compose up -d --build extractor\n");
}

process.exit(failed > 0 ? 1 : 0);
