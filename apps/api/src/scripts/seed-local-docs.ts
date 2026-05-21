/**
 * seed-local-docs — ingest local markdown files into the brain
 *
 * Reads .md files from a local directory (recursively) and queues them as
 * document events into the RAW stream. Designed for ingesting a project's own
 * docs/ folder without needing GitHub API access.
 *
 * Attribution strategy (per Opus review):
 *   ADRs (path contains /adrs/)  → first-commit author via `git log --diff-filter=A`
 *   All other docs               → actor.type="collective", contributors[] from git log
 *
 * Usage:
 *   npm run seed:local-docs -w apps/api -- --dir ../../docs --project skalrn_purpl_brain
 *   npm run seed:local-docs -w apps/api -- --dir ../../docs --project skalrn_purpl_brain --force
 *   npm run seed:local-docs -w apps/api -- --dir ../../docs --project skalrn_purpl_brain \
 *     --base-url https://github.com/skalrn/purpl_brain/blob/main/docs
 *
 * --force  re-ingests files even if previously processed.
 * --base-url  URL prefix for citations. If omitted, uses file://<abs-path>.
 *             For GitHub: https://github.com/org/repo/blob/main/docs
 * --git-root  root of the git repo (default: two levels up from --dir, or cwd)
 */
import "dotenv/config";
import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, join, dirname } from "path";
import { execSync } from "child_process";
import { redis, STREAMS, PROCESSED_SET } from "../lib/redis.js";
import type { CanonicalEvent } from "@purpl/types";

const args = process.argv.slice(2);
const get = (flag: string) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : undefined;
};

const dirArg = get("--dir");
const projectId = get("--project");
const baseUrl = get("--base-url");
const gitRootArg = get("--git-root");
const force = args.includes("--force");

if (!dirArg || !projectId) {
  console.error(
    "Usage: seed-local-docs --dir <path> --project <project_id> " +
    "[--base-url <url>] [--git-root <path>] [--force]"
  );
  process.exit(1);
}

const rootDir = resolve(dirArg);
const gitRoot = gitRootArg ? resolve(gitRootArg) : (() => {
  try {
    return execSync("git rev-parse --show-toplevel", { cwd: rootDir, encoding: "utf-8" }).trim();
  } catch {
    return process.cwd();
  }
})();

// ── Git helpers ───────────────────────────────────────────────────────────────

function gitFirstAuthor(filePath: string): string | null {
  try {
    // --diff-filter=A: only the commit that Added the file
    const out = execSync(
      `git log --diff-filter=A --follow --format="%aN" -- "${filePath}"`,
      { cwd: gitRoot, encoding: "utf-8" }
    ).trim();
    return out.split("\n")[0] || null;
  } catch {
    return null;
  }
}

function gitAllAuthors(filePath: string): string[] {
  try {
    const out = execSync(
      `git log --follow --format="%aN" -- "${filePath}"`,
      { cwd: gitRoot, encoding: "utf-8" }
    ).trim();
    if (!out) return [];
    return [...new Set(out.split("\n").filter(Boolean))];
  } catch {
    return [];
  }
}

// ── File collection ───────────────────────────────────────────────────────────

function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
}

type DocumentType = "adr" | "architecture" | "prd" | "runbook" | "demo" | "pitch" | "review" | "unknown";

