/**
 * GitHub historical seeder — pulls past PRs/issues from a public (or private) repo
 * and injects them into events:raw as CanonicalEvents, bypassing the webhook.
 *
 * Usage:
 *   tsx src/scripts/seed-github.ts --repo encode/httpx [--limit 30] [--issues]
 *
 * Env:
 *   GITHUB_TOKEN  — optional PAT. Without it: 60 req/hr (will throttle on >20 PRs)
 *   REDIS_URL     — default redis://localhost:6379
 */

import "dotenv/config";
import { Redis } from "ioredis";
import { STREAMS, PROCESSED_SET } from "../../lib/redis.js";
import type { CanonicalEvent, EventType } from "@purpl/types";

// ── GitHub API types (minimal subset we use) ──────────────────────────────────

interface GitHubUser {
  login: string;
}

interface GitHubPR {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GitHubUser;
  created_at: string;
  merged_at: string | null;
  state: "open" | "closed";
  merged: boolean;
}

interface GitHubReview {
  id: number;
  body: string | null;
  user: GitHubUser;
  submitted_at: string;
  html_url: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GitHubUser;
  created_at: string;
  pull_request?: unknown; // present when issue is a PR — skip these
}

interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  created_at: string;
  html_url: string;
}

// ── GitHub API client ──────────────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const REQUEST_DELAY_MS = 150; // stay well inside rate limits

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function githubGet<T>(path: string, token?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}${path}`, { headers });

  const remaining = res.headers.get("x-ratelimit-remaining");
  if (remaining !== null && parseInt(remaining) < 5) {
    const reset = res.headers.get("x-ratelimit-reset");
    const waitMs = reset ? (parseInt(reset) * 1000 - Date.now()) + 1000 : 60_000;
    console.warn(`[seeder] rate limit nearly exhausted — waiting ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API ${res.status} on ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

async function fetchAllPages<T>(
  basePath: string,
  token: string | undefined,
  maxItems: number
): Promise<T[]> {
  const results: T[] = [];
  let page = 1;

  while (results.length < maxItems) {
    const perPage = Math.min(100, maxItems - results.length);
    const items = await githubGet<T[]>(
      `${basePath}${basePath.includes("?") ? "&" : "?"}per_page=${perPage}&page=${page}`,
      token
    );
    await sleep(REQUEST_DELAY_MS);

    results.push(...items);
    if (items.length < perPage) break; // last page
    page++;
  }

  return results.slice(0, maxItems);
}

// ── CanonicalEvent builders ────────────────────────────────────────────────────

function prToEvent(pr: GitHubPR, projectId: string): CanonicalEvent {
  let eventType: EventType;
  if (pr.state === "open") {
    eventType = "pr_opened";
  } else if (pr.merged) {
    eventType = "pr_merged";
  } else {
    eventType = "pr_closed";
  }

  return {
    event_id: `seed_pr_${pr.number}`,
    source: "github",
    source_id: String(pr.number),
    project_id: projectId,
    actor: { type: "human", id: pr.user.login, name: pr.user.login },
    timestamp: pr.merged_at ?? pr.created_at,
    event_type: eventType,
    raw_content: [pr.title, pr.body].filter(Boolean).join("\n\n"),
    url: pr.html_url,
  };
}

function reviewToEvent(
  review: GitHubReview,
  prNumber: number,
  prUrl: string,
  projectId: string
): CanonicalEvent {
  return {
    event_id: `seed_review_${review.id}`,
    source: "github",
    source_id: String(prNumber),
    project_id: projectId,
    actor: { type: "human", id: review.user.login, name: review.user.login },
    timestamp: review.submitted_at,
    event_type: "pr_review",
    raw_content: review.body ?? "",
    url: review.html_url ?? prUrl,
  };
}

function issueToEvent(issue: GitHubIssue, projectId: string): CanonicalEvent {
  return {
    event_id: `seed_issue_${issue.number}`,
    source: "github",
    source_id: String(issue.number),
    project_id: projectId,
    actor: { type: "human", id: issue.user.login, name: issue.user.login },
    timestamp: issue.created_at,
    event_type: "issue_created",
    raw_content: [issue.title, issue.body].filter(Boolean).join("\n\n"),
    url: issue.html_url,
  };
}

function issueCommentToEvent(
  comment: GitHubComment,
  issueNumber: number,
  projectId: string
): CanonicalEvent {
  return {
    event_id: `seed_comment_${comment.id}`,
    source: "github",
    source_id: String(issueNumber),
    project_id: projectId,
    actor: { type: "human", id: comment.user.login, name: comment.user.login },
    timestamp: comment.created_at,
    event_type: "comment",
    raw_content: comment.body,
    url: comment.html_url,
  };
}

// ── Seeder core ────────────────────────────────────────────────────────────────

async function enqueue(redis: Redis, event: CanonicalEvent): Promise<boolean> {
  const alreadyProcessed = await redis.sismember(PROCESSED_SET, event.event_id);
  if (alreadyProcessed) return false;

  await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event), "source", "seed");
  await redis.sadd(PROCESSED_SET, event.event_id);
  return true;
}

