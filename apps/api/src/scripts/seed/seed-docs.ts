/**
 * seed-docs — crawl docs/**\/*.md from a GitHub repo and ingest into the brain
 *
 * Usage:
 *   npm run seed:docs -w apps/api -- --repo encode/httpx --project encode_httpx
 *   npm run seed:docs -w apps/api -- --repo encode/httpx --project encode_httpx --prefix docs
 *
 * Requires GITHUB_TOKEN in env (or apps/api/.env)
 */
import "dotenv/config";
import { crawlRepoDocs } from "../../lib/github-doc-crawler.js";
import { redis, STREAMS, PROCESSED_SET } from "../../lib/redis.js";

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const repo = get("--repo");
const projectId = get("--project") ?? get("--repo")?.replace("/", "_");
const pathPrefix = get("--prefix") ?? "docs";
const force = args.includes("--force");

if (!repo) {
  console.error("Usage: seed-docs --repo org/repo [--project project_id] [--prefix docs] [--force]");
  process.exit(1);
}

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

console.log(`Crawling ${pathPrefix}/**/*.md from ${repo} → project: ${projectId}`);
if (force) console.log("--force: skipping dedup check, re-ingesting all files");

const events = await crawlRepoDocs(token, repo, projectId!, pathPrefix);

if (events.length === 0) {
  console.log(`No .md files found under ${pathPrefix}/ in ${repo}`);
  await redis.quit();
  process.exit(0);
}

let queued = 0;
let skipped = 0;

const uniqueSourceIds = [...new Set(events.map((e) => e.source_id))];

for (const sourceId of uniqueSourceIds) {
  const alreadyProcessed = !force && await redis.sismember(PROCESSED_SET, sourceId);
  if (alreadyProcessed) {
    skipped++;
    continue;
  }

  const fileEvents = events.filter((e) => e.source_id === sourceId);
  for (const event of fileEvents) {
    await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
    queued++;
  }
  await redis.sadd(PROCESSED_SET, sourceId);
}

console.log(`\nDone. ${uniqueSourceIds.length} files processed:`);
console.log(`  ${queued} chunk(s) queued`);
if (skipped > 0) console.log(`  ${skipped} file(s) skipped (already ingested — use --force to re-ingest)`);

await redis.quit();
