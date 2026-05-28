/**
 * seed-hono — ingest the Hono open-source project into the brain
 *
 * Targets decision-rich content from the honojs/hono public GitHub repo:
 *   - Top PRs by comment count (design discussions, not trivial fixes)
 *   - Top issues by comment count (feature debates, architectural questions)
 *   - CONTRIBUTING.md and MIGRATION.md (rationale for breaking changes)
 *
 * Differences from the generic seed-github.ts:
 *   - Sorted by comment count, not recency — surfaces decision discussions first
 *   - Filters out bot PRs, trivial bumps, and content-free events
 *   - Fetches and ingests docs alongside GitHub events
 *   - Prints Hono-specific suggested queries at the end
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... npm run seed:hono -w apps/api
 *
 * Without GITHUB_TOKEN: 60 req/hr — will work but may throttle on large fetches.
 * With GITHUB_TOKEN (public repo scope): 5000 req/hr — comfortable for full seed.
 *
 * Env:
 *   GITHUB_TOKEN   — recommended PAT (no special scopes needed for public repos)
 *   REDIS_URL      — default redis://localhost:6379
 *   API_BASE       — default http://localhost:3001 (for doc ingestion)
 *   BRAIN_API_KEY  — default dev-local
 *   MAX_PRS        — default 50
 *   MAX_ISSUES     — default 30
 *   MIN_COMMENTS   — default 3 (skip items with fewer comments)
 */
import "dotenv/config";
import { Redis } from "ioredis";
import type { CanonicalEvent, EventType } from "@purpl/types";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REDIS_URL    = process.env.REDIS_URL    ?? "redis://localhost:6379";
const API_BASE     = process.env.API_BASE     ?? "http://localhost:3001";
const API_KEY      = process.env.BRAIN_API_KEY ?? "dev-local";
const MAX_PRS      = parseInt(process.env.MAX_PRS    ?? "50");
const MAX_ISSUES   = parseInt(process.env.MAX_ISSUES ?? "30");
const MIN_COMMENTS = parseInt(process.env.MIN_COMMENTS ?? "3");

const REPO         = "honojs/hono";
const OWNER        = "honojs";
const NAME         = "hono";
const PROJECT_ID   = "honojs_hono";
const GITHUB_API   = "https://api.github.com";
const DELAY_MS     = 1500; // conservative — no token = 60 req/hr

// Bot accounts whose content adds no decision signal
const BOT_LOGINS = new Set([
  "dependabot[bot]", "dependabot", "renovate[bot]", "renovate",
  "github-actions[bot]", "github-actions", "changeset-bot[bot]",
  "allcontributors[bot]", "codecov[bot]", "codecov",
]);

// PR title prefixes that are never decision-rich
const TRIVIAL_PREFIXES = [
  "chore: bump", "chore(deps)", "fix: typo", "docs: fix typo",
  "ci: bump", "build: bump", "chore: update", "release:",
];

// ── GitHub API types ──────────────────────────────────────────────────────────

interface GHUser { login: string }

interface GHIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GHUser;
  created_at: string;
  closed_at: string | null;
  comments: number;
  pull_request?: { merged_at: string | null; url: string };
  state_reason?: string | null;
}

interface GHComment {
  id: number;
  body: string;
  user: GHUser;
  created_at: string;
  html_url: string;
}

interface GHPRDetail {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GHUser;
  created_at: string;
  merged_at: string | null;
  state: string;
  merged: boolean;
}

interface GHReview {
  id: number;
  body: string | null;
  user: GHUser;
  submitted_at: string;
  html_url: string;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function ghGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (GITHUB_TOKEN) headers["Authorization"] = `Bearer ${GITHUB_TOKEN}`;

