# Content Tracker

Publishing plan for purpl_brain build-in-public content.
Home base: Substack. Distribution: LinkedIn (short posts), Reddit (problem-focused threads).

---

## Publishing Queue — Ordered

| # | File | Platform | Status | Publish week | Notes |
|---|---|---|---|---|---|
| 1 | `medium-agent-memory-two-failure-modes.md` | Substack + Medium | Ready | Week 1 | Core thesis post. Updated with Mem0/Zep comparison and auto-extraction note. |
| 2 | `medium-re-derivation-cost.md` | Substack + Medium | Ready | Week 2 | Strong numbers. No changes needed. |
| 3 | `medium-the-404-that-broke-agent-memory.md` | Substack + Medium | Ready | Week 3 | Good narrative for hiring audience. Verify story matches current bug. |
| 4 | `medium-doc-mode-vs-brain-mode.md` | Substack + Medium | Ready | Week 4 | Token efficiency comparison with real eval numbers. Different angle from #2. |
| 5 | `medium-eval-suite-that-misses-the-point.md` | Substack + Medium | Ready | Week 5 | Build-in-public credibility. Good for EM + staff eng audience. |
| 6 | `medium-llm-cost-controls-compliance.md` | Substack + Medium | Ready | Week 6 | Technical depth, hiring signal. |
| 7 | `medium-mem0-zep-vs-purpl-brain.md` | Substack + Medium | Ready | Week 3 | Competitive positioning. Honest about the tradeoff. |
| 8 | `medium-product-viability-honest-take.md` | Substack + Medium | Ready | Week 4 | Founder honesty piece. Strong for both hiring and beta audiences. |
| 9 | `medium-redis-streams-mistakes.md` | Substack + Medium | Backlog | Week 7+ | Technical deep dive. Strong hiring signal. |
| 10 | `medium-data-isolation-ai-pipelines.md` | Substack + Medium | Backlog | Post-beta | Enterprise/security angle. Hold until beta open. |

---

## New Drafts — From Recent Sessions

| File | Angle | Status |
|---|---|---|
| `medium-mem0-zep-vs-purpl-brain.md` | How Mem0/Zep intercept at framework level vs. asking the agent. The structural write-back comparison. | Ready — insert as week 2 or 3 |
| `medium-product-viability-honest-take.md` | Honest founder take: where it works, where it breaks, compliance rates, the empty brain risk. | Ready — insert as week 3 or 4 |
| `medium-10-parallel-agents.md` | What breaks at scale: drift triage volume, brain density lag, token economics, the threshold decision. | Not started — week 4-5 |
| `linkedin-short-posts.md` | Running list of short LinkedIn posts (one insight each, 150-300 words) | Ongoing |

---

## Reddit Posts

| File | Subreddits | Status |
|---|---|---|
| `launch-reddit-post-1.md` | r/LocalLLaMA, r/ExperiencedDevs | Ready — use week 1, pairs with Substack post #1 |
| `reddit-post-re-derivation.md` | r/LocalLLaMA, r/ExperiencedDevs, r/ClaudeAI | Ready — use week 2 |

---

## LinkedIn Posts

| File | Week | Status |
|---|---|---|
| `launch-linkedin-post-1.md` | Week 1 | Ready — pairs with Substack post #1 |

### Short posts backlog (draft inline before posting)

From session 2026-05-22:
- "We ran 10 parallel AI agents on the same codebase. The bottleneck wasn't compute or tokens. It was 30 minutes of morning drift triage."
- "Mem0 and Zep don't ask the agent to cooperate. We do. Here's the bet we're making and why."
- "Empty brain is worse than noisy brain. Here's why we're building auto-extraction even though quality drops."
- "Raised our drift detection threshold from 0.55 to 0.72 before beta. One env var. Buys time to measure real triage load before building smarter grouping."
- "Staff eng + EM background when building dev tools: you've been both the person making the decisions and the person whose team suffers when those decisions go undocumented."

---

## Platform Notes

**Substack:** publish everything here first. Owns the email list.
**Medium:** cross-post 1 week after Substack. Better SEO, no list ownership.
**LinkedIn:** 2–3 short posts per week. Short insight per post, link to Substack for long-form.
**Reddit:** 1 post per week in rotation. r/ExperiencedDevs, r/LocalLLaMA, r/MachineLearning, r/SideProject. Problem-first framing, never promotional.

---

## Voice Rules

- Your name on every post, not the product name. You are the signal.
- Every post answers: **what did you learn and what did you decide?** Not what did you build.
- Problem first, always. Product is evidence the problem is real, not the headline.
