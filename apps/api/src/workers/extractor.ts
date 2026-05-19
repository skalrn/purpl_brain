import "dotenv/config";
import { Redis } from "ioredis";
import { STREAMS } from "../lib/redis.js";
import { StreamWorker } from "../lib/stream-worker.js";
import { chat, chatJSON, MODELS } from "../lib/llm.js";
import type { CanonicalEvent, ExtractionResult, Decision } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");
const writer = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

// ── GitHub PR link-following (fixes 91% recall gap) ───────────────────────────
// When a document (ADR, transcript) embeds GitHub PR URLs, those PR comment
// threads are never ingested — only the doc text is. This causes missed
// decisions that were hashed out in the linked PR discussion.

const GITHUB_API = "https://api.github.com";
const LINKED_PR_SET = "brain:linked_pr_processed";
const GITHUB_PR_RE = /https:\/\/github\.com\/([^/\s"')]+)\/([^/\s"')]+)\/pull\/(\d+)/g;
const GITHUB_SLUG_RE = /^[a-zA-Z0-9_.-]+$/;
const MAX_LINKS_PER_EVENT = 5;

// Allowlist of org/repo slugs this instance is permitted to follow.
// Format: "owner/repo" comma-separated. Empty = allow all (default for self-hosted).
const GITHUB_LINK_FOLLOW_ALLOWLIST: Set<string> | null = (() => {
  const raw = process.env.GITHUB_LINK_FOLLOW_ALLOWLIST;
  if (!raw) return null;
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
})();

async function fetchLinkedPRs(
  rawContent: string,
  projectId: string,
  token: string | undefined
): Promise<void> {
  if (!token) return; // skip silently — no auth means 60 req/hr, too risky for unexpected fetch

  const matches = [...rawContent.matchAll(GITHUB_PR_RE)].slice(0, MAX_LINKS_PER_EVENT);
  if (matches.length === 0) return;

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    Authorization: `Bearer ${token}`,
  };

  for (const match of matches) {
    const [, owner, repo, prNum] = match;

    // Reject slugs that don't look like valid GitHub identifiers
    if (!GITHUB_SLUG_RE.test(owner) || !GITHUB_SLUG_RE.test(repo)) {
      console.warn(`[extractor] skipping malformed linked PR slug: ${owner}/${repo}`);
      continue;
    }

    // Enforce allowlist if configured
    if (GITHUB_LINK_FOLLOW_ALLOWLIST && !GITHUB_LINK_FOLLOW_ALLOWLIST.has(`${owner}/${repo}`)) {
      console.warn(`[extractor] linked PR ${owner}/${repo} not in GITHUB_LINK_FOLLOW_ALLOWLIST — skipping`);
      continue;
    }
    const key = `${owner}/${repo}/pull/${prNum}`;

    const already = await redis.sismember(LINKED_PR_SET, key);
    if (already) continue;

    try {
      const [pr, comments] = await Promise.all([
        fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNum}`, { headers }).then(r => r.ok ? r.json() : null),
        fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNum}/comments?per_page=100`, { headers }).then(r => r.ok ? r.json() : []),
      ]);

      if (!pr) continue;

      const prUrl = `https://github.com/${owner}/${repo}/pull/${prNum}`;
      const body = pr.body ?? "";
      const commentThread = (comments as Array<{ body: string; user: { login: string } }>)
        .map(c => `${c.user.login}: ${c.body}`)
        .join("\n\n");
      const combined = [body, commentThread].filter(Boolean).join("\n\n---\n\n");

      if (!combined.trim()) {
        await redis.sadd(LINKED_PR_SET, key);
        continue;
      }

      const linkedEvent: CanonicalEvent = {
        event_id: `linked_pr_${owner}_${repo}_${prNum}`,
        source: "github",
        source_id: `${owner}/${repo}/pull/${prNum}`,
        project_id: projectId,
        actor: {
          type: "human",
          id: pr.user?.login ?? "unknown",
          name: pr.user?.login ?? "unknown",
        },
        timestamp: pr.merged_at ?? pr.updated_at ?? new Date().toISOString(),
        event_type: pr.merged ? "pr_merged" : pr.state === "closed" ? "pr_closed" : "pr_opened",
        url: prUrl,
        raw_content: combined,
        document_title: pr.title ?? `PR #${prNum}`,
      };

      await writer.xadd(STREAMS.RAW, "*", "event", JSON.stringify(linkedEvent));
      await redis.sadd(LINKED_PR_SET, key);
      console.log(`[extractor] queued linked PR ${key} for ingestion`);
    } catch (err) {
      console.warn(`[extractor] failed to fetch linked PR ${key}:`, err);
    }
  }
}

