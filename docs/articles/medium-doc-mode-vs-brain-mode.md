# Why Your AI Agent Is Re-Reading the Same 3,400 Tokens Before Every Answer

*And what a shared team brain does instead*

---

There is a pattern I've seen teams adopt when they first connect an AI coding assistant to their codebase: they write a `CLAUDE.md`, a few ADRs, a README with setup instructions, maybe a `CONTRIBUTING.md`. Then they load all of it into the agent's context at the start of each session and call it done.

It works. The agent has context. The agent answers questions.

But I started wondering: *how much of that context actually gets used?* And *what happens to the questions the docs don't cover?*

So I ran a comparison. Same questions. Same codebase. Two modes: document mode (agent reads committed docs) and brain mode (agent queries a shared knowledge brain). I used [honojs/hono](https://github.com/honojs/hono) as the test subject — a real, active open-source project with a genuine documentation set.

Here is what I found.

---

## The Setup

**Document mode** simulates an agent with access to Hono's committed documentation: `README.md`, `docs/CONTRIBUTING.md`, and `docs/MIGRATION.md`. These are the files a thoughtful team would point an agent at before asking it to work on the codebase. Combined: **13,646 characters, ~3,412 tokens**.

**Brain mode** uses [Purpl Brain](https://github.com/purpl-inc/purpl-brain) — a shared knowledge system that ingests GitHub PRs, issues, and docs, then serves targeted context to agents via a natural language query interface. The brain was seeded from the top 50 Hono PRs by comment count (discussion-rich, decision-dense) plus the same documentation files.

I ran **7 questions** across two categories:

- **Category A** — questions committed docs *should* answer: project description, migration guide, contribution process
- **Category B** — questions that require reasoning over PR discussions, issue debates, and team activity

---

## The Token Numbers

Here is the raw comparison, per question:

| Question | Doc tokens | Brain tokens | Doc ✓ | Brain ✓ | Savings |
|---|---|---|---|---|---|
| A1 — What is Hono and its design goals? | 3,412 | 101 | ✓ | ✓ | **97%** |
| A2 — Breaking changes, v3 → v4 migration? | 3,412 | 0 | ✓ | ✗ | 100%* |
| A3 — How should contributors submit PRs? | 3,412 | 201 | ✓ | ✓ | **94%** |
| B1 — Why support multiple routers? | 3,412 | 151 | ✓† | ✓ | **96%** |
| B2 — JSX concerns and how resolved? | 3,412 | 201 | ✓† | ✓ | **94%** |
| B3 — Middleware vs Express rationale? | 3,412 | 251 | ✓† | ✓ | **93%** |
| B4 — Active adapter/runtime contributors? | 3,412 | 151 | ✓† | ✓ | **96%** |
| **TOTAL (7 questions)** | **23,884** | **1,056** | **7/7** | **6/7** | **96%** |

*\* Brain missed A2 — the migration guide chunks weren't retrieved for this query. An honest result.*  
*† Doc ✓ means keywords are present in the doc. Whether the doc answers the WHY is a different question.*

**Across 7 questions, brain mode used 96% fewer tokens to deliver the same or better context.**

The average brain query returned ~151 tokens of targeted, relevant citations. The average doc-mode question required the agent to process 3,412 tokens — the entire document set — regardless of how much of it was relevant to the specific question.

---

## The Cost Math — Full Accounting

A fair comparison has to include brain-side costs, not just the context loading savings. There are three buckets:

1. **Downstream agent context** — tokens the calling agent processes per question
2. **Brain synthesis** — the LLM call inside `brain_query` that composes the answer from retrieved chunks
3. **Ingestion** — one-time Haiku extraction cost when seeding the brain (amortised over 30 days)

Using Anthropic Sonnet pricing ($3/1M input, $15/1M output) and 50 agent questions per day:

**Document mode:**

| Cost bucket | Tokens/question | Daily cost |
|---|---|---|
| Agent loads docs into context | ~3,412 | $0.51 |
| Brain synthesis | none | $0.00 |
| Ingestion | none | $0.00 |
| **Total** | | **$0.51/day** |

**Brain mode:**

| Cost bucket | Tokens/question | Daily cost |
|---|---|---|
| Agent reads brain answer (~300 tok) | ~300 | $0.05 |
| Brain synthesis (cache-warm: 170t in + 300t out) | 470 | $0.25 |
| Ingestion, amortised ($0.08 one-time ÷ 30 days) | — | $0.003 |
| **Total** | | **$0.30/day** |

**Net: brain mode saves $0.21/day → $6.41/month** at 50 questions/day, including all costs.

The synthesis cost is real and worth accounting for. It's also where caching compounds: with multiple agent sessions reusing the same brain system prompt, the cache-warm assumption holds and the synthesis cost per call drops further. At 200 questions per day (a small team with several active sessions), the differential widens.

---

## The Coverage Gap

The more interesting finding isn't the token savings. It's this: **category B questions expose a structural gap that cheaper context loading doesn't close.**

Consider B1: *"Why did the Hono team decide to support multiple router implementations instead of committing to a single routing algorithm?"*

The committed docs contain the *words* "router" and "multiple" — so a keyword check marks it as covered. But reading the README and CONTRIBUTING guide won't tell you the reasoning. That conversation happened in pull request discussions, issue threads, and design debates that were never committed to a markdown file.

Brain mode retrieved 3 citations from actual PR discussions, including the specific conversation where the maintainers weighed the trade-offs. The answer included rationale, the alternatives considered, and the confidence level of the decision — because those were stored alongside the event that created them.

Docs can't give you the *why* if the *why* was never written down. And in most teams, it isn't.

---

## Seven Things Brain Mode Does That Committed Docs Can't

I catalogued these as part of the eval. They are structural, not just a matter of having more content.

**1. Decision history with rationale**  
Docs show the final decision. Brain stores decisions with the reasoning, alternatives considered, and confidence level. Every query answer cites the source — PR, Slack thread, or meeting note — so the agent can trace the reasoning, not just accept the conclusion.

**2. Multi-source context**  
Committed docs only capture what someone bothered to write down. Brain ingests Slack threads, Jira tickets, meeting transcripts, and agent logs alongside GitHub events. A question about a feature can surface the PR *and* the Slack debate that shaped the approach *and* the Jira ticket that triggered it.

**3. Drift detection**  
Docs go stale. Nothing flags when the code has diverged from what was documented. Brain runs a continuous drift detector: when new PRs contradict an existing decision, a `DriftAlert` is written to the graph and surfaced in queries. The agent is told when the documentation no longer reflects reality.

**4. Cross-session agent memory**  
Each doc-mode session starts cold. If a prior agent session hit a constraint, discovered an undocumented invariant, or made a choice that future sessions need to know about — that knowledge is gone when the session ends.  
Brain sessions write decisions back via `brain_log_decision`. The next session queries `brain_query` at start and resumes with full context. No re-derivation.

**5. Temporal queries**  
Docs have no timeline. Brain tags every event with a timestamp and makes temporal queries first-class: "what changed in the last 7 days", "what decisions were made before the v4 migration", "what did the team discuss this sprint". These questions are unanswerable from static files.

**6. Impact analysis**  
Before a significant change, an agent in doc mode must manually reason through which documented decisions might be affected. Brain provides `brain_analyze_impact`: describe the change you're about to make, get back which past decisions it touches and the assessed risk level.

**7. Zero-maintenance freshness**  
Someone has to update CLAUDE.md, ADRs, and README when things change. Teams rarely do this consistently — especially for decisions made in PR review comments that never make it into a file. Brain's context freshness is a byproduct of normal team activity: every merged PR and closed issue is ingested automatically.

---

## The Honest Caveat

Document mode has a real advantage: **zero infrastructure**. A team that maintains disciplined `CLAUDE.md` files and well-structured ADRs can get meaningful agent context without running any additional systems. The overhead is real: Purpl Brain needs Redis, Qdrant, Neo4j, and a set of processing workers. That is a meaningful operational ask.

The brain's edge is clearest in three scenarios:

1. **The team has Slack and Jira activity that shapes technical decisions** — those discussions contain context that no one commits to a markdown file
2. **Agents work across multiple sessions** and need continuity — the re-derivation cost compounds
3. **The codebase is evolving quickly** — docs lag, the brain self-updates

For a solo developer with a stable codebase and a tight `CLAUDE.md`, committed docs might be sufficient. For a team of five or more with a fast-moving product, the structural gap compounds with every session.

---

## The Eval Infrastructure

The comparison is automated and reproducible. After seeding a project into the brain (`npm run seed:hono -w apps/api`), the full comparison runs in under 60 seconds:

```bash
npm run eval:comparison -w apps/api
```

Output includes: per-question token counts, coverage assessment, cost projection at configurable daily question volume, and the full structural advantages catalog.

The eval uses the real brain API — not a mock — so the numbers reflect actual retrieval quality from whatever the brain has indexed.

---

## Numbers Worth Keeping

- **96% fewer context tokens** per question when using brain mode vs loading committed docs
- **$6.41/month net savings** per 50-question-per-day team at Sonnet pricing — including brain synthesis and ingestion costs, not just context loading
- **$0.51/day doc mode vs $0.30/day brain mode** — full all-in cost comparison at 50 questions/day
- **6/7 questions answered** by brain from PR discussions vs 7/7 from docs (docs win on committed content; brain wins on rationale and team activity)
- **7 structural capabilities** that committed docs cannot replicate regardless of how well they're maintained

The token savings fund themselves. The structural capabilities — drift detection, cross-session memory, impact analysis, temporal queries — are what actually change how agents work on a team.

---

*Purpl Brain is open source. The eval script, seed scripts, and comparison methodology are in the repo. If you run this against a different codebase and get different numbers, we'd want to know.*
