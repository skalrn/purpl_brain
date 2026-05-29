/**
 * seed-velox — seed the synthetic Velox corpus into the brain
 *
 * Reads eval/velox-corpus.json (7 sessions, 16 decisions, Jan–Apr 2026)
 * and POSTs each to POST /brain/agent-log sequentially.
 *
 * The corpus has 3 planted contradictions and 2 explicit supersessions;
 * used by eval-velox-baseline.ts to compare plain-RAG vs full brain.
 *
 * Usage:
 *   BRAIN_API_KEY=... npm run seed:velox -w apps/api
 *
 * Env:
 *   BRAIN_API_KEY   — required (default: dev-local for local dev)
 *   API_BASE        — default http://localhost:3001
 *   PROJECT_ID      — default eval_velox_<timestamp>; printed on exit
 *                     so eval script can pick it up
 */
import "dotenv/config";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

const API_BASE  = process.env.API_BASE      ?? "http://localhost:3001";
const API_KEY   = process.env.BRAIN_API_KEY ?? "dev-local";
const RUN_ID    = Date.now();
const PROJECT_ID = process.env.PROJECT_ID  ?? `eval_velox_${RUN_ID}`;

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CORPUS_PATH = join(__dirname, "../../../../../eval/velox-corpus.json");

interface SessionPayload {
  _comment?: string;
  schema_version: string;
  session_id: string;
  agent_id: string;
  project_id: string;
  task_id: string;
  codebase: string;
  timestamp_start: string;
  timestamp_end: string;
  work_completed: string;
  decisions: Array<{
    id: string;
    description: string;
    rationale: string;
    alternatives_considered?: string[];
    confidence: "high" | "medium" | "low";
  }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function postSession(payload: SessionPayload): Promise<void> {
  const res = await fetch(`${API_BASE}/brain/agent-log`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const body = await res.json() as Record<string, unknown>;

  if (res.status === 409) {
    console.log(`  SKIP  ${payload.session_id} — already seeded (409)`);
    return;
  }
  if (!res.ok) {
    throw new Error(`POST agent-log failed: status=${res.status} body=${JSON.stringify(body)}`);
  }

  console.log(`  OK    ${payload.session_id} — ${payload.decisions.length} decisions (event_id=${body.event_id})`);
}

async function main(): Promise<void> {
  console.log(`\nSeed: Velox synthetic corpus`);
  console.log(`  project_id : ${PROJECT_ID}`);
  console.log(`  api_base   : ${API_BASE}\n`);

  let sessions: SessionPayload[];
  try {
    const raw = readFileSync(CORPUS_PATH, "utf-8");
    sessions = JSON.parse(raw) as SessionPayload[];
  } catch (e) {
    console.error(`Failed to read corpus from ${CORPUS_PATH}: ${e}`);
    process.exit(1);
  }

  for (const session of sessions) {
    // Replace project_id placeholder and strip the comment field
    const payload: SessionPayload = {
      ...session,
      project_id: PROJECT_ID,
    };
    delete payload._comment;

    try {
      await postSession(payload);
    } catch (e) {
      console.error(`  FAIL  ${session.session_id} — ${e}`);
      process.exit(1);
    }

    // Small gap between sessions — avoids flooding Redis Streams ingest queue
    await sleep(500);
  }

  const total = sessions.reduce((n, s) => n + s.decisions.length, 0);
  console.log(`\nSeeded ${sessions.length} sessions, ${total} decisions.`);
  console.log(`PROJECT_ID=${PROJECT_ID}`);
  console.log(`\nPipeline processes decisions asynchronously via the extractor worker.`);
  console.log(`Wait ~30s before querying, or poll GET /projects/${PROJECT_ID}/stats until decisions > 0.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
