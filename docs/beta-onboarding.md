# Beta User Onboarding Guide

**Last updated:** 2026-05-15  
**Scope:** Phase 1 closed beta — 10 users, up to 3 repos per user

---

## Before Onboarding Anyone: 4-Point Checklist

These must be done before asking any user to connect a real repo. They are trust signals, not full enterprise security — appropriate for a closed beta with known contacts.

### 1. Add per-project basic auth

The Phase 1 instance has no access controls between users. Without this, a user querying a `project_id` could retrieve content from another user's repo.

- Issue each beta user a unique token scoped to their projects
- Add token validation middleware to `POST /brain/query` and all read endpoints
- A shared secret per project is sufficient for the beta — full JWT auth is Phase 4

### 2. Write and share a data handling doc

A one-page plain-language doc removes the trust barrier faster than any technical control. It must cover:

- **What gets sent to the Claude API:** PR descriptions, review comments, issue titles and bodies, commit messages. Not code diffs or file contents unless they appear in PR descriptions.
- **What is stored on the VM:** Normalized event records, extracted entities, vector embeddings, graph nodes. No raw source system credentials.
- **Who can access the VM:** Currently only the operator (Deepak). No third parties.
- **How to request deletion:** Email or message the operator. A project namespace can be wiped on request. Target: `DELETE /brain/project/{id}` endpoint before beta launch.
- **Anthropic API data policy:** Anthropic does not train on API data by default. Link to Anthropic's usage policy for reference.

Share this doc with every beta user before they connect a repo. Do not skip this step even for close contacts.

### 3. Request minimal GitHub scopes

When users connect a repo, the OAuth flow must request only:

| Scope | Reason |
|---|---|
| `contents:read` | Read PR descriptions, issue bodies, commit messages |
| `pull_requests:read` | Read PR metadata and review comments |
| `issues:read` | Read issue metadata and comments |

No write scopes. No admin scopes. Users will scrutinize the OAuth permission screen — a write or admin scope will cause drop-off. If the permission screen shows more than read access, fix it before onboarding.

### 4. Add `DELETE /brain/project/{id}` endpoint

Users need to know they have an exit. Before onboarding:

- Implement the delete endpoint: removes all graph nodes, vector chunks, and Redis stream data associated with a `project_id`
- Tell every user the endpoint exists and that deletion is immediate and complete
- This endpoint does not revoke the GitHub OAuth token — instruct users to revoke that themselves from GitHub settings if they want a clean exit

---

## What to Tell Beta Users

Send this (or a version of it) before onboarding:

---

*"Here's what happens when you connect a repo to Project Brain:*

*GitHub sends PR events, issue updates, and review comments to the brain via webhook. The brain extracts decisions and key entities from that content using Claude (Anthropic's API) and stores them in a knowledge graph on a VM I control. Your actual code files are not ingested — only the text content that appears in PRs, issues, and review comments.*

*The Claude API does not use your content to train its models. The VM is not shared with anyone outside this beta group.*

*You can ask me to delete your project data at any time — I'll wipe it within 24 hours. You can also revoke the GitHub OAuth access from your GitHub settings at any time.*

*The GitHub permissions the app requests are read-only: PR content, issues, and commit messages. No write access."*

---

## Beta User Setup Flow

Once the 4-point checklist is complete, onboarding a user takes ~10 minutes.

**Step 1 — Share access**
- Provide the beta URL and their project token
- Confirm they've read the data handling doc

**Step 2 — Connect a repo**
- User opens the chat UI → Project Setup
- Enters GitHub repo URL and project name
- Completes the GitHub OAuth flow (read-only scopes)
- Optionally uploads `module_map.json` to label codebase modules

**Step 3 — Initial ingest**
- The brain pulls the last 90 days of PRs and issues from the repo
- Ingestion progress shown in the UI
- Typical time: 5–15 minutes depending on repo activity volume

**Step 4 — First query**
- Suggest a starter query: *"What decisions were made in the last 30 days?"*
- Walk the user through reading a citation card (source type, actor, timestamp, deep link)
- Confirm citations open the original GitHub source correctly

---

## Current Limitations to Communicate Upfront

Be explicit about these before users invest time. Surprises after onboarding cause drop-off.

| Limitation | When it's fixed |
|---|---|
| No user-level access control — all beta users share one instance | Phase 4 |
| GitHub only — no Slack, Jira, or Linear | Phase 2–3 |
| No permission mirroring — brain does not enforce GitHub repo visibility rules | Post-Phase 4 |
| No mobile UI | Post-Phase 4 |
| Best-effort uptime — no SLA, VM may restart during updates | POC phase |
| Query latency can spike during initial ingest of large repos | Known; no fix in Phase 1 |

---

## Known Multi-Tenancy Gaps

For transparency with technical beta users who ask:

The brain uses `project_id` as its isolation unit — all data, graph nodes, and vector chunks are namespaced per project. However, Phase 1 has no authentication layer enforcing that a user can only query their own projects. The per-project token (checklist item 1) is a compensating control for the beta period.

Full user-level access control with permission mirroring from source systems is a Phase 4 commitment. See `docs/technical/architecture.md` for the full design.

---

## Beta Feedback Collection

After each user has queried the brain for at least one week, collect structured feedback:

1. Did you find the answers accurate? (Yes / Mostly / No)
2. Did citations correctly link to the source? (Yes / Sometimes / No)
3. How long did it take to reach productive context on a task you'd been away from? (minutes)
4. What was missing that you expected to find?
5. Would you connect a second repo? (Yes / Maybe / No)

Target: 3 complete responses minimum before Phase 1 exit criterion is assessed.
