# Risk Register — Project Brain

**Last Updated:** 2026-05-15  
**Owner:** Deepak Kollipalli  

---

## How to Read This Register

Each risk has a **Likelihood** (L: 1–3) and **Impact** (I: 1–3). **Exposure = L × I.** Risks with exposure ≥ 6 are high-priority and have mitigation plans.

| Likelihood | Impact | Exposure | Priority |
|---|---|---|---|
| 1 = Unlikely | 1 = Minor | 1–2 = Low | Monitor |
| 2 = Possible | 2 = Moderate | 3–4 = Medium | Mitigate |
| 3 = Likely | 3 = Severe | 6–9 = High | Act now |

---

## Technical Risks

| ID | Risk | L | I | Exposure | Mitigation |
|---|---|---|---|---|---|
| T1 | Brain becomes stale or inconsistent when a source system changes its webhook format or API | 3 | 2 | 6 | Version webhook parsers per source; integration tests against source API sandbox; alerting on parse failure rate |
| T2 | Vector + graph store synchronization failure — a chunk is written to vector store but graph edge creation fails | 2 | 3 | 6 | Write to graph first; vector write is follow-on; compensating transaction on failure; reconciliation job runs nightly |
| T3 | LLM (Claude) hallucination in grounded answers — cites a source that doesn't support the answer | 2 | 3 | 6 | Strict citation enforcement in prompt: each claim must map to a retrieved chunk; hallucination eval suite before release |
| T4 | Entity extraction quality is too low to create meaningful graph edges | 2 | 2 | 4 | Evaluate extraction quality in Phase 1 on real repos; fall back to keyword matching if LLM extraction is unreliable |
| T5 | Contradiction detection generates too many false positives, training users to ignore alerts | 3 | 2 | 6 | Tunable threshold per project; feedback loop (user marks alert as useful/not useful); start conservative |
| T6 | Agent decision log schema is too rigid — real agent sessions don't fit cleanly | 2 | 2 | 4 | Keep schema minimal in v1; most fields optional except `session_id`, `project_id`, `decisions[]`; iterate based on Phase 2 testing |
| T7 | Ingestion pipeline latency exceeds 5-minute anomaly detection target under load | 1 | 2 | 2 | Acceptable risk at POC scale; instrument and monitor; Redis Streams provides backpressure |

---

## Product / Scope Risks

| ID | Risk | L | I | Exposure | Mitigation |
|---|---|---|---|---|---|
| P1 | Scope creep — each phase expands before the prior thesis is proven | 3 | 3 | 9 | Hard phase gates: phase N does not start until Phase N-1 exit criterion is met and documented |
| P2 | Integration complexity with Slack / Jira consumes disproportionate engineering time in Phase 3 | 3 | 2 | 6 | Phase 1 and 2 are GitHub + agent only — no Slack/Jira until Phase 3 to defer this risk |
| P3 | The chat UI becomes a product distraction — too much effort spent on UX vs. the brain | 2 | 2 | 4 | Phase 1 UI is intentionally minimal (basic HTML + Tailwind); no polished UX work until Phase 4 |
| P4 | "Context in under 60 seconds" is hard to measure and demo convincingly | 2 | 2 | 4 | Define the demo scenario precisely: specific repo, specific time gap, specific question; record baseline time before and after |
| P5 | Meeting transcript ingestion proves too noisy to provide signal — too much irrelevant content | 2 | 1 | 2 | Deferred to Phase 4; low risk to Phase 1–3; validate with a small transcript sample before committing to full integration |

---

## Market / Competitive Risks

| ID | Risk | L | I | Exposure | Mitigation |
|---|---|---|---|---|---|
| M1 | GitHub Copilot Workspace or Cursor ships persistent cross-session agent memory before Phase 2 is complete | 2 | 3 | 6 | Focus differentiation on cross-surface synthesis and multi-product graph — these are harder to ship as a feature bolt-on to a single tool |
| M2 | Atlassian or Linear ships a "project brain" feature that covers Phase 1–2 functionality | 1 | 3 | 3 | These tools are siloed by design; cross-surface synthesis and agent write-back are architectural commitments they are unlikely to make quickly |
| M3 | The trusted user POC group is too small to generate meaningful feedback | 2 | 2 | 4 | Target 3–5 users minimum; choose users with real context-switching pain (not just friendly reviewers); structured feedback questionnaire |

---

## Privacy and Security Risks

| ID | Risk | L | I | Exposure | Mitigation |
|---|---|---|---|---|---|
| S1 | Brain ingests data from private Slack channels or repos a user shouldn't access | 2 | 3 | 6 | Phase 1: project-level access control (users access only projects they are added to); full permission mirroring from source systems deferred to post-Phase 4 |
| S2 | Agent API keys for brain write-back are leaked or misused | 2 | 2 | 4 | Short-lived API keys; key rotation support; rate limiting on `POST /brain/agent-log` per key |
| S3 | Source system OAuth tokens stored insecurely | 1 | 3 | 3 | Tokens stored encrypted at rest; never logged; rotation handled via standard OAuth refresh flow |

---

## Open Risks (Not Yet Assessed)

- How does the brain handle projects that span multiple organizations (e.g., a contractor working across client codebases)?
- What is the data deletion / right-to-be-forgotten model when a team member leaves?
- At what point does the brain's knowledge graph become too large for the graph DB to query efficiently, and what is the sharding strategy?

---

## Open Questions (Must Resolve Before or During Phase 1)

| ID | Question | Why It Matters | When to Resolve |
|---|---|---|---|
| OQ1 | What is the baseline context-reconstruction time without the brain? | Without a before-measurement, the Phase 1 exit criterion cannot prove value even if the product works correctly. | Before Phase 1 exit — set up measurement at beta launch |
| OQ2 | How will feedback be collected from beta users in practice? | A 5-question survey exists but no collection mechanism. Users won't fill out forms unprompted; structured signal requires a built-in habit (weekly check-in, Slack thread). | Before first user is onboarded |
| OQ3 | Which repos and PRs will be used for the Milestone 2 extraction eval, and are they labeled? | The eval checkpoint requires 10 labeled PRs before moving to Milestone 3. Labeling is pre-work that shapes the extraction prompt design — skipping it means tuning blind. | Before Milestone 2 starts |
| OQ4 | Is the GitHub OAuth app created and does the callback URL point to a stable host? | The beta setup flow requires a registered GitHub OAuth app with read-only scopes. This blocks the first user onboarding and requires the ngrok → VM transition to be complete first. | Before first user is onboarded |
| OQ5 | What is the operator's explicit stance on ingesting private repo content via the Anthropic API? | Beta users with private repos containing sensitive business logic or unreleased product details will ask. Referencing Anthropic's data policy is not sufficient — a clear operator position is needed before anyone connects a private repo. | Before first user is onboarded |
| OQ6 | What specific agent will write to the brain in Phase 2, and what does its write-back look like? | Phase 2 (agent write-back loop) has no concrete entry point without a named agent. Without this, the Phase 1 → Phase 2 transition has no defined first step. | Before Phase 1 exit criterion is declared met |
| OQ7 | What is the incident response plan when the beta VM or a pipeline component goes down? | Beta users hitting a broken brain have no way to distinguish a system failure from a bad query. Minimum needed: a status signal, a webhook consumer health check, and a user-facing issue reporting path. | Before first user is onboarded |
