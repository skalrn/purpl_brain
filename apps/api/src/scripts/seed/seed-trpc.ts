/**
 * seed-trpc — ingest the tRPC project into the brain
 *
 * Targets decision-rich content from the trpc/trpc public GitHub repo:
 *   - Top PRs by comment count (design discussions, API decisions)
 *   - Top issues by comment count (breaking change debates, v9→v10 migration)
 *   - Migration docs and CHANGELOG (temporal decision trail)
 *
 * Why tRPC is a strong eval corpus for purpl-brain:
 *   - v9→v10 was a complete API redesign with documented rationale — the procedure
 *     API, middleware chaining, and transformer handling all changed in ways that
 *     create real temporal contradictions (v9 pattern explicitly deprecated in v10)
 *   - Type inference story evolved across versions — testable with temporal queries
 *   - Small focused team means decisions are attributable and traceable
 *
 * Usage:
 *   GITHUB_TOKEN=ghp_... npm run seed:trpc -w apps/api
 *
 * Env:
 *   GITHUB_TOKEN   — recommended PAT (public repo scope, no special permissions)
 *   REDIS_URL      — default redis://localhost:6379
 *   API_BASE       — default http://localhost:3741
 *   BRAIN_API_KEY  — default dev-local
 *   MAX_PRS        — default 60
 *   MAX_ISSUES     — default 40
 *   MIN_COMMENTS   — default 2
 */
import "dotenv/config";
import { Redis } from "ioredis";
import type { CanonicalEvent, EventType } from "@purpl/types";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REDIS_URL    = process.env.REDIS_URL    ?? "redis://localhost:6379";
const API_BASE     = process.env.API_BASE     ?? "http://localhost:3741";
const API_KEY      = process.env.BRAIN_API_KEY ?? "dev-local";
const MAX_PRS      = parseInt(process.env.MAX_PRS    ?? "60");
const MAX_ISSUES   = parseInt(process.env.MAX_ISSUES ?? "40");
const MIN_COMMENTS = parseInt(process.env.MIN_COMMENTS ?? "2");

const REPO       = "trpc/trpc";
const OWNER      = "trpc";
const NAME       = "trpc";
const PROJECT_ID = "trpc_trpc";
const GITHUB_API = "https://api.github.com";
const DELAY_MS   = 1500;

const BOT_LOGINS = new Set([
  "dependabot[bot]", "dependabot", "renovate[bot]", "renovate",
  "github-actions[bot]", "github-actions", "changeset-bot[bot]",
  "allcontributors[bot]", "codecov[bot]", "codecov",
  "stale[bot]",
]);

const TRIVIAL_PREFIXES = [
  "chore: bump", "chore(deps)", "fix: typo", "docs: fix typo",
  "ci: bump", "build: bump", "chore: update", "release:", "version:",
];

// Labels that indicate design-decision content — prioritise these
const DECISION_LABELS = new Set([
  "breaking change", "breaking-change", "RFC", "api-design",
  "v10", "v11", "migration", "discussion",
]);

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
  labels?: Array<{ name: string }>;
  pull_request?: { merged_at: string | null; url: string };
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
  labels?: Array<{ name: string }>;
}

interface GHReview {
  id: number;
  body: string | null;
  user: GHUser;
  submitted_at: string;
  html_url: string;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function isBot(login: string) { return BOT_LOGINS.has(login) || login.endsWith("[bot]"); }
function isTrivial(title: string) {
  const lower = title.toLowerCase();
  return TRIVIAL_PREFIXES.some(p => lower.startsWith(p));
}
function hasSubstance(body: string | null) {
  if (!body) return false;
  return body.replace(/<!--[\s\S]*?-->/g, "").trim().length > 80;
}
function hasDecisionLabel(labels?: Array<{ name: string }>) {
  return labels?.some(l => DECISION_LABELS.has(l.name.toLowerCase())) ?? false;
}

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
    const batch = await ghGet<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    await sleep(DELAY_MS);
    results.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return results.slice(0, maxItems);
}

async function repoSummary(): Promise<string> {
  try {
    const r = await ghGet<{ stargazers_count: number; open_issues_count: number }>(
      `/repos/${REPO}`
    );
    return `${r.stargazers_count.toLocaleString()} stars, ${r.open_issues_count.toLocaleString()} open issues`;
  } catch { return "stats unavailable"; }
}

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
    event_id: `trpc_pr_${pr.number}`,
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

function consolidatedIssueEvent(issue: GHIssue, comments: GHComment[]): CanonicalEvent {
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
    event_id: `trpc_issue_${issue.number}`,
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

async function ingestDoc(path: string, title: string, type: "adr" | "runbook" | "unknown"): Promise<void> {
  const url = `https://raw.githubusercontent.com/${REPO}/main/${path}`;
  const res = await fetch(url);
  if (!res.ok) { console.log(`  [docs] skip ${path} (${res.status})`); return; }
  const text = await res.text();
  if (text.trim().length < 100) return;
  const apiRes = await fetch(`${API_BASE}/brain/ingest/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify({ text, title, path, document_type: type, project_id: PROJECT_ID,
      source_url: `https://github.com/${REPO}/blob/main/${path}` }),
  });
  if (!apiRes.ok) throw new Error(`ingest/document failed: ${apiRes.status}`);
  const body = await apiRes.json() as { chunks_queued: number };
  console.log(`  [docs] ${title} — ${body.chunks_queued} chunk(s) queued`);
}

