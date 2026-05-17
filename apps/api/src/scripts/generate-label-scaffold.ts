/**
 * Generates a labeling scaffold for M7 extraction eval.
 *
 * Reads all encode_httpx PR events + their associated review/comment events
 * from events:raw, then outputs two files:
 *
 *   eval/label-scaffold.json   — machine-readable, fill in has_decision + decisions
 *   eval/label-scaffold.md     — human-readable, one PR per section for reading
 *
 * Usage:
 *   tsx src/scripts/generate-label-scaffold.ts [--project encode_httpx]
 */

import "dotenv/config";
import { Redis } from "ioredis";
import { writeFileSync } from "fs";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

interface RawEvent {
  event_id: string;
  source_id: string;
  project_id: string;
  event_type: string;
  raw_content: string;
  url: string;
  actor: { id: string };
  timestamp: string;
}

// ── Label scaffold types ───────────────────────────────────────────────────────

export interface LabeledDecision {
  quoted_text: string; // exact text from PR/comment that is the decision
  summary: string;     // one-line paraphrase
}

export interface LabeledPR {
  pr_number: string;
  url: string;
  event_id: string;         // PR event_id — key for matching against extractor output
  pr_content: string;       // title + body
  context: Array<{          // reviews and comments on this PR
    event_id: string;
    event_type: string;
    actor: string;
    content: string;
    url: string;
  }>;
  // ── Fill these in ──────────────────────────────────────────────────────────
  has_decision: boolean | null;   // null = unlabeled
  decisions: LabeledDecision[];
}

// ── Read all events for a project from events:raw ─────────────────────────────

async function readAllEvents(redis: Redis, projectId: string): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  let lastId = "0";

  while (true) {
    const results = await redis.xrange("events:raw", lastId === "0" ? "-" : lastId, "+", "COUNT", 200);
    if (!results || results.length === 0) break;

    for (const [id, fields] of results as [string, string[]][]) {
      const eventIdx = fields.indexOf("event");
      if (eventIdx !== -1) {
        try {
          const evt = JSON.parse(fields[eventIdx + 1]) as RawEvent;
          if (evt.project_id === projectId) events.push(evt);
        } catch { /* skip malformed */ }
      }
      lastId = id;
    }

    // If we got less than 200, we've reached the end
    if ((results as unknown[]).length < 200) break;
    // Increment lastId by 1 to avoid re-reading the last entry
    const [ts, seq] = lastId.split("-").map(Number);
    lastId = `${ts}-${seq + 1}`;
  }

  return events;
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";

  const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

  console.log(`[scaffold] reading events for project: ${projectId}`);
  const allEvents = await readAllEvents(redis, projectId);
  await redis.quit();

  console.log(`[scaffold] found ${allEvents.length} total events`);

  // Group by PR number: PR event + its reviews/comments
  const prEvents = allEvents.filter((e) =>
    ["pr_opened", "pr_merged", "pr_closed"].includes(e.event_type)
  );
  const contextEvents = allEvents.filter((e) =>
    ["pr_review", "comment"].includes(e.event_type)
  );

  console.log(`[scaffold] ${prEvents.length} PRs, ${contextEvents.length} context events`);

  // Build scaffold entries
  const scaffold: LabeledPR[] = prEvents
    .sort((a, b) => Number(b.source_id) - Number(a.source_id)) // newest first
    .map((pr) => {
      const related = contextEvents.filter((e) => e.source_id === pr.source_id);
      return {
        pr_number: pr.source_id,
        url: pr.url,
        event_id: pr.event_id,
        pr_content: pr.raw_content,
        context: related.map((e) => ({
          event_id: e.event_id,
          event_type: e.event_type,
          actor: e.actor.id,
          content: e.raw_content,
          url: e.url,
        })),
        has_decision: null,
        decisions: [],
      };
    });

  // Write JSON scaffold
  const jsonPath = resolve(REPO_ROOT, "eval/label-scaffold.json");
  writeFileSync(jsonPath, JSON.stringify(scaffold, null, 2));
  console.log(`[scaffold] wrote ${jsonPath}`);

  // Write markdown for reading
  const mdLines: string[] = [
    "# Labeling Scaffold — encode/httpx PRs",
    "",
    "For each PR below, decide:",
    "1. Does the PR (or its reviews/comments) contain a **decision**?",
    "   A decision = a choice made with rationale: technology, approach, API design, deliberate trade-off.",
    "   Bug fixes and refactors without design discussion are NOT decisions.",
    "2. If yes, what is the decision? Record it in `label-scaffold.json`:",
    "   - `has_decision: true`",
    "   - `decisions: [{ quoted_text: \"...\", summary: \"...\" }]`",
    "",
    "---",
    "",
  ];

  for (const pr of scaffold) {
    mdLines.push(`## PR #${pr.pr_number} — ${pr.url}`);
    mdLines.push(`**event_id:** \`${pr.event_id}\``);
    mdLines.push("");
    mdLines.push("### PR content");
    mdLines.push("```");
    mdLines.push(pr.pr_content.slice(0, 1200) + (pr.pr_content.length > 1200 ? "\n[truncated]" : ""));
    mdLines.push("```");

    if (pr.context.length > 0) {
      mdLines.push("");
      mdLines.push(`### Reviews / comments (${pr.context.length})`);
      for (const ctx of pr.context) {
        mdLines.push(`**${ctx.actor}** (${ctx.event_type}):`);
        mdLines.push("```");
        mdLines.push(ctx.content.slice(0, 600) + (ctx.content.length > 600 ? "\n[truncated]" : ""));
        mdLines.push("```");
      }
    }

    mdLines.push("");
    mdLines.push("**Label:** `has_decision:` ___  `decisions:` ___");
    mdLines.push("");
    mdLines.push("---");
    mdLines.push("");
  }

  const mdPath = resolve(REPO_ROOT, "eval/label-scaffold.md");
  writeFileSync(mdPath, mdLines.join("\n"));
  console.log(`[scaffold] wrote ${mdPath}`);
  console.log(`[scaffold] ${scaffold.length} PRs ready to label`);
}

run().catch((e) => {
  console.error("[scaffold] fatal:", e);
  process.exit(1);
});
