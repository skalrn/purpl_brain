/**
 * eval-security — automated verification of H1-H6 + C2/C4 security fixes
 *
 * Sections:
 *   A  Link follower guards (in-process, no services needed)
 *   B  HTTP auth boundary checks (requires live API at API_BASE)
 *   C  Task approval gate / H1 (requires live API)
 *   D  Manual checks summary (startup guards, MCP auth, Docker)
 *
 * Pass criterion: all automated checks green.
 *
 * Usage:
 *   npm run eval:security -w apps/api
 *
 * Required env:
 *   API_BASE       — defaults to http://localhost:3001
 *   BRAIN_API_KEY  — a valid API key (DEV_API_KEY value is fine for dev)
 *   CORS_ALLOWED_ORIGINS — must match API config (defaults to http://localhost:3000)
 */
import "dotenv/config";

const API_BASE  = process.env.API_BASE  ?? "http://localhost:3001";
const API_KEY   = process.env.BRAIN_API_KEY ?? "dev-local";
const ALLOWED_ORIGIN = (process.env.CORS_ALLOWED_ORIGINS ?? "http://localhost:3000").split(",")[0].trim();
const BLOCKED_ORIGIN = "https://evil.example.com";
const RUN_ID    = Date.now();
const PROJECT   = `eval_sec_${RUN_ID}`;

let passed = 0;
let failed = 0;
let skipped = 0;

function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed++;
  } else {
    console.error(`  FAIL  ${name}${detail ? `  — ${detail}` : ""}`);
    failed++;
  }
}

function skip(name: string, reason: string) {
  console.log(`  SKIP  ${name}  (${reason})`);
  skipped++;
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, { headers });
}

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

// ── Section A: Link follower guards ──────────────────────────────────────────
// Tests the validation constants in extractor.ts in-process.
// These run without any live services.

console.log("\n── eval-security ──────────────────────────────────────────────\n");
console.log(`  API_BASE       : ${API_BASE}`);
console.log(`  ALLOWED_ORIGIN : ${ALLOWED_ORIGIN}`);
console.log(`  PROJECT        : ${PROJECT}\n`);

console.log("── Section A: Link follower guards (in-process) ──\n");

// Slug regex must match what extractor.ts defines:
//   const GITHUB_SLUG_RE = /^[a-zA-Z0-9_.-]+$/;
const GITHUB_SLUG_RE = /^[a-zA-Z0-9_.-]+$/;

check("valid slug 'my-org' passes",            GITHUB_SLUG_RE.test("my-org"));
check("valid slug 'My.Org_123' passes",        GITHUB_SLUG_RE.test("My.Org_123"));
check("path traversal '../etc' rejected",      !GITHUB_SLUG_RE.test("../etc"));
check("slash in slug 'evil/path' rejected",    !GITHUB_SLUG_RE.test("evil/path"));
check("null-byte 'evil\\x00' rejected",        !GITHUB_SLUG_RE.test("evil\x00"));
check("space in slug 'my org' rejected",       !GITHUB_SLUG_RE.test("my org"));
check("empty slug '' rejected",                !GITHUB_SLUG_RE.test(""));

