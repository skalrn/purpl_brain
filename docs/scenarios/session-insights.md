# Session Insights — Purpl Brain Value Proposition

**Date:** 2026-05-26  
**Context:** A working session stress-testing purpl_brain's value proposition through
scenario writing and steelmanning. Every claim was challenged. What survived is recorded
here. What didn't survive is recorded too — and why.

---

## What We Tried to Prove and Why It Failed

### Failed framing 1: "The brain catches what reviewers miss"

The original scenarios claimed purpl_brain prevents bugs by catching things code
review would miss. This failed immediately under scrutiny.

**Why it failed:** A good reviewer on a mature team would catch most of what the
scenarios presented. Claiming otherwise dismisses the entire code review process,
which an experienced engineering audience rejects immediately. The scenarios required
stacking implausible assumptions — no tests, careless reviewers, engineers who don't
document — to make purpl_brain look necessary.

**What's left after the steelman:** The drift detection value survives only for a
specific class of contradiction: two individually correct implementations that only
conflict at the intersection, across two repos, where no single reviewer sees both
simultaneously. This is a real but narrow case.

---

### Failed framing 2: "The constraint wasn't documented"

Scenario B (Free plan role restriction) claimed purpl_brain surfaces a constraint
that nobody wrote down. The challenge: Sam would have documented it. And even if
he hadn't, Priya building the feature would hit the API's 403 response in her own
testing, which would surface the constraint immediately.

**Why it failed:** It required assuming both sloppy documentation AND no testing AND
no self-testing by the feature builder. Too many coincidences for a mature team.

**What's left:** The constraint-documentation framing only works when the constraint
is a product UX intent (show an upgrade prompt) rather than a technical enforcement
(API returns 403). Technical constraints are testable. Product UX intents are not.
Even then, the scenario needs careful construction to survive.

---

### Failed framing 3: "The brain replaces documentation"

Implied in early scenarios that purpl_brain is an alternative to ADRs, Notion docs,
and PR descriptions. This framing loses immediately — mature teams have those things
and they work.

**Why it failed:** purpl_brain does not replace any of these. Claiming it does puts
it in competition with tools that already work and invites the response "we already
have that."

---

## What Actually Survived Scrutiny

### 1. The reconstruction cost argument

**The real problem for mature teams is not missing documentation — it is the cost
of reconstructing context from documentation that exists but is distributed.**

200 Notion pages, 40 ADRs, 600 PR descriptions, 3 years of Slack threads. All
correct. All findable in theory. The cost of finding the right subset, reading it,
and assembling a coherent timeline before making a decision is 45–90 minutes —
paid by a human engineer who can then amortise that cost across months of work.

That amortisation does not happen with AI agents. Every agent session starts at zero.
The 45-minute reconstruction cost is paid at the start of every session, forever,
as a permanent tax on agent-assisted development — unless the brain handles it.

**What survives:** The brain turns a 45-minute archaeology task into an 8-second
query. For human engineers this is a convenience. For AI agents this is the
difference between operating with full institutional context and operating blind.

---

### 2. The agent context cost is structurally different from the human context cost

A human engineer reads 200 docs once and carries the context in memory for months.
Without a designed institutional memory system, agents start each session without
your team's accumulated decision context — regardless of which framework they run
on. So:

- Vectorised RAG over docs on every session: expensive in tokens, incomplete in
  coverage, unaware of its own gaps
- Manual briefing by the engineer before every session: costs 20 minutes of
  engineering time per session, scales poorly, depends on the engineer remembering
  what matters
- Purpl_brain session-start query: one call, causally connected graph, cited
  sources, same fidelity on session 1 as session 500

The comparison is not brain vs documentation. It is brain vs the per-session cost
of giving an agent the context it needs to operate correctly.

**What survives:** At 3 agent sessions per day across a team of 8 engineers, the
manual context curation cost without the brain is substantial, recurring, and grows
linearly with agent adoption. The brain eliminates it.

---

### 3. RAG over docs is not the same as the brain's graph

The brain is GraphRAG — knowledge-graph-backed retrieval — not flat semantic
search. Even with a well-vectorised document store, standard RAG retrieves
semantically similar chunks — not causally connected decisions. It returns the
ADR that mentions Redis but may miss the Slack thread three months later where
the team capped Redis connections, because "connection cap" and "Redis ADR"
don't score high on semantic similarity. GraphRAG returns both because they are
linked as nodes in the same graph, traversable regardless of vocabulary.

Additionally: RAG has no awareness of what it didn't retrieve. An agent working
from RAG results doesn't know what's missing. The brain's response is bounded
and citable — the agent knows exactly what it has and where it came from.

**What survives:** Graph-linked causal retrieval (GraphRAG) is structurally
different from flat semantic similarity retrieval. The difference is most visible
when the relevant constraint was recorded in a different context, at a different
time, by a different person, using different vocabulary — exactly the conditions
that defeat cosine similarity but are trivially handled by a graph edge.

---

### 4. The two-correct-implementations-that-conflict-at-intersection class of problem

