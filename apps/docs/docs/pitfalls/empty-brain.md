---
sidebar_position: 1
---

# The Empty Brain Failure

## What happens

A developer installs purpl_brain. They run an agent session. At the start of the session, the agent calls `brain_query`. The brain returns nothing — because no one has written to it yet.

The developer's conclusion: the product does not work.

This conclusion is structurally incorrect — the brain works, it just has nothing in it. But from the developer's perspective, the experience is indistinguishable from a broken product. They do not know whether the empty response means "there is no relevant context" or "the brain is empty" or "the query failed silently." If they try again in their next session and get the same empty response, they stop trying.

The empty brain failure is the most dangerous failure mode because it happens before the product has had any chance to prove itself. The developer leaves before the brain has accumulated enough history to be useful.

## Why an empty brain is worse than a noisy brain

A noisy brain — one full of low-signal entries like "team used TypeScript" — at least signals to the developer that the brain is receiving input and is operational. The developer can query it, see responses, and gradually realize the quality needs improvement. There is a path to improvement: log better decisions.

An empty brain provides no such signal. There is nothing to react to, nothing to improve, nothing that suggests the product is functioning. The developer's mental model becomes "this thing doesn't work" rather than "this thing needs better input."

This asymmetry means that the onboarding cold-start experience is more important than almost any feature. A developer who sees one useful cited answer in their first session will continue. A developer who sees empty responses in their first three sessions will not return.

## The cold-start problem in numbers

The cold-start problem has a specific shape. For a new installation:

- **Session 1:** Brain is empty. `brain_query` returns nothing. Write-back produces the first decisions.
- **Session 2:** Brain has decisions from Session 1. `brain_query` returns a small amount of context. Write-back adds more decisions.
- **Session 5+:** Brain has enough history to provide meaningful context on most queries.

The problem is that Sessions 1-3 are the worst possible demonstration of the product's value. If the developer does not persist through those sessions, they never reach the point where the brain is useful. The dropout window is narrow and early.

## Mitigations

**Onboarding seed (pre-beta, not yet shipped):** The UI (SeedBrainBanner) prompts new users to create one manual decision log documenting the project's current architectural state before the first agent session. Three to five decisions covering the tech stack, key constraints, and recent choices. This gives `brain_query` enough to return meaningful results in Session 1.

The seed does not need to be comprehensive. It needs to be enough to demonstrate that the brain has context worth reading. One useful `brain_query` response in the first session is the difference between a user who continues and a user who abandons.

**GitHub history seeding:** The `seed:github` CLI ingests the last 90 days of PRs and issues on project setup. This populates the brain before the first agent session with real project history. Decision extraction from 90 days of GitHub history typically produces 20-50 meaningful Decision nodes for an active repo.

**Stop hook as a forcing function:** The Claude Code Stop hook prevents sessions from ending without logging decisions. This ensures that every session contributes to the brain, even if the developer is focused on other things. Each session makes the next session's `brain_query` slightly more useful.

**Brain health UI (not yet shipped):** A visible indicator showing "last write: 3 days ago, 0 decisions this week" gives the developer clear signal that the brain needs input. Without this indicator, a developer who has stopped writing decisions has no way to know the brain is going stale.

## Design principle: make the empty brain visible

The worst outcome is a brain that silently returns empty responses. The second-worst outcome is a brain that signals emptiness but gives no guidance on what to do about it.

The design principle for handling empty-brain responses in the UI: always distinguish between "no relevant context found" and "brain has no data." In the second case, link directly to the seeding action. An empty brain is a setup problem, not a query problem, and the UX should reflect that distinction.
