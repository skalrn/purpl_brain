/**
 * label-prs — blind human labeling tool for the extraction eval scaffold
 *
 * Shows raw PR content with NO prior labels, NO Claude suggestions.
 * You read, you decide. Saves incrementally so you can resume.
 *
 * Usage:
 *   tsx src/scripts/label-prs.ts                     # label all unlabeled PRs
 *   tsx src/scripts/label-prs.ts --reset             # clear all labels, start fresh
 *   tsx src/scripts/label-prs.ts --review            # re-read your labels, no editing
 *   tsx src/scripts/label-prs.ts --export            # overwrite label-scaffold.json with v2
 *
 * Output: eval/label-scaffold-v2.json (never touches the original until --export)
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import { resolve } from "path";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const SOURCE_FILE  = resolve(REPO_ROOT, "eval/label-scaffold.json");
const OUTPUT_FILE  = resolve(REPO_ROOT, "eval/label-scaffold-v2.json");
const BACKUP_FILE  = resolve(REPO_ROOT, "eval/label-scaffold.backup.json");

// ── Types ──────────────────────────────────────────────────────────────────────

interface SourcePR {
  pr_number: string;
  url: string;
  event_id: string;
  pr_content: string;
  context: Array<{
    event_id: string;
    event_type: string;
    actor: string;
    content: string;
    url: string;
  }>;
  // Ignored during labeling — present in source but hidden from labeler
  has_decision?: boolean | null;
  decisions?: unknown[];
}

interface LabeledDecision {
  quoted_text: string;
  summary: string;
}

interface LabeledPR {
  pr_number: string;
  url: string;
  event_id: string;
  pr_content: string;
  context: SourcePR["context"];
  has_decision: boolean | null;
  decisions: LabeledDecision[];
  labeled_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function hr(char = "─", width = 72) {
  return char.repeat(width);
}

function truncate(text: string, maxLines = 40): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join("\n") + `\n  … [${lines.length - maxLines} more lines — open ${SOURCE_FILE} to read the rest]`;
}

function stripMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")   // HTML comments
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")  // links → text
    .replace(/```[\s\S]*?```/g, "[code block]")  // code blocks
    .replace(/`[^`]+`/g, (m) => m)    // inline code — keep
    .replace(/#{1,6}\s/g, "")         // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .trim();
}

function load(file: string): LabeledPR[] {
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8")) as LabeledPR[];
}

function save(file: string, data: LabeledPR[]) {
  writeFileSync(file, JSON.stringify(data, null, 2));
}

// ── Display a PR ───────────────────────────────────────────────────────────────

function displayPR(pr: SourcePR, index: number, total: number) {
  console.clear();
  console.log(hr("═"));
  console.log(`  PR ${index + 1} of ${total}   #${pr.pr_number}`);
  console.log(`  ${pr.url}`);
  console.log(hr("═"));
  console.log();

  // PR body
  const body = stripMarkdown(pr.pr_content);
  console.log(truncate(body, 35));
  console.log();

  // Context: reviews and comments
  if (pr.context.length > 0) {
    console.log(hr("─"));
    console.log(`  THREAD (${pr.context.length} item${pr.context.length !== 1 ? "s" : ""})`);
    console.log(hr("─"));
    for (const c of pr.context) {
      const type = c.event_type.replace(/_/g, " ").toUpperCase();
      console.log(`\n  [${type}] @${c.actor}`);
      console.log(`  ${c.url}`);
      console.log();
      console.log(truncate(c.content.trim(), 15).split("\n").map(l => `  ${l}`).join("\n"));
    }
    console.log();
  }

  console.log(hr("─"));
}

// ── Label one PR ──────────────────────────────────────────────────────────────

async function labelPR(pr: SourcePR): Promise<LabeledPR | null> {
  while (true) {
    console.log();
    console.log("  Does this PR contain a CONCLUDED decision?");
    console.log("  (A concluded choice — not a proposal, not a question, not routine maintenance)");
    console.log();
    console.log("  y = yes     n = no     s = skip (come back later)     ? = show PR again");
    console.log();
    const ans = (await ask("  → ")).trim().toLowerCase();

    if (ans === "s") return null;
    if (ans === "?") return undefined as unknown as LabeledPR; // signal to redisplay

    if (ans !== "y" && ans !== "n") {
      console.log("  Please enter y, n, s, or ?");
      continue;
    }

    const hasDecision = ans === "y";
    const decisions: LabeledDecision[] = [];

    if (hasDecision) {
      console.log();
      console.log("  Add the decision(s). For each one:");
      console.log("  — paste the exact quoted text from the PR/thread (mandatory)");
      console.log("  — write a one-sentence summary of what was decided");
      console.log("  Type 'done' when finished.\n");

      while (true) {
        const quoted = (await ask("  Quoted text (or 'done'): ")).trim();
        if (quoted.toLowerCase() === "done") break;
        if (!quoted) { console.log("  Quoted text cannot be empty."); continue; }

        const summary = (await ask("  One-sentence summary:    ")).trim();
        if (!summary) { console.log("  Summary cannot be empty."); continue; }

        decisions.push({ quoted_text: quoted, summary });
        console.log(`  ✓ Decision recorded. Add another or type 'done'.\n`);
      }

      if (decisions.length === 0) {
        console.log("  No decisions added — marking as no-decision. Press Enter to continue.");
        await ask("");
      }
    }

    return {
      pr_number: pr.pr_number,
      url: pr.url,
      event_id: pr.event_id,
      pr_content: pr.pr_content,
      context: pr.context,
      has_decision: hasDecision && decisions.length > 0,
      decisions,
      labeled_at: new Date().toISOString(),
    };
  }
}

// ── Review mode ───────────────────────────────────────────────────────────────

async function review(labeled: LabeledPR[]) {
  console.log(`\n  ${labeled.length} labeled PRs in ${OUTPUT_FILE}\n`);
  console.log(hr());

  let yes = 0, no = 0;
  for (const pr of labeled) {
    const mark = pr.has_decision ? "✓" : "·";
    console.log(`  ${mark} #${pr.pr_number.padEnd(6)}  has_decision=${String(pr.has_decision).padEnd(5)}  decisions=${pr.decisions.length}`);
    if (pr.has_decision) {
      yes++;
      for (const d of pr.decisions) {
        console.log(`           "${d.summary}"`);
      }
    } else {
      no++;
    }
  }

  console.log(hr());
  console.log(`  Total: ${labeled.length}  |  Yes: ${yes}  |  No: ${no}\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const reset  = args.includes("--reset");
  const reviewMode = args.includes("--review");
  const exportMode = args.includes("--export");

  const source: SourcePR[] = JSON.parse(readFileSync(SOURCE_FILE, "utf8"));

  // --export: promote v2 → main scaffold
  if (exportMode) {
    const v2 = load(OUTPUT_FILE);
    if (v2.length === 0) {
      console.error("  No v2 labels found. Run labeling first.");
      process.exit(1);
    }
    const unlabeled = v2.filter((p) => p.has_decision === null).length;
    if (unlabeled > 0) {
      const confirm = (await ask(`  ${unlabeled} PRs still null (skipped). Export anyway? (y/n): `)).trim();
      if (confirm !== "y") { rl.close(); return; }
    }
    writeFileSync(BACKUP_FILE, readFileSync(SOURCE_FILE));
    // Merge: keep source fields not in v2, overwrite labels
    const merged = source.map((src) => {
      const v2pr = v2.find((p) => p.pr_number === src.pr_number);
      return v2pr ?? { ...src, has_decision: null, decisions: [], labeled_at: "" };
    });
    save(SOURCE_FILE, merged as unknown as LabeledPR[]);
    console.log(`  ✓ Exported ${v2.length} labels to ${SOURCE_FILE}`);
    console.log(`  ✓ Original backed up to ${BACKUP_FILE}`);
    rl.close();
    return;
  }

  // --reset: clear v2
  if (reset) {
    const confirm = (await ask("  Clear all v2 labels and start fresh? (y/n): ")).trim();
    if (confirm === "y") {
      save(OUTPUT_FILE, []);
      console.log("  Cleared.");
    }
    rl.close();
    return;
  }

  // --review: read-only
  if (reviewMode) {
    const labeled = load(OUTPUT_FILE);
    await review(labeled);
    rl.close();
    return;
  }

  // ── Labeling mode ────────────────────────────────────────────────────────────

  let labeled = load(OUTPUT_FILE);
  const labeledNums = new Set(labeled.filter((p) => p.has_decision !== null).map((p) => p.pr_number));
  const todo = source.filter((pr) => !labeledNums.has(pr.pr_number));

  if (todo.length === 0) {
    console.log(`\n  All ${source.length} PRs are labeled. Run with --review to inspect or --export to promote.`);
    rl.close();
    return;
  }

  console.log(`\n  Blind labeling: ${todo.length} PRs remaining (${labeledNums.size} already done)`);
  console.log(`  Output: ${OUTPUT_FILE}`);
  console.log(`  Your prior labels are NOT shown — read each PR fresh.\n`);
  console.log(`  Press Enter to start.`);
  await ask("");

  for (let i = 0; i < todo.length; i++) {
    const pr = todo[i];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      displayPR(pr, labeledNums.size + i, source.length);
      const result = await labelPR(pr);

      if (result === null) {
        // skipped — move on
        console.log(`\n  Skipped #${pr.pr_number} — will appear again next run.`);
        await ask("  Press Enter to continue...");
        break;
      }

      if (result === undefined as unknown as LabeledPR) {
        // redisplay requested
        continue;
      }

      labeled.push(result);
      save(OUTPUT_FILE, labeled);
      console.log(`\n  ✓ Saved (#${pr.pr_number} → has_decision=${result.has_decision})`);

      const remaining = todo.length - i - 1;
      if (remaining > 0) {
        await ask(`  ${remaining} PR${remaining !== 1 ? "s" : ""} remaining. Press Enter to continue...`);
      }
      break;
    }
  }

  const done = labeled.filter((p) => p.has_decision !== null).length;
  const skipped = source.length - done;

  console.log(`\n${hr("═")}`);
  console.log(`  Labeling session complete`);
  console.log(`  Labeled : ${done} / ${source.length}`);
  if (skipped > 0) console.log(`  Skipped : ${skipped} (re-run to finish)`);
  console.log(`  File    : ${OUTPUT_FILE}`);
  if (skipped === 0) {
    console.log(`\n  All PRs labeled. Run with --export to promote v2 → label-scaffold.json`);
    console.log(`  and re-run eval:extraction to get updated F1.`);
  }
  console.log(hr("═"));

  rl.close();
}

main().catch((e) => { console.error(e); rl.close(); process.exit(1); });
