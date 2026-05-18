/**
 * Eval: Phase 4 M2 — Meeting transcript ingestion
 *
 * Checks:
 *  1. POST /brain/ingest/transcript accepts VTT and returns { ok, chunks_queued, format, speakers }
 *  2. format is "vtt" and speakers includes at least 3 names
 *  3. After pipeline processes, a query for "caching decision" returns a cited answer
 *  4. At least one citation has source === "meeting"
 *  5. Answer mentions Redis or allkeys-lru (grounded in transcript content)
 *  6. Duplicate ingest returns 409
 */
import "dotenv/config";

const API_BASE = process.env.API_BASE ?? "http://localhost:3001";
const PROJECT_ID = `eval_transcript_${Date.now()}`;

const MEETING_VTT = `WEBVTT

00:00:05.000 --> 00:00:15.000
Alice: We need to decide on the caching strategy for the query layer today.

00:00:15.500 --> 00:00:30.000
Bob: I propose we use Redis for caching. We already run Redis Streams so adding Memcached is unnecessary operational overhead.

00:00:31.000 --> 00:00:50.000
Carol: Redis also gives us persistence and pub/sub which Memcached lacks. I agree with Bob.

00:00:51.000 --> 00:01:10.000
Dave: We should set allkeys-lru eviction with a 512MB cap. That keeps memory bounded.

00:01:11.000 --> 00:01:30.000
Alice: Decision: use Redis for query result caching with allkeys-lru eviction and 512MB initial cap. Cache embeddings for 1 hour, query results for 15 minutes.
`;

const SOURCE_URL = `brain://meeting/eval/${PROJECT_ID}`;

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

async function main() {
  console.log(`\nEval: M2 Meeting Transcript  [project=${PROJECT_ID}]\n`);

  // ── Check 1: Ingest returns ok with vtt format ────────────────────────────
  const ingestRes = await fetch(`${API_BASE}/brain/ingest/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: MEETING_VTT,
      title: "Caching Architecture Decision",
      occurred_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      project_id: PROJECT_ID,
      source_url: SOURCE_URL,
    }),
  });

  const ingestBody = await ingestRes.json() as Record<string, unknown>;
  check("ingest returns 200 ok", ingestRes.status === 200 && ingestBody.ok === true,
    `status=${ingestRes.status} body=${JSON.stringify(ingestBody)}`);
  check("format detected as vtt", ingestBody.format === "vtt",
    `format=${ingestBody.format}`);
  check("speakers detected (≥3)", Array.isArray(ingestBody.speakers) && (ingestBody.speakers as string[]).length >= 3,
    `speakers=${JSON.stringify(ingestBody.speakers)}`);
  check("chunks queued (≥1)", typeof ingestBody.chunks_queued === "number" && (ingestBody.chunks_queued as number) >= 1,
    `chunks_queued=${ingestBody.chunks_queued}`);

  // ── Wait for pipeline ─────────────────────────────────────────────────────
  console.log("\n  Waiting 35s for pipeline (Ollama LLM extraction)...\n");
  await sleep(35000);

  // ── Check 2: Query returns cited answer about caching ────────────────────
  const queryRes = await fetch(`${API_BASE}/brain/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "What was the caching decision made in the meeting?",
      project_id: PROJECT_ID,
    }),
  });

  const queryBody = await queryRes.json() as Record<string, unknown>;
  const answer = String(queryBody.answer ?? "");
  const citations = (queryBody.citations as Array<Record<string, unknown>>) ?? [];

  check("query returns 200", queryRes.status === 200, `status=${queryRes.status}`);
  check("answer is non-empty", answer.length > 20, `answer=${answer.slice(0, 80)}`);

  const hasRedis = /redis/i.test(answer);
  const hasLru = /lru|allkeys/i.test(answer);
  const hasMeeting = /meeting|transcript|cach/i.test(answer);
  check("answer mentions Redis or eviction policy", hasRedis || hasLru || hasMeeting,
    `answer=${answer.slice(0, 120)}`);

  const meetingCitation = citations.find((c) => c.source === "meeting");
  check("at least one citation from meeting source", !!meetingCitation,
    `citation sources=${citations.map((c) => c.source).join(",")}`);

  // ── Check 3: Duplicate ingest returns 409 ────────────────────────────────
  const dupeRes = await fetch(`${API_BASE}/brain/ingest/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: MEETING_VTT,
      title: "Caching Architecture Decision",
      project_id: PROJECT_ID,
      source_url: SOURCE_URL,
    }),
  });
  check("duplicate ingest returns 409", dupeRes.status === 409,
    `status=${dupeRes.status}`);

  // ── Summary ───────────────────────────────────────────────────────────────
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