The billing timing gap scenario survived all challenges. Backend: seat count
snapshot runs on the 1st. Frontend: UI copy says "accepting will increase your
bill." Both correct. Both pass all tests. The conflict only exists at the
intersection — the customer experience on a specific calendar date — which no
test covers and no reviewer sees because they review one PR at a time.

**Why it survives:** Tests pass for each implementation independently. The conflict
is a business timing assumption baked into copy versus a technical implementation
detail in a different repo. No review tool surfaces cross-repo behavioral
assumptions. The brain does because both decisions are in the same graph.

**The class of problem this represents:** Two reasonable, correct-looking decisions
made in different contexts that only conflict when combined in production. Not a bug.
Not a documentation failure. A gap in the space between two correct things.

Other examples of this class:

- **Rate limiting:** Frontend assumes rate limits are per-user (caches per
  user ID). Backend enforces rate limits per-IP (shared across users behind a
  corporate NAT). Both implementations are correct and pass their own tests.
  Under a shared corporate IP, one user's burst exhausts the limit for all
  other users. No single reviewer sees both the frontend cache key and the
  backend limit key simultaneously.

- **Feature flags:** Two agent sessions implement the same feature flag in
  different services. Session A sets the default to `false` (safe rollout for
  the API). Session B sets the default to `true` (fast rollout for the
  worker). Both are locally defensible. In production, the worker activates
  the feature by default while the API suppresses it — creating a state where
  the worker processes events the API does not expose. Each service's tests
  pass. The conflict only appears when both run together.

---

### 5. Multi-agent development forces the behavior change purpl_brain needs

This is the key insight that resolves the adoption problem.

**The concern:** purpl_brain requires teams to change behavior — write better agent
logs, paste meeting transcripts, document decisions explicitly. That friction kills
adoption.

**The resolution:** Multi-agent development already forces that behavior change,
independently of purpl_brain. A team running agents at scale quickly discovers that:
- Agents that start without explicit context produce wrong output
- Informal decisions break agent continuity
- Session briefs need to be structured, not casual
- Handoffs between sessions need to be documented

This is the agent adoption tax — teams pay it whether or not they use purpl_brain.
Purpl_brain is the infrastructure that captures the artifact of a behavior the team
was forced to build anyway. It doesn't require the behavior change. The agents do.

**What this means for adoption:** The right buyer is not teams thinking about
adopting agents. It is teams already running agents regularly — already feeling
the context reconstruction pain, already writing more structured session briefs,
already discovering that informal decision-making breaks continuity. Those teams
are halfway to the behavior purpl_brain needs. They just don't have the
infrastructure to make it compound.

---

### 6. Buyer segmentation matters — the value claim is different for each

**Adapting teams** (moving fast, inconsistent documentation, decisions in Slack
and people's heads):
- purpl_brain is infrastructure they don't have
- Value: captures decisions that would otherwise be lost entirely
- Honest caveat: value is proportional to how much gets ingested; sparse coverage
  produces false confidence

**Mature teams** (strong ADR culture, real test suite, disciplined process):
- purpl_brain is not a replacement for their process
- Value: reduces the reconstruction cost of their existing documentation,
  specifically for AI agents who can't amortise that cost the way humans can
- Honest caveat: only compelling if they are already running agents at scale

---

## What the Honest Coverage Map Looks Like

Not all surfaces ingest reliably. This matters for setting expectations.

| Surface | Coverage | Requires behavior change? |
|---|---|---|
| GitHub PRs, commits, reviews | High — webhook-driven, automatic | No |
| Slack (connected channels) | Medium — high volume, extraction filters signal from noise | No |
| Agent session logs | High if stop hook configured; quality depends on log depth | Minor — engineers review log quality |
| ADRs in git | High — ingested as documents | No |
| Meeting transcripts | Low — requires manual paste | Yes |
| Verbal / informal decisions | Zero | N/A — cannot be captured |
| DM conversations | Zero — not connected by default | N/A |

**The honest position:** The brain has strong coverage of the surfaces that are
already structured (git, agent sessions) and partial coverage of Slack. Informal
decisions that were always invisible remain invisible. The brain is the best
available consolidation of what was recorded — not a complete record of everything
that happened.

---

## The Three Value Tiers (Summary)

| Tier | What it addresses | Who it's for |
|---|---|---|
| **Capture** | Decisions being lost entirely | Adapting teams, early agent adopters |
| **Connection** | Correct documents that don't reference each other across module or team boundaries | Both |
| **Reconstruction cost** | The per-session cost of giving an AI agent institutional context | Mature teams running agents at scale |

The most defensible and novel value claim — the one that survives the steelman
against a mature team with good process — is the reconstruction cost tier,
specifically applied to AI agents.

---

## The Sharpest One-Paragraph Summary

Existing documentation processes are human-centric. A human engineer reads 200 docs
once and carries the context for months. An AI agent reads nothing between sessions —
every session starts at zero. The per-session cost of giving an agent the context it
needs (manual briefing, RAG retrieval, token-heavy doc loading) is paid repeatedly,
grows with agent adoption, and is never amortised. Purpl_brain provides what
human-centric documentation cannot provide to an agent: a single, low-cost,
causally-connected, citable context retrieval that returns the same institutional
fidelity on session 500 as on session 1 — without requiring the engineer to
manually reconstruct it each time.