async function seed(
  repo: string,
  opts: { limit: number; includeIssues: boolean; token?: string }
) {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`Invalid repo format. Expected owner/repo, got: ${repo}`);

  const projectId = `${owner}_${name}`;
  const { limit, includeIssues, token } = opts;

  if (!token) {
    console.warn(
      "[seeder] GITHUB_TOKEN not set — using unauthenticated (60 req/hr). " +
        "This will throttle on repos with many review comments. Set GITHUB_TOKEN for reliable seeding."
    );
  }

  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

  let totalEnqueued = 0;
  let totalSkipped = 0;

  // ── PRs ───────────────────────────────────────────────────────────────────

  console.log(`[seeder] fetching up to ${limit} merged PRs from ${repo}...`);
  const prs = await fetchAllPages<GitHubPR>(
    `/repos/${owner}/${name}/pulls?state=closed&sort=updated&direction=desc`,
    token,
    limit
  );

  console.log(`[seeder] fetched ${prs.length} PRs`);

  for (const pr of prs) {
    // Enqueue the PR itself
    const prEvent = prToEvent(pr, projectId);
    const queued = await enqueue(redis, prEvent);
    queued ? totalEnqueued++ : totalSkipped++;

    // Enqueue PR reviews (skip reviews with no body — pure approvals add no signal)
    const reviews = await githubGet<GitHubReview[]>(
      `/repos/${owner}/${name}/pulls/${pr.number}/reviews`,
      token
    );
    await sleep(REQUEST_DELAY_MS);

    for (const review of reviews) {
      if (!review.body?.trim()) continue;
      const reviewEvent = reviewToEvent(review, pr.number, pr.html_url, projectId);
      const q = await enqueue(redis, reviewEvent);
      q ? totalEnqueued++ : totalSkipped++;
    }

    // Enqueue PR issue comments (discussion threads on the PR, not inline code comments)
    const comments = await githubGet<GitHubComment[]>(
      `/repos/${owner}/${name}/issues/${pr.number}/comments`,
      token
    );
    await sleep(REQUEST_DELAY_MS);

    for (const comment of comments) {
      if (!comment.body?.trim()) continue;
      const commentEvent = issueCommentToEvent(comment, pr.number, projectId);
      const q = await enqueue(redis, commentEvent);
      q ? totalEnqueued++ : totalSkipped++;
    }

    console.log(
      `[seeder] PR #${pr.number} — enqueued PR + ${reviews.filter((r) => r.body?.trim()).length} reviews + ${comments.filter((c) => c.body?.trim()).length} comments`
    );
  }

  // ── Issues ─────────────────────────────────────────────────────────────────

  if (includeIssues) {
    console.log(`[seeder] fetching up to ${limit} issues from ${repo}...`);
    const allIssues = await fetchAllPages<GitHubIssue>(
      `/repos/${owner}/${name}/issues?state=closed&sort=updated&direction=desc`,
      token,
      limit
    );

    // GitHub's /issues endpoint includes PRs — filter them out
    const issues = allIssues.filter((i) => !i.pull_request);
    console.log(`[seeder] fetched ${issues.length} issues (filtered out PRs)`);

    for (const issue of issues) {
      const issueEvent = issueToEvent(issue, projectId);
      const queued = await enqueue(redis, issueEvent);
      queued ? totalEnqueued++ : totalSkipped++;

      const comments = await githubGet<GitHubComment[]>(
        `/repos/${owner}/${name}/issues/${issue.number}/comments`,
        token
      );
      await sleep(REQUEST_DELAY_MS);

      for (const comment of comments) {
        if (!comment.body?.trim()) continue;
        const commentEvent = issueCommentToEvent(comment, issue.number, projectId);
        const q = await enqueue(redis, commentEvent);
        q ? totalEnqueued++ : totalSkipped++;
      }

      console.log(
        `[seeder] Issue #${issue.number} — enqueued + ${comments.filter((c) => c.body?.trim()).length} comments`
      );
    }
  }

  await redis.quit();

  console.log(
    `\n[seeder] done. project_id="${projectId}" enqueued=${totalEnqueued} skipped_duplicates=${totalSkipped}`
  );
  console.log(`[seeder] pipeline will process events:raw → normalized → extracted → brain store`);
}

// ── CLI entry point ────────────────────────────────────────────────────────────

function parseArgs(): { repo: string; limit: number; includeIssues: boolean } {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const repo = get("--repo");
  if (!repo) {
    console.error("Usage: tsx src/scripts/seed-github.ts --repo owner/repo [--limit 30] [--issues]");
    process.exit(1);
  }

  const limitRaw = get("--limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : 30;
  if (isNaN(limit) || limit < 1) {
    console.error("--limit must be a positive integer");
    process.exit(1);
  }

  const includeIssues = args.includes("--issues");
  return { repo, limit, includeIssues };
}

const { repo, limit, includeIssues } = parseArgs();

seed(repo, {
  limit,
  includeIssues,
  token: process.env.GITHUB_TOKEN,
}).catch((e) => {
  console.error("[seeder] fatal:", e);
  process.exit(1);
});
