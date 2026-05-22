---
sidebar_position: 2
---

# Beta Requirements

## What must ship before opening beta

Beta means giving real developers access to the system without hand-holding. Every item in this list is a requirement because its absence would cause a beta user to have a bad experience, form incorrect conclusions about the product, or compromise their data.

**Eval pass (complete):** All Phase 1 and Phase 2 evals passing with the current codebase. A system that does not pass its own evals should not be given to beta users.

**Security hardening (complete as of 2026-05-22):**
- API key hashing at rest (not stored in plaintext)
- Per-project auth (`requireProjectMember` middleware on all data-touching routes)
- Webhook signature verification for all sources (GitHub HMAC-SHA256, Slack signing secret)
- Rate limiting on `POST /brain/agent-log` per API key
- No cross-tenant data leakage on any query path

**Single `docker compose up` (complete):** Beta users should be able to start the full stack with one command. All service dependencies, migrations, and health checks run automatically. The `setup.sh` wizard guides users through environment variable configuration.

**Onboarding seed (not yet shipped):** The SeedBrainBanner that prompts users to create their first decision log before running their first agent session. Without this, users hit the cold-start problem — the brain is empty on first query. This must ship before beta because the first-session experience determines whether users continue.

**Brain health UI indicator (not yet shipped):** A visible signal in the UI showing "last write: X days ago, Y decisions this week." Without this, users who have stopped writing decisions (or whose Stop hook is misconfigured) have no way to know the brain is going stale.

**MCP server documentation (complete):** The full setup guide for Claude Code and Cursor. This is a blocker for beta because most beta users will use one of these IDEs.

## What is deliberately deferred post-beta

These items were considered and explicitly excluded from the beta scope. They will be built only if beta teams confirm the pain:

**Living guidelines (`Guideline` node, `brain_get_guidelines`, `RuleDrift` alerts):** A mechanism to store team coding conventions in the brain as first-class nodes, with drift alerts when new decisions violate established guidelines. The design is specced but not implemented. Deferred because it requires a clear signal from beta teams that the current decision memory approach is insufficient for enforcing conventions.

**Cross-source deduplication:** When the same decision appears in a Slack thread, a GitHub PR, and an agent log, the brain currently stores three separate Decision nodes. Linking these into a single canonical decision with multiple source citations requires entity resolution at the decision level — significantly more complex than current per-source extraction. Deferred until beta teams report confusion from seeing the same decision cited multiple times.

**`brain_trace_decision`:** A tool that shows the full provenance chain for a specific decision — every source, every actor, every modification since the decision was first made. Useful for audit and forensics. Deferred because it is a query pattern addition, not a capability gap, and beta will reveal which query patterns users actually need.

**GitHub OAuth / seat identity (M5):** Moving from API key authentication to GitHub OAuth, with email-based Person primary keys and per-source alias merge. Required before charging per-seat. Deferred until after beta validates the product works at all — identity resolution before product-market fit is premature.

## Beta target profile

3-5 initial beta users minimum. Selection criteria:

- Real context-switching pain (not just general AI tool users)
- Active use of Claude Code or Cursor as primary editor
- At least one repo with 90+ days of active GitHub history
- Willing to give structured feedback (not just "it's cool")

The beta is not a demo. It is validation that the agent memory loop works for developers who have real pain, with real repos, in their real workflow. The exit criterion for beta is the Phase 3 exit criterion: the second session recalls what the first decided, without the developer doing anything manually.