// Ordered rule table — first match wins. Each entry is [pattern, type].
// Pattern is tested against the lowercased, forward-slash-normalized relative path.
//
// These are the shipped defaults. The long-term design is for projects to store
// their own rule table in Neo4j (overriding these defaults), so teams with
// non-standard folder conventions can configure once via API rather than
// touching every doc. See open todo #DOC-5.
const PATH_RULES: Array<[RegExp, DocumentType]> = [
  [/(?:^|\/)adrs?\//, "adr"],
  [/(?:^|\/)demos?\//, "demo"],
  [/(?:^|\/)(?:pitch|sales|interview)\//, "pitch"],
  [/(?:^|\/)(?:review|retro(?:spective)?)\/|risk-register/, "review"],
  [/(?:^|\/)(?:runbook|ops)\/|onboarding|setup/, "runbook"],
  [/(?:^|\/)(?:technical|design)\/|implementation-plan/, "architecture"],
  [/(?:^|\/)product\/|\/prd\b|roadmap|vision|personas|requirements/, "prd"],
];

function classifyDocumentType(relPath: string): DocumentType {
  const p = relPath.replace(/\\/g, "/").toLowerCase();
  return PATH_RULES.find(([re]) => re.test(p))?.[1] ?? "unknown";
}

// Authoritative doc types produce decisions that belong to this project.
// Non-authoritative types (demo, pitch, review, unknown) reference other
// projects or hypothetical scenarios and must not feed decision extraction.
const AUTHORITATIVE_DOC_TYPES: Set<DocumentType> = new Set(["adr", "architecture", "prd", "runbook"]);

// ── Main ──────────────────────────────────────────────────────────────────────

const files = collectMarkdownFiles(rootDir);
if (files.length === 0) {
  console.log(`No .md files found in ${rootDir}`);
  await redis.quit();
  process.exit(0);
}

console.log(`Found ${files.length} markdown file(s) in ${rootDir}`);
console.log(`Git root: ${gitRoot}`);
if (force) console.log("--force: re-ingesting all files");

let queued = 0;
let skipped = 0;

for (const filePath of files) {
  const relPath = relative(rootDir, filePath);
  const sourceId = `local_doc:${projectId}:${relPath}`;

  const alreadyProcessed = !force && await redis.sismember(PROCESSED_SET, sourceId);
  if (alreadyProcessed) {
    skipped++;
    continue;
  }

  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) {
    console.log(`  skip (empty): ${relPath}`);
    continue;
  }

  // Extract title from first H1, fall back to filename
  const h1Match = content.match(/^#\s+(.+)$/m);
  const title = h1Match ? h1Match[1].trim() : relPath;

  const url = baseUrl
    ? `${baseUrl.replace(/\/$/, "")}/${relPath}`
    : `file://${filePath}`;

  const docType = classifyDocumentType(relPath);
  const isAuthoritative = AUTHORITATIVE_DOC_TYPES.has(docType);

  // Attribution: authoritative docs with a single clear author (ADRs, runbooks)
  // get first-commit author; collaborative/non-authoritative docs get collective.
  let actor: CanonicalEvent["actor"];
  let contributors: string[] | undefined;

  if (docType === "adr" || docType === "runbook") {
    const firstAuthor = gitFirstAuthor(filePath);
    actor = {
      type: firstAuthor ? "human" : "collective",
      id: firstAuthor ?? "team",
      name: firstAuthor ?? "team",
    };
    const allAuthors = gitAllAuthors(filePath);
    if (allAuthors.length > 1) contributors = allAuthors;
  } else {
    const allAuthors = gitAllAuthors(filePath);
    actor = {
      type: "collective",
      id: "team",
      name: allAuthors.length > 0 ? allAuthors.join(", ") : "team",
    };
    if (allAuthors.length > 0) contributors = allAuthors;
  }

  const event: CanonicalEvent = {
    event_id: `doc_${slugify(relPath)}_${Date.now()}`,
    source: "document",
    source_id: sourceId,
    project_id: projectId,
    actor,
    timestamp: new Date().toISOString(),
    event_type: "document_chunk",
    raw_content: content,
    url,
    document_title: title,
    document_path: relPath,
    document_type: docType,
    ...(contributors ? { document_contributors: contributors } : {}),
  };

  await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
  await redis.sadd(PROCESSED_SET, sourceId);
  queued++;

  const authLabel = isAuthoritative ? docType : `${docType} [skip extraction]`;
  const attribution = (docType === "adr" || docType === "runbook")
    ? `${authLabel} → ${actor.name}${contributors && contributors.length > 1 ? ` (+${contributors.length - 1} contributors)` : ""}`
    : `${authLabel} → ${contributors?.slice(0, 3).join(", ") ?? "team"}${contributors && contributors.length > 3 ? ` +${contributors.length - 3} more` : ""}`;
  console.log(`  ✓ ${relPath}  [${attribution}]`);
}

console.log(`\nDone.`);
console.log(`  ${queued} file(s) queued`);
if (skipped > 0) console.log(`  ${skipped} file(s) skipped (use --force to re-ingest)`);

await redis.quit();