async function main() {
  console.log("\n── seed-trpc: tRPC project ingestion ──────────────────────────\n");
  console.log(`  Repo       : ${REPO} (${await repoSummary()})`);
  console.log(`  Project ID : ${PROJECT_ID}`);
  console.log(`  Token      : ${GITHUB_TOKEN ? "set ✓" : "not set — 60 req/hr limit applies"}`);
  console.log(`  Targets    : top ${MAX_PRS} PRs + ${MAX_ISSUES} issues by comment count (min ${MIN_COMMENTS})`);
  console.log(`  Redis      : ${REDIS_URL}\n`);

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

  // ── Docs: migration guides and concept docs ───────────────────────────────────
  // Highest-value docs for temporal reasoning: migration guides explicitly document
  // what changed between versions, why, and what patterns were superseded.
  console.log("── Phase 1: migration docs ──");
  const docs: Array<[string, string, "adr" | "runbook" | "unknown"]> = [
    ["www/versioned_docs/version-10.x/migration/migrate-from-v9-to-v10.mdx", "v9 to v10 migration guide", "adr"],
    ["www/versioned_docs/version-10.x/server/procedures.mdx", "tRPC v10 procedures", "adr"],
    ["www/versioned_docs/version-10.x/server/middlewares.mdx", "tRPC v10 middlewares", "adr"],
    ["www/versioned_docs/version-10.x/server/router.mdx", "tRPC v10 router", "adr"],
    ["www/versioned_docs/version-9.x/router.mdx", "tRPC v9 router (superseded)", "adr"],
    ["www/versioned_docs/version-9.x/middlewares.mdx", "tRPC v9 middlewares (superseded)", "adr"],
    ["www/docs/further/rpc.mdx", "tRPC RPC concepts", "unknown"],
    ["CONTRIBUTING.md", "CONTRIBUTING", "unknown"],
  ];
  for (const [path, title, type] of docs) {
    await ingestDoc(path, title, type);
    await sleep(500);
  }

  // ── PRs: top by comment count via issues endpoint (includes comment counts) ───
  console.log("\n── Phase 2: PRs ──");
  // The /issues endpoint returns both issues and PRs; filter by pull_request field.
  // Sorted by comment count descending — surfaces design discussions first.
  const allItems = await fetchPages<GHIssue>(
    `/repos/${REPO}/issues?state=closed&sort=comments&direction=desc`, MAX_PRS * 3
  );

  const candidatePRs = allItems
    .filter(i => i.pull_request && !isBot(i.user.login) && !isTrivial(i.title) && i.comments >= MIN_COMMENTS)
    .sort((a, b) => {
      const aBoost = hasDecisionLabel(a.labels) ? 5 : 0;
      const bBoost = hasDecisionLabel(b.labels) ? 5 : 0;
      return (b.comments + bBoost) - (a.comments + aBoost);
    })
    .slice(0, MAX_PRS);

  console.log(`  Fetching details for ${candidatePRs.length} PRs...`);
  for (const pr of candidatePRs) {
    try {
      const [detail, reviews, comments] = await Promise.all([
        ghGet<GHPRDetail>(`/repos/${REPO}/pulls/${pr.number}`),
        ghGet<GHReview[]>(`/repos/${REPO}/pulls/${pr.number}/reviews`),
        ghGet<GHComment[]>(`/repos/${REPO}/issues/${pr.number}/comments`),
      ]);
      await sleep(DELAY_MS);
      if (!hasSubstance(detail.body) && reviews.length === 0 && comments.length === 0) continue;
      const event = consolidatedPREvent(detail, reviews, comments);
      track(await enqueue(redis, event, seen));
      process.stdout.write(".");
    } catch (e) {
      console.warn(`  [warn] PR #${pr.number}: ${(e as Error).message}`);
    }
  }
  console.log(`\n  PRs: ${totalQueued} queued, ${totalSkipped} skipped\n`);

  // ── Issues: top by comment count ──────────────────────────────────────────────
  console.log("── Phase 3: issues ──");
  const queuedAfterPRs = totalQueued;

  // Re-use allItems (already sorted by comments desc) — just exclude PRs
  const candidateIssues = allItems
    .filter(i => !i.pull_request && !isBot(i.user.login) && i.comments >= MIN_COMMENTS)
    .sort((a, b) => {
      const aBoost = hasDecisionLabel(a.labels) ? 5 : 0;
      const bBoost = hasDecisionLabel(b.labels) ? 5 : 0;
      return (b.comments + bBoost) - (a.comments + aBoost);
    })
    .slice(0, MAX_ISSUES);

  console.log(`  Fetching details for ${candidateIssues.length} issues...`);
  for (const issue of candidateIssues) {
    try {
      const comments = await ghGet<GHComment[]>(`/repos/${REPO}/issues/${issue.number}/comments`);
      await sleep(DELAY_MS);
      if (!hasSubstance(issue.body) && comments.length === 0) continue;
      const event = consolidatedIssueEvent(issue, comments);
      track(await enqueue(redis, event, seen));
      process.stdout.write(".");
    } catch (e) {
      console.warn(`  [warn] issue #${issue.number}: ${(e as Error).message}`);
    }
  }
  console.log(`\n  Issues: ${totalQueued - queuedAfterPRs} queued\n`);

  redis.disconnect();

  console.log("── Done ─────────────────────────────────────────────────────────");
  console.log(`  Total queued : ${totalQueued}`);
  console.log(`  Total skipped: ${totalSkipped}`);
  console.log(`  Project ID   : ${PROJECT_ID}\n`);
  console.log(`  Pipeline (LLM extraction) runs async. Wait 3-5 min before querying.`);
  console.log(`  Run the eval: npm run eval:trpc-baseline -w apps/api\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