interface NormalizedEvent extends CanonicalEvent {
  ticket_refs: string[];
  person_mentions: string[];
  decision_candidate: boolean;
}

const EXTRACTION_SYSTEM_PROMPT = `You are a high-precision decision extractor for software engineering content.
Your primary goal is precision: extracting a non-decision is worse than missing a real one.
When in doubt, do NOT extract. A missed decision is recoverable. A spurious one pollutes the brain.

## What counts as a DECISION (extract these)

A decision is a CONCLUDED choice — something that has been settled, not proposed.

- Explicit choices with rationale: "we chose X over Y because Z"
- Deferred/blocked decisions: "closing until design decision on auth settles" — the DEFERRAL is a decision
- Rejection / no-action: "there's no need to enforce this at library level" — deciding NOT to act is a decision
- Maintainer closures: "closing in favor of X", "closing as won't fix" — with or without rationale
- Policy / default decisions: "this is the correct default behavior for our use case"

## What does NOT count as a DECISION (return [] for these)

- Proposals, suggestions, or open questions: "what if we tried X?", "should we use Y?"
- Automated dependency bumps: "bump X from 1.0 to 1.1" — no design discussion
- Routine CI matrix additions with no explanation
- Typo fixes, doc formatting, changelog entries, test renames
- "I think we should..." without a response confirming the choice
- Observations about existing behavior: "this currently does X"
- Version/support drops WITHOUT any indication the decision was made in this thread

## Output schema

{
  "decisions": [{
    "quoted_text": "exact quote from the source — mandatory, no paraphrasing",
    "summary": "one clear sentence: what was decided",
    "rationale": "why — null if not stated, do NOT infer",
    "alternatives_considered": ["list", "only", "if", "explicitly", "mentioned"],
    "confidence": "high|medium|low",
    "decision_maker": "name/handle of who made the decision, or null",
    "scope": "what this applies to (module, service, project), or null",
    "reversible": true/false — true if described as tentative, false if presented as final
  }]
}

## Confidence rules (be conservative — prefer lower confidence over inflating)

- high: explicit decision language + rationale both present ("we chose X because Y")
- medium: clear concluded choice but rationale implied or absent ("closing in favor of X")
- low: terse, minimal context — ONLY extract if the choice is unambiguous ("Removed Python 3.10 support")

Do NOT extract borderline cases at high confidence. If you are unsure whether something is a decision, assign medium or low. If you are unsure whether it is a decision at all, return [].

NEVER fabricate quoted_text. NEVER infer rationale that is not stated. NEVER extract suggestions as decisions.

## Examples

### Explicit decision with rationale → high confidence
Text: "We're going with short-lived JWTs (15-min expiry). Compliance requires it — long-lived tokens were flagged last quarter."
Output: { "decisions": [{ "quoted_text": "We're going with short-lived JWTs (15-min expiry). Compliance requires it", "summary": "Adopted short-lived JWTs for session tokens due to compliance requirement.", "rationale": "Compliance flagged long-lived tokens last quarter", "alternatives_considered": ["long-lived tokens"], "confidence": "high", "decision_maker": null, "scope": "session tokens", "reversible": false }] }

### Deferral decision → medium confidence
Text: "I'll close this for now. There's a pending design decision around authentication that needs to settle first."
Output: { "decisions": [{ "quoted_text": "I'll close this for now. There's a pending design decision around authentication that needs to settle first.", "summary": "Deferred this change until the authentication design decision is resolved.", "rationale": "Blocked on upstream design decision", "alternatives_considered": [], "confidence": "medium", "decision_maker": null, "scope": null, "reversible": true }] }

### Rejection decision → high confidence
Text: "There's no need to enforce this at the library level. Users can configure this themselves if they want to."
Output: { "decisions": [{ "quoted_text": "There's no need to enforce this at the library level.", "summary": "Decided not to enforce this behavior at library level; left to user configuration.", "rationale": "Users can configure it themselves", "alternatives_considered": ["enforce at library level"], "confidence": "high", "decision_maker": null, "scope": "library API", "reversible": false }] }

### Terse version drop — only if unambiguous → low confidence
Text: "Removed Python 3.10 from the test matrix."
Output: { "decisions": [{ "quoted_text": "Removed Python 3.10 from the test matrix.", "summary": "Dropped Python 3.10 from the supported test matrix.", "rationale": null, "alternatives_considered": [], "confidence": "low", "decision_maker": null, "scope": "test matrix", "reversible": false }] }

### Automated dependency bump — return empty
Text: "Bump httpcore from 1.0.5 to 1.0.6. Bumps httpcore from 1.0.5 to 1.0.6. Changelog: ..."
Output: { "decisions": [] }

### Proposal without confirmed outcome — return empty
Text: "What if we moved to a microservices architecture? Might help with scaling."
Output: { "decisions": [] }

### Observation about existing behavior — return empty
Text: "The current implementation uses a singleton pattern for the cache."
Output: { "decisions": [] }`;