  const res = await fetch(`${GITHUB_API}${path}`, { headers });

  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null && parseInt(remaining) < 10) {
    const reset = res.headers.get("x-ratelimit-reset");
    const waitMs = reset ? (parseInt(reset) * 1000 - Date.now()) + 2000 : 60_000;
    console.warn(`  [rate-limit] ${remaining} requests left — waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  if (!res.ok) throw new Error(`GitHub ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<T>;
}

async function fetchPages<T>(path: string, maxItems: number): Promise<T[]> {
  const results: T[] = [];
  let page = 1;
  while (results.length < maxItems) {
    const batch = await ghGet<T[]>(
      `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`
    );
    await sleep(DELAY_MS);
    results.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return results.slice(0, maxItems);
}

// ── Quality filters ───────────────────────────────────────────────────────────

function isBot(login: string): boolean {
  return BOT_LOGINS.has(login) || login.endsWith("[bot]");
}

function isTrivial(title: string): boolean {
  const lower = title.toLowerCase();
  return TRIVIAL_PREFIXES.some(p => lower.startsWith(p));
}

function hasSubstance(body: string | null): boolean {
  if (!body) return false;
  const stripped = body.replace(/<!--[\s\S]*?-->/g, "").trim();
  return stripped.length > 80;
}

// ── Thread consolidation ──────────────────────────────────────────────────────
// Push each PR / issue as a single consolidated event that includes the full
// discussion thread. This gives the extractor complete context and ensures the
// event is indexed in Qdrant even when individual comments lack decision language.

function consolidatedPREvent(
  pr: GHPRDetail,
  reviews: GHReview[],
  comments: GHComment[],
): CanonicalEvent {
  const eventType: EventType = pr.merged ? "pr_merged" : pr.state === "open" ? "pr_opened" : "pr_closed";

  const reviewLines = reviews
    .filter(r => r.body?.trim() && !isBot(r.user.login))
    .map(r => `${r.user.login} (review): ${r.body!.trim()}`);

  const commentLines = comments
    .filter(c => c.body?.trim() && !isBot(c.user.login))
    .map(c => `${c.user.login}: ${c.body.trim()}`);

  const threadSection = [...reviewLines, ...commentLines].length > 0
    ? `\n\n---\n\n${[...reviewLines, ...commentLines].join("\n\n")}`
    : "";

  const raw_content = [
    `PR #${pr.number}: ${pr.title}`,
    pr.body?.trim() ?? "",
    threadSection,
  ].filter(Boolean).join("\n\n");

  return {
    event_id: `hono_pr_${pr.number}`,
    source: "github",
    source_id: `${REPO}/pull/${pr.number}`,
    project_id: PROJECT_ID,
    actor: { type: "human", id: pr.user.login, name: pr.user.login },
    timestamp: pr.merged_at ?? pr.created_at,
    event_type: eventType,
    raw_content,
    url: pr.html_url,
  };
}

function consolidatedIssueEvent(
  issue: GHIssue,
  comments: GHComment[],
): CanonicalEvent {
  const commentLines = comments
    .filter(c => c.body?.trim() && !isBot(c.user.login))
    .map(c => `${c.user.login}: ${c.body.trim()}`);

  const threadSection = commentLines.length > 0
    ? `\n\n---\n\n${commentLines.join("\n\n")}`
    : "";

  const raw_content = [
    `Issue #${issue.number}: ${issue.title}`,
    issue.body?.trim() ?? "",
    threadSection,
  ].filter(Boolean).join("\n\n");

  return {
    event_id: `hono_issue_${issue.number}`,
    source: "github",
    source_id: `${REPO}/issues/${issue.number}`,
    project_id: PROJECT_ID,
    actor: { type: "human", id: issue.user.login, name: issue.user.login },
    timestamp: issue.closed_at ?? issue.created_at,
    event_type: "issue_created",
    raw_content,
    url: issue.html_url,
  };
}

// ── Redis queue ───────────────────────────────────────────────────────────────

async function enqueue(redis: Redis, event: CanonicalEvent, seen: Set<string>): Promise<boolean> {
  if (seen.has(event.event_id)) return false;
  if (!event.raw_content?.trim()) return false;

  const already = await redis.sismember("processed:event_ids", event.event_id);
  if (already) { seen.add(event.event_id); return false; }

  await redis.xadd("events:raw", "*", "event", JSON.stringify(event));
  await redis.sadd("processed:event_ids", event.event_id);
  seen.add(event.event_id);
  return true;
}

// ── Doc ingestion ─────────────────────────────────────────────────────────────

async function ingestDoc(path: string, title: string, type: "adr" | "runbook" | "unknown"): Promise<void> {
  const url = `https://raw.githubusercontent.com/${REPO}/main/${path}`;
  const res = await fetch(url);
  if (!res.ok) { console.log(`  [docs] skip ${path} — ${res.status}`); return; }
  const text = await res.text();
  if (text.trim().length < 100) return;

  const apiRes = await fetch(`${API_BASE}/brain/ingest/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({
      text,
      title,
      path,
      document_type: type,
      project_id: PROJECT_ID,
      source_url: `https://github.com/${REPO}/blob/main/${path}`,
    }),
  });
  if (!apiRes.ok) throw new Error(`ingest/document failed: ${apiRes.status} ${await apiRes.text()}`);
  const body = await apiRes.json() as { chunks_queued: number };
  console.log(`  [docs] ${title} — ${body.chunks_queued} chunk(s) queued`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n── seed-hono: Hono open-source project ingestion ─────────────\n");
  console.log(`  Repo       : ${REPO} (${await repoSummary()})`);
  console.log(`  Project ID : ${PROJECT_ID}`);
  console.log(`  Token      : ${GITHUB_TOKEN ? "set ✓" : "not set — 60 req/hr limit applies"}`);
  console.log(`  Targets    : top ${MAX_PRS} PRs + ${MAX_ISSUES} issues by comment count (min ${MIN_COMMENTS} comments)`);
  console.log(`  Redis      : ${REDIS_URL}\n`);

  if (!GITHUB_TOKEN) {
    console.warn("  WARN  GITHUB_TOKEN not set. Fetching large volumes may hit rate limits.");
    console.warn("        Set GITHUB_TOKEN=ghp_... for a PAT with no special scopes.\n");
  }

  // Verify API reachable
  try {
    const h = await fetch(`${API_BASE}/health`);
    if (!h.ok) throw new Error(`status ${h.status}`);
  } catch (e) {
    console.error(`  ERROR  Cannot reach ${API_BASE} — is the stack running?\n  ${(e as Error).message}`);
    process.exit(1);
  }

  const redis = new Redis(REDIS_URL);
  const seen = new Set<string>();
  let totalQueued = 0;
  let totalSkipped = 0;

  const track = (queued: boolean) => queued ? totalQueued++ : totalSkipped++;

  // ── 1. Docs ───────────────────────────────────────────────────────────────
  console.log("── Step 1/3: Ingesting docs ──\n");
  await ingestDoc("docs/CONTRIBUTING.md", "Hono Contributing Guide", "runbook");
  await ingestDoc("docs/MIGRATION.md", "Hono Migration Guide (breaking changes by version)", "adr");

  // ── 2. PRs sorted by comment count ───────────────────────────────────────
  console.log("\n── Step 2/3: Fetching PRs (sorted by discussion volume) ──\n");

  // GitHub Issues API returns both issues and PRs; sort=comments gives highest discussion first
  const allClosed = await fetchPages<GHIssue>(
    `/repos/${OWNER}/${NAME}/issues?state=closed&sort=comments&direction=desc`,
    500
  );

  const prItems = allClosed
    .filter(i => i.pull_request && i.comments >= MIN_COMMENTS && !isBot(i.user.login) && !isTrivial(i.title))
    .slice(0, MAX_PRS);

  const issueItems = allClosed
    .filter(i => !i.pull_request && i.comments >= MIN_COMMENTS && !isBot(i.user.login))
    .slice(0, MAX_ISSUES);

  console.log(`  Found ${prItems.length} qualifying PRs and ${issueItems.length} qualifying issues\n`);

  for (const stub of prItems) {
    const [pr, reviews, comments] = await Promise.all([
      ghGet<GHPRDetail>(`/repos/${OWNER}/${NAME}/pulls/${stub.number}`),
      ghGet<GHReview[]>(`/repos/${OWNER}/${NAME}/pulls/${stub.number}/reviews`),
      ghGet<GHComment[]>(`/repos/${OWNER}/${NAME}/issues/${stub.number}/comments`),
    ]);
    await sleep(DELAY_MS);

    const event = consolidatedPREvent(pr, reviews, comments);
    const substantive = [
      ...reviews.filter(r => r.body?.trim() && !isBot(r.user.login)),
      ...comments.filter(c => c.body?.trim() && !isBot(c.user.login)),
    ];

    track(await enqueue(redis, event, seen));
    console.log(`  PR #${pr.number} [${stub.comments} comments] ${pr.title.slice(0, 58)} → 1 thread event (${substantive.length} voices)`);
  }

  // ── 3. Issues sorted by comment count ────────────────────────────────────
  console.log(`\n── Step 3/3: Fetching issues ──\n`);

  for (const issue of issueItems) {
    const comments = await ghGet<GHComment[]>(`/repos/${OWNER}/${NAME}/issues/${issue.number}/comments`);
    await sleep(DELAY_MS);

    const event = consolidatedIssueEvent(issue, comments);
    const substantive = comments.filter(c => c.body?.trim() && !isBot(c.user.login));

    track(await enqueue(redis, event, seen));
    console.log(`  Issue #${issue.number} [${issue.comments} comments] ${issue.title.slice(0, 58)} → 1 thread event (${substantive.length} voices)`);
  }

  await redis.quit();

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n─────────────────────────────────────────────────────────────────`);
  console.log(`  Seed complete.\n`);
  console.log(`  Queued  : ${totalQueued} events`);
  console.log(`  Skipped : ${totalSkipped} (duplicates or no content)`);
  console.log(`  Project : ${PROJECT_ID}\n`);
  console.log(`  Pipeline will process events over the next ~2–5 minutes.`);
  console.log(`  (Ollama extraction runs on every event marked as a decision candidate)\n`);

  console.log("  ── Suggested queries ─────────────────────────────────────────\n");

  const queries = [
    ["Router design",        "Why does Hono use RegExpRouter instead of a trie-based router?"],
    ["Breaking change why",  "Why was app.head() changed to be implicit in v4?"],
    ["Feature decision",     "What did Yusuke decide about extending the Context object?"],
    ["URI decoding debate",  "What was decided about URI decoding in the router?"],
    ["Rejection",            "What middleware proposals were rejected and why?"],
    ["Migration rationale",  "Why did Hono move from deno.land/x to JSR?"],
    ["Author query",         "What architectural decisions has yusukebe made?"],
    ["Temporal diff",        "What changed in Hono's API design between v3 and v4?"],
    ["Scope decision",       "What was decided about TypeScript type inference in validators?"],
    ["Community debate",     "What was the most contested design decision in Hono's history?"],
  ];

  for (const [label, q] of queries) {
    console.log(`  ${label.padEnd(22)}  "${q}"`);
  }

  console.log(`\n  Once the pipeline settles, combine with the Orion Commerce demo`);
  console.log(`  (project_id=orion_commerce) to show agent write-back alongside`);
  console.log(`  the Hono real-world decision history.\n`);
  console.log(`─────────────────────────────────────────────────────────────────\n`);
}

async function repoSummary(): Promise<string> {
  try {
    const r = await ghGet<{ stargazers_count: number; open_issues_count: number }>(`/repos/${OWNER}/${NAME}`);
    return `⭐ ${r.stargazers_count.toLocaleString()} stars`;
  } catch { return ""; }
}

main().catch(e => {
  console.error("\nFatal:", e);
  process.exit(1);
});
