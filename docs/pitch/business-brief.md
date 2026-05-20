# Purpl Brain — Business Brief

**Shared, auditable working memory for AI-assisted software teams.**

---

## The Problem

AI coding tools are everywhere. Claude Code, Cursor, GitHub Copilot, and custom agents are now standard equipment for software teams. Most engineering teams run three to five of these tools simultaneously.

They all share one critical flaw: **they do not remember each other.**

Every AI coding session starts from zero. When a developer opens Cursor on Tuesday, it has no knowledge of what Claude Code decided on Monday. Neither tool knows what was discussed in last week's architecture meeting. When something breaks, there is no record of what the AI recommended and why.

This creates three compounding problems:

**Lost time.** Engineers lose 45 to 90 minutes per context switch re-establishing what was decided and why. On a team of ten engineers making two context switches per day, that is 150 to 300 engineer-hours lost per month — before accounting for the rework caused by the mistakes below.

**Contradictory decisions.** Without shared memory, agents re-derive answers independently. They guess. They contradict each other. A decision made by one agent about database schema or caching strategy gets silently overridden by another agent three days later. The contradiction becomes a bug weeks after the fact.

**No audit trail.** When an AI-assisted feature causes a production incident, teams cannot answer the most basic questions: what did the agent decide, based on what information, and when? There is no record. This is an operational risk — and in regulated industries, a compliance risk.

Existing workarounds — Claude Projects, Cursor Rules, ChatGPT memory — are per-tool, per-user, and unstructured. They do not share across tools, do not cite sources, and do not detect contradictions. They are personal notepads, not team memory.

---

## The Solution: Purpl Brain

Purpl Brain is a shared, auditable working memory layer that sits between all AI tools and the team's knowledge base. Every agent reads from it. Every agent writes to it. Humans can query it in plain language.

**Four core capabilities:**

**1. Cross-tool shared memory.** One brain, any agent. Claude Code, Cursor, Copilot, and custom agents all connect to the same memory store via MCP (Model Context Protocol) — the emerging standard for agent integration published by Anthropic and now adopted across all major AI tool vendors. No custom integration required.

**2. Auditable, cited answers.** Every query response is grounded in real sources — GitHub pull requests, Jira tickets, Slack threads, meeting transcripts, agent session logs. A team member can ask "what did we decide about caching on May 3rd and which PR caused it?" and receive a sourced answer with timestamps, authors, and links. No hallucination. No guessing.

**3. Drift and contradiction detection.** When a new signal — a pull request, a Slack message, an agent decision — contradicts a prior decision stored in the brain, the system flags it automatically for human review. Architectural drift is caught before it becomes a bug or a rework cycle.

**4. Ingestion from everywhere.** GitHub, Slack, Jira, meeting transcripts, local documentation, and agent session logs all feed into the same pipeline. The brain builds a continuously updated knowledge graph from every source the team already uses.

---

## Demonstrated Performance

Purpl Brain is not a prototype. It is a working system with measured results.

| Metric | Result |
|---|---|
| Cross-session recall | 5/5 (100%) — decisions from 3 agents over 3 weeks recalled correctly by a new session |
| Decision extraction F1 | 85.7% — precision 92.3%, recall 80.0%, against manually labeled ground truth |
| End-to-end answer recall | 91% — cold ingestion of Backstage (Spotify) public ADRs, 11/12 ground-truth questions |
| Query latency p50 / p95 | 4.7s / 9.8s (Anthropic Claude Haiku) |
| Pipeline correctness | 33/33 PASS — full pipeline from ingestion to drift detection |
| MCP tool correctness | 8/8 PASS — all four agent tools verified |
| Drift detection false positive rate | < 8% on benign content; ≥ 80% recall on known contradictions |
| Citation faithfulness | 0 fabricated citations across all query evals |
| Attribution accuracy | 5/5 (100%) — actor, source type, and quoted rationale all correct across 5 distinct agent_ids |
| Vectors and graph nodes from one real corpus run | 242 Qdrant vectors + 709 Neo4j nodes |
| Estimated LLM cost for active team of 10 | $5–15 per month |

The system runs end-to-end from a single `docker compose up` command in approximately five minutes.

---

## Market Opportunity

**Primary target: small AI-forward software teams (3–15 engineers)**

The acute pain is in teams where AI tools are already heavily adopted but no knowledge management infrastructure exists. Two distinct profiles:

**Profile A — The Agent Operator:** Individual developers and small teams who use Cursor, Claude Code, or Copilot as a daily driver and run 5–20 agent sessions per day. Pain: re-pasting context, agents contradicting prior decisions, no audit trail. They already pay $20–100/month for AI coding tools.

**Profile B — The Concurrent Project Developer:** Solo developers and micro-founders running 5–10 simultaneous AI-assisted projects, often with overnight or background autonomous agent runs. Pain: no oversight across projects — what did each agent decide while I was away, did any contradict each other across projects, what needs review before I push? This persona does not need a team collaboration story; they need a cross-project oversight dashboard for their own agent swarm. The multi-project dashboard is built for them.