async function extractDecisions(event: NormalizedEvent): Promise<Decision[]> {
  const userMessage = `Extract decisions from this GitHub ${event.event_type}:

URL: ${event.url}
Author: ${event.actor.name}

Content:
${event.raw_content}`;

  try {
    const result = await chatJSON<{ decisions: Decision[] }>(
      MODELS.EXTRACTION,
      [
        { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      { maxTokens: 1024, temperature: 0 }
    );
    return Array.isArray(result.decisions) ? result.decisions : [];
  } catch {
    console.warn("[extractor] JSON parse failed, retrying with fallback prompt");
    try {
      const raw = await chat(
        MODELS.EXTRACTION,
        [
          { role: "system", content: EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: userMessage },
        ],
        { maxTokens: 1024, temperature: 0 }
      );
      const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
      const result = JSON.parse(cleaned) as { decisions: Decision[] };
      return Array.isArray(result.decisions) ? result.decisions : [];
    } catch {
      console.error("[extractor] extraction failed after retry, skipping LLM pass");
      return [];
    }
  }
}

class Extractor extends StreamWorker {
  constructor() {
    super(redis, {
      name: "extractor",
      stream: STREAMS.NORMALIZED,
      group: "extractor",
      consumer: "extractor-1",
      fieldName: "event",
    });
  }

  protected async processMessage(id: string, value: string): Promise<void> {
    const event = JSON.parse(value) as NormalizedEvent;
    let decisions: Decision[] = [];

    // Follow embedded GitHub PR links in document events before LLM extraction.
    // This is the fix for the 91% recall gap: ADRs reference PR discussions but
    // those PRs were never ingested, so decisions in linked PR comment threads
    // were invisible to the brain.
    if (event.source === "document" || event.event_type === "document_chunk") {
      await fetchLinkedPRs(
        event.raw_content,
        event.project_id,
        process.env.GITHUB_TOKEN
      );
    }

    if (event.decision_candidate) {
      decisions = await extractDecisions(event);
      console.log(`[extractor] LLM extracted ${decisions.length} decision(s) from ${event.event_id}`);
    }

    const result: ExtractionResult = {
      event_id: event.event_id,
      project_id: event.project_id,
      source_id: event.source_id,
      source_url: event.url,
      raw_content: event.raw_content,
      actor: event.actor,
      timestamp: event.timestamp,
      decisions,
      ticket_refs: event.ticket_refs,
      person_mentions: event.person_mentions,
      concept_tags: [],
      decision_candidate: event.decision_candidate,
    };

    await writer.xadd(STREAMS.EXTRACTED, "*", "result", JSON.stringify(result));
    await redis.xack(STREAMS.NORMALIZED, "extractor", id);

    console.log(
      `[extractor] ${event.event_type} ${event.event_id} → extracted (decisions=${decisions.length}, candidate=${event.decision_candidate})`
    );
  }

  protected override async onShutdown(): Promise<void> {
    await writer.quit().catch(() => undefined);
  }
}

new Extractor().run().catch((e) => {
  console.error("[extractor] fatal:", e);
  process.exit(1);
});
