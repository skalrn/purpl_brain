# Content Tracker

Publishing plan for purpl_brain build-in-public content.
Home base: Substack. Distribution: LinkedIn (short posts), Reddit (problem-focused threads).

---

## Framing — Applies to All Content

**Governing framing (agreed 2026-05-22):**
> "I built a shared decision log for human-agent teams to find out whether it would actually hold up. Here's what the system revealed and what it doesn't solve."

- "I built" not "I've been experimenting with" or "I've been building"
- Lead with the competitive gap (existing systems capture facts not reasoning; no human write path)
- Honest about validation state: works end-to-end for one developer, team scale is the open question
- Never "what I'd need to see before calling it validated" — kills beta intent
- Forward motion: invite early users, don't warn them off

**Voice rules:**
- Your name on every post, not the product name. You are the signal.
- "I" not "we" — this is a solo side project, not a company
- Problem first, always. The system is evidence the problem is real, not the headline
- Every post answers: what did you find and what does it not solve?

---

## Publishing Queue — Ordered

**Start here. Publish in this order.**

| # | File | Platform | Status | Week | Notes |
|---|---|---|---|---|---|
| 1 | `medium-shared-decision-log-primary.md` | Substack + Medium | **Ready — publish first** | Week 1 | New primary piece. New framing. Leads with competitive gap, honest about solo validation, invites early users. This is the article LinkedIn post #1 links to. |
| 2 | `medium-agent-memory-two-failure-modes.md` | Substack + Medium | Ready | Week 2 | Core failure modes piece. Full editorial pass complete: em-dashes clean, framing updated, "experimenting" removed. |
| 3 | `medium-re-derivation-cost.md` | Substack + Medium | Ready | Week 3 | Token cost of re-derivation. Solid numbers, clear narrative. Editorial pass complete. |
| 4 | `medium-mem0-zep-vs-purpl-brain.md` | Substack + Medium | Ready | Week 4 | Competitive comparison. Mem0 benchmark corrected (94.4, April 2026 algorithm). Honest about Zep's bi-temporal advantage. Editorial pass complete. |
| 5 | `medium-product-viability-honest-take.md` | Substack + Medium | Ready | Week 5 | Honest viability take: where it works, where it breaks. Editorial pass complete. |
| 6 | `medium-the-404-that-broke-agent-memory.md` | Substack + Medium | Needs review | Week 6 | Good narrative for hiring audience. Verify story matches current system before publishing. |
| 7 | `medium-doc-mode-vs-brain-mode.md` | Substack + Medium | Needs review | Week 7 | Token efficiency comparison. Verify eval numbers are still current. |
| 8 | `medium-eval-suite-that-misses-the-point.md` | Substack + Medium | Needs review | Week 8 | Build-in-public credibility. Good for EM + staff eng audience. |
| 9 | `medium-llm-cost-controls-compliance.md` | Substack + Medium | Needs review | Week 9 | Technical depth, hiring signal. |
| 10 | `medium-redis-streams-mistakes.md` | Substack + Medium | Backlog | Week 10+ | Technical deep dive. Strong hiring signal. |
| 11 | `medium-data-isolation-ai-pipelines.md` | Substack + Medium | Backlog | Post-beta | Enterprise/security angle. Hold until beta open. |

---

## New Article Set — Planned, Not Yet Written

Three more articles in the new framing. Write after seeing how the primary piece lands.

| # | Working title | Angle | Status |
|---|---|---|---|
| A | "Building Agent Memory Forced Me to Solve Two Problems I Didn't Anticipate" | Failure modes reframed as builder's discovery, not educator's warning. Different voice from #2 above. | Not started |
| B | "What Mem0, Zep, and Microsoft Foundry Get Right — and the Gap None of Them Fill" | More decisive competitive piece. Leads with what they do well, then the specific gap. | Not started |
| C | "The System Works for One Developer. Here's What I Need to Learn from Teams." | Open question piece. Honest about validation state. Directly invites beta users. | Not started |

---

## Reddit Posts

| File | Subreddits | Status | Notes |
|---|---|---|---|
| `launch-reddit-post-1.md` | r/LocalLLaMA, r/ExperiencedDevs, r/MachineLearning | **Ready** | Full draft per subreddit. New framing applied. Em-dashes clean. r/MachineLearning hardened for specialist scrutiny (hedged compliance numbers, extraction quality claim). Post week 1, pairs with Substack post #1. |
| `reddit-post-re-derivation.md` | r/LocalLLaMA, r/ExperiencedDevs, r/ClaudeAI | Needs review | Check for old framing and em-dashes before posting. |

---

## LinkedIn Posts

| File | Week | Status | Notes |
|---|---|---|---|
| `launch-linkedin-post-1.md` | Week 1 | **Ready** | New framing applied. Em-dashes clean. Post after Substack article #1 is live. Link in first comment. |

### Short posts backlog

Draft inline before posting. **Note: items marked with ⚠️ use "we" voice — rewrite to "I" before posting.**

- ⚠️ "We ran 10 parallel AI agents on the same codebase. The bottleneck wasn't compute or tokens. It was 30 minutes of morning drift triage." → rewrite as "I"
- ⚠️ "Mem0 and Zep don't ask the agent to cooperate. We do. Here's the bet we're making and why." → rewrite as "I built this to test a different bet"
- ⚠️ "Empty brain is worse than noisy brain. Here's why we're building auto-extraction even though quality drops." → rewrite as "I"
- "Raised the drift detection threshold from 0.55 to 0.72 before beta. One config change. Buys time to measure real triage load before building smarter grouping."
- "Staff eng background when building dev tools: you've been both the person making the decisions and the person whose team suffers when those decisions go undocumented."

---

## Platform Notes

**Substack:** publish everything here first. Owns the email list.
**Medium:** cross-post 1 week after Substack. Better SEO, no list ownership.
**LinkedIn:** post after Substack is live. Short insight, link to Substack in first comment.
**Reddit:** 1 post per week in rotation. r/ExperiencedDevs, r/LocalLLaMA, r/MachineLearning. Problem-first framing, never promotional. Select one title option per subreddit before posting.

---

## Editorial Standards — Applied to All Articles

From the 2026-05-22 editorial pass. Check every article before publishing:

- No em-dashes in prose (run `grep "—" filename.md` before publishing)
- No banned phrases: "Imagine...", "structurally superior", "genuinely differentiated", "We're betting that...", "Here's why" as heading, "In practice" as filler, "Key insight:", "Let's explore..."
- No markdown tables (Medium drops them — use bullet groups instead)
- Compliance numbers and self-measured stats need "(rough estimate, not a controlled measurement)" qualifier
- Extraction quality claims need "in my testing" qualifier
- Framing: "I built" not "I've been experimenting" or "I've been building"
- No "what I'd need to see before calling it validated" — kills beta intent

Articles 1–5 in the queue above have passed this check. Articles 6–11 need a pass before publishing.