Also included:
- Consultancies and agencies shipping multiple client projects simultaneously
- Startups where every engineer uses multiple AI tools and no one has time to maintain documentation

These teams are already paying for AI tools. They experience context-switch pain daily. No incumbent product addresses it.

**Secondary target: enterprise teams in regulated industries**

Finance and healthcare organizations are beginning to require auditable trails for AI-generated decisions. Purpl Brain is the only product that provides this at the agent decision level. BYOC packaging (see Revenue Model below) removes the data residency blocker for this segment.

**Why now:** AI agent adoption crossed a mainstream threshold in 2025. MCP is becoming the standard integration layer — Anthropic published the protocol, and adoption across tools is accelerating. The window to own the agent memory layer is open. No provider has incentive to build cross-tool memory that helps competitors; Purpl Brain has every incentive.

---

## Competitive Position

| Capability | Purpl Brain | Glean | Notion AI | GitHub Copilot | Google A2A |
|---|---|---|---|---|---|
| Cross-tool agent memory | Yes | No | No | No | No |
| Agent write-back (AI logs its own decisions) | Yes | No | No | No | No |
| Auditable citations (URL, timestamp, actor) | Yes | Partial | No | No | No |
| Drift and contradiction detection | Yes | No | No | No | No |
| Cross-session persistence | Yes | No | No | No | No |
| Real-time agent-to-agent messaging | No (future) | No | No | No | Yes |
| BYOC (data stays in your cloud) | Yes | No | No | No | N/A |
| Estimated cost — 10 engineers | $50–150/month | $1,000+/month | $160/month (limited) | $190/month | Open protocol |

**Note on Google A2A:** The Agent2Agent protocol is a synchronous transport layer for live agent-to-agent communication — real-time task delegation and capability discovery between agents that are both running. It is orthogonal to Purpl Brain: A2A solves "how do two running agents talk right now?"; Purpl Brain solves "how does an agent know what prior agents decided?". A2A has no persistence, no semantic conflict detection, no session continuity. A future integration (Purpl Brain as an A2A service endpoint delivering drift alert notifications to live agent sessions) is on the roadmap.

The fundamental difference: **AI agents are first-class write-back actors in Purpl Brain.** Every competitor treats AI as a query interface — something you ask questions of. Purpl Brain treats AI as a participant that both reads from and writes to shared team memory. That architectural distinction is not a feature; it is the category.

---

## Revenue Model

**SaaS — per seat subscription**

$15–30 per seat per month for small teams. Target buyer is the technical lead or CTO of an AI-forward startup or agency. No enterprise sales motion required at this tier.

**BYOC — Bring Your Own Cloud**

A CloudFormation or CDK stack that deploys the entire brain into the customer's own AWS account. Data never leaves their infrastructure. Billed through AWS Marketplace on metered usage. The MCP server runs locally as a thin proxy; the brain — vector store, graph database, query API — runs in their VPC.

BYOC targets regulated enterprise customers who will not send sensitive code context to a third-party SaaS. It removes the primary adoption blocker for finance and healthcare without requiring Purpl Brain to become a SOC 2 SaaS from day one. AWS Marketplace handles billing, procurement, and contract vehicle — reducing go-to-market cost significantly for the enterprise segment.

---

## Current Status

- **Phase 1 and 2 complete:** full ingestion pipeline (GitHub, Slack, Jira, meetings, agent logs), semantic drift detection, streaming natural-language query, web UI
- **Phase 3 in progress:** MCP server complete, agent write-back complete, MCP evaluation complete, beta distribution complete
- **Beta distribution:** Docker images via GitHub Container Registry, obfuscated closed-source build
- **Snapshot and restore:** brain state can be archived and restored from GitHub release artifacts — safe for teams to experiment without fear of data loss

---

## What We Are Looking For

We are seeking **3 to 10 beta teams** willing to run Purpl Brain locally for 30 days.

The ask is time, not money. No commitment, no data sharing, no payment.

In exchange, beta teams get early access to a working system and direct input into the product roadmap. We want to measure: query quality in real team conditions, drift detection false positive rate, and onboarding friction.

If you run a software team using multiple AI coding tools and context-switch overhead is real to you, we want to hear from you.

---

## Key Risks and Mitigations

**Provider capture.** Anthropic or Microsoft could ship native cross-session memory. Mitigation: no large AI provider will build shared memory that benefits competitors — the antitrust optics of Anthropic storing your GitHub and Slack data are prohibitive. BYOC and the audit trail are features providers structurally cannot offer.

**Query latency.** The 7-second average latency is acceptable for asynchronous context retrieval but not for inline autocomplete. Purpl Brain is positioned as a session-start context loader and explicit query tool, not a keystroke-level suggestion engine. This is a positioning choice, not a technical limitation.

**Execution risk.** Purpl Brain is currently a one-person project. The BYOC model via AWS Marketplace materially lowers go-to-market cost and reduces the sales motion required to reach the enterprise segment. The SaaS tier is self-serve from day one.

---

*Purpl Brain — contact: skalr251@gmail.com*