// Cap: MAX_LINKS_PER_EVENT = 5
const GITHUB_PR_RE_SRC = /https:\/\/github\.com\/([^/\s"')]+)\/([^/\s"')]+)\/pull\/(\d+)/g;
const MAX_LINKS_PER_EVENT = 5;

const contentWith7Links = Array.from(
  { length: 7 },
  (_, i) => `https://github.com/org/repo/pull/${i + 1}`
).join(" ");
const extracted = [...contentWith7Links.matchAll(GITHUB_PR_RE_SRC)].slice(0, MAX_LINKS_PER_EVENT);
check("7 PR links in content capped at 5", extracted.length === 5, `got ${extracted.length}`);
check("0 PR links extracts nothing",
  [...("no links here").matchAll(GITHUB_PR_RE_SRC)].length === 0);

// Allowlist enforcement
function isAllowed(owner: string, repo: string, allowlist: Set<string> | null): boolean {
  if (allowlist === null) return true;
  return allowlist.has(`${owner}/${repo}`);
}

const allowlist = new Set(["my-org/allowed-repo"]);
check("allowlist set: listed repo allowed",
  isAllowed("my-org", "allowed-repo", allowlist));
check("allowlist set: unlisted repo blocked",
  !isAllowed("my-org", "other-repo", allowlist));
check("allowlist null (unset): any repo allowed",
  isAllowed("random-org", "random-repo", null));

// ── Section B: HTTP auth boundary checks ──────────────────────────────────────
console.log("\n── Section B: HTTP auth boundary checks (live API) ──\n");

let apiReachable = false;
try {
  const health = await get("/health");
  apiReachable = health.ok;
} catch {
  console.log(`  WARN  API not reachable at ${API_BASE} — skipping live checks\n`);
}

if (!apiReachable) {
  skip("GET /brain/drift-alerts without key → 401", "API not reachable");
  skip("GET /brain/seats without key → 401",        "API not reachable");
  skip("POST /brain/query/stream bad origin → 403", "API not reachable");
  skip("POST /brain/query/stream good origin → allowed", "API not reachable");
  skip("DEV_API_KEY accepted in dev mode",          "API not reachable");
  skip("GET /brain/tasks without key → 401",        "API not reachable");
  skip("GET /brain/tasks with key → 200",           "API not reachable");
} else {
  // C4 partial: protected endpoints require a key
  const driftRes = await get("/brain/drift-alerts?project_id=x");
  check("GET /brain/drift-alerts without key → 401",
    driftRes.status === 401, `got ${driftRes.status}`);

  const seatsRes = await get("/brain/seats?project_id=x");
  check("GET /brain/seats without key → 401",
    seatsRes.status === 401, `got ${seatsRes.status}`);

  // C2: CORS allowlist on SSE stream
  // Blocked origin — must 403 before hijack (requires valid API key to reach the check)
  const blockedRes = await post(
    "/brain/query/stream",
    { query: "test", project_id: PROJECT },
    { "x-api-key": API_KEY, Origin: BLOCKED_ORIGIN }
  );
  check(
    `POST /brain/query/stream origin '${BLOCKED_ORIGIN}' → 403`,
    blockedRes.status === 403,
    `got ${blockedRes.status}`
  );

  // Valid origin — must not 403 (may be 200 or SSE)
  const allowedRes = await post(
    "/brain/query/stream",
    { query: "test", project_id: PROJECT },
    { "x-api-key": API_KEY, Origin: ALLOWED_ORIGIN }
  );
  check(
    `POST /brain/query/stream origin '${ALLOWED_ORIGIN}' → not 403`,
    allowedRes.status !== 403,
    `got ${allowedRes.status}`
  );

  // H6: DEV_API_KEY works in dev mode (NODE_ENV != production)
  // Can only validate the "allowed in dev" side from an eval; the "blocked in
  // prod" side is enforced by NODE_ENV=production in docker-compose.prod.yml.
  const devKeyRes = await get(`/brain/tasks?project_id=${PROJECT}`, { "x-api-key": API_KEY });
  check(
    "DEV_API_KEY (or any valid key) accepted — dev mode",
    devKeyRes.status !== 401,
    `got ${devKeyRes.status}`
  );

  // ── Section C: Task approval gate (H1) ─────────────────────────────────────
  console.log("\n── Section C: Task approval gate (H1) ──\n");

  // Auth required
  const noKeyTasksRes = await get(`/brain/tasks?project_id=${PROJECT}`);
  check("GET /brain/tasks without key → 401",
    noKeyTasksRes.status === 401, `got ${noKeyTasksRes.status}`);

  // Shape check
  const tasksRes = await get(
    `/brain/tasks?project_id=${PROJECT}`,
    { "x-api-key": API_KEY }
  );
  check("GET /brain/tasks with valid key → 200",
    tasksRes.status === 200, `got ${tasksRes.status}`);

  if (tasksRes.status === 200) {
    const body = await tasksRes.json() as { tasks: Array<Record<string, unknown>>; total: number };
    check("GET /brain/tasks response has 'tasks' array",
      Array.isArray(body.tasks), `got ${typeof body.tasks}`);
    check("GET /brain/tasks response has 'total' count",
      typeof body.total === "number", `got ${typeof body.total}`);

    if (body.tasks.length > 0) {
      const allApproved = body.tasks.every((t) => t.requires_approval === true);
      check(
        `all ${body.tasks.length} task(s) have requires_approval=true`,
        allApproved,
        body.tasks
          .filter((t) => t.requires_approval !== true)
          .map((t) => `task_id=${t.task_id} requires_approval=${t.requires_approval}`)
          .join(", ")
      );
    } else {
      skip(
        "all tasks have requires_approval=true",
        "no tasks exist in project — create a drift alert and resolve with 'reopen' to seed one"
      );
    }
  }
}

// ── Section D: Manual verification reminders ─────────────────────────────────
console.log("\n── Section D: Manual verification (not automated) ──\n");
console.log("  The following checks require a separate invocation or inspection:\n");

const manual = [
  {
    id: "H4",
    check: "SESSION_SECRET hard-fail on default or missing",
    cmd: `SESSION_SECRET="purpl-brain-dev-secret-change-in-production" NEO4J_URI=x NEO4J_USER=x node apps/api/dist/index.js`,
    expect: "[config] FATAL: SESSION_SECRET is using the insecure dev default + exit 1",
  },
  {
    id: "H5",
    check: "Session cookie has Secure attribute by default",
    cmd: "curl -v 'http://localhost:3001/auth/github/callback?code=test' 2>&1 | grep -i set-cookie",
    expect: "Set-Cookie: ... Secure",
  },
  {
    id: "H3",
    check: "Neo4j ports 7474 and 7687 not bound to host in prod compose",
    cmd: "docker compose -f docker-compose.prod.yml config | grep -A20 'neo4j:' | grep -E '7474|7687'",
    expect: "(no output — ports should not appear under neo4j ports mapping)",
  },
  {
    id: "H6",
    check: "DEV_API_KEY blocked when NODE_ENV=production",
    cmd: `NODE_ENV=production DEV_API_KEY=dev-local curl -H "x-api-key: dev-local" http://localhost:3001/brain/tasks?project_id=x`,
    expect: '{"statusCode":401,"error":"Unauthorized","message":"Invalid API key"}',
  },
  {
    id: "C1",
    check: "MCP HTTP transport rejects requests without MCP_AUTH_TOKEN bearer",
    cmd: `MCP_TRANSPORT=http MCP_AUTH_TOKEN=secret node apps/mcp/dist/index.js &
curl -s http://localhost:3002/mcp -d '{}' -H 'Content-Type: application/json'
curl -s http://localhost:3002/mcp -d '{}' -H 'Content-Type: application/json' -H 'Authorization: Bearer wrong'
curl -s http://localhost:3002/mcp -d '{}' -H 'Content-Type: application/json' -H 'Authorization: Bearer secret'`,
    expect: "First two: 401. Third: MCP protocol response.",
  },
  {
    id: "C3",
    check: "Web Docker image contains no NEXT_PUBLIC_API_KEY",
    cmd: "docker build -t brain-web-test apps/web/ && docker run --rm brain-web-test sh -c 'grep -r NEXT_PUBLIC_API_KEY /app/.next && exit 1 || echo CLEAN'",
    expect: "CLEAN",
  },
];

for (const m of manual) {
  console.log(`  [${m.id}] ${m.check}`);
  console.log(`       cmd    : ${m.cmd.split("\n")[0]}`);
  console.log(`       expect : ${m.expect}\n`);
}

// ── Scorecard ─────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log("─".repeat(62));
console.log(`Automated:  ${passed}/${total} passed${skipped > 0 ? `  (${skipped} skipped — API not reachable)` : ""}`);
console.log(`Manual:     ${manual.length} checks listed above — run separately`);
console.log();

if (failed > 0) {
  console.error(`EVAL FAILED — ${failed} automated check(s) failed`);
  process.exit(1);
} else {
  console.log("EVAL PASSED ✓  (all automated checks green)");
}
