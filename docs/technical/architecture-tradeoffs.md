# Architecture Tradeoffs

Significant design decisions in purpl-brain, with rationale and the alternatives that were considered and rejected.

---

## 0. Competitive positioning — why not LangGraph, mem0, or Zep

Verified against current documentation and Perplexity research, mid-2026.

| Capability | LangGraph (OSS) | CrewAI | AutoGen/AG2 | mem0 | Zep | purpl-brain |
|---|---|---|---|---|---|---|
| Cross-session shared memory | ✓ JSON Store | ✓ SQLite + embeddings | Partial | ✓ hosted | ✓ hosted | ✓ |
| Schema enforcement at write time (rationale required) | ✗ any JSON | ✗ free-form | ✗ | ✗ | ✗ | ✓ |
| Proactive contradiction detection | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| External REST API (non-framework agents) | ✗ | ✗ | ✗ | ✓ (hosted) | ✓ (hosted) | ✓ |
| Human communication ingestion (Slack, GitHub, meetings) | Custom work | Custom work | Custom work | ✗ | ✗ | ✓ Partial |
| Self-hosted / open source | ✓ | ✓ | ✓ | Partial | Partial | ✓ |
| Zero infrastructure option | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |

**What this means:**

LangGraph's cross-thread Store is real and OSS as of October 2024. For teams already on LangGraph, it covers shared memory across agent threads without new infrastructure. purpl-brain is not a replacement for it — it is the governance layer on top: schema enforcement, contradiction detection, and a REST API accessible from any agent regardless of orchestration framework.

The gap all frameworks share: none have native proactive contradiction detection. Detecting when a new agent decision contradicts a prior one — across threads, across sessions, across agents — requires custom logic in every framework. purpl-brain provides this as a first-class primitive: SUPERSEDES edges, DriftAlerts with LLM confirmation, and webhook delivery before any agent queries.

The zero-infrastructure tradeoff: mem0 and Zep require no self-hosting. purpl-brain requires Neo4j + Qdrant + Redis. That cost is justified when contradiction detection and schema-enforced rationale are requirements — which they are not for teams that just need retrieval.

**Perplexity summary (mid-2026):** *"If your requirement is decision governance — schema-enforced rationale, alternatives, and automatic contradiction alerts — you will still need custom application logic or an external memory/governance layer on top of any of these frameworks."*

---

## 1. Agents write directly; humans go through the extraction pipeline

**Decision:** Agent decisions are written directly to Neo4j and Qdrant via `brain_log_decision` (structured JSON). Human signals (PRs, Slack threads, meeting transcripts) go through RAW → NORMALIZED → EXTRACTED.

**Why the distinction:** The extraction pipeline exists to find decisions in unstructured human text. Agents produce structured output because they are instructed to — running an agent-written decision record through LLM extraction would be noise-on-noise: asking a model to extract decisions from a JSON object that already *is* a decision record.

**Uniform pipeline for all sources:** Simpler architecture, single write path. The cost: you'd lose the structured fields agents provide (alternatives_considered, confidence, rationale as a separate field) by flattening everything into raw text before re-extracting it. Fidelity loss is not worth the architectural simplicity.

**Known weakness:** The agent's structured write is only as good as the agent's judgment about what constitutes a decision worth logging. An implicit decision in a human PR comment ("let's not do X because Y") may be caught by the extractor; an agent might not surface it unless explicitly prompted. This is why CLAUDE.md protocol and the Stop hook both exist — the instruction shapes in-session behavior, the hook enforces the boundary.

---

## 2. Stop hook + CLAUDE.md instructions — why both

**Decision:** CLAUDE.md instructs agents to log decisions at the moment they are made. The Stop hook checks at session close and blocks exit if nothing was logged in the last two hours.

**CLAUDE.md only:** Instructions are aspirational. Under context pressure (long sessions, complex tasks, context compaction), the agent deprioritizes logging. Without the hook, a meaningful fraction of sessions end without any decision logs even when CLAUDE.md is active.

**Hook only:** The Stop hook fires at session close. A decision made three hours into a four-hour session that gets compacted before the close is unrecoverable — the hook fires, the session logs something to pass the check, but the specific mid-session decisions are already gone. The instruction shapes in-session behavior; the hook catches the close.

**Known weakness:** The hook checks for *any* decision logged in the last two hours. A session that logged one trivial decision and missed four significant ones passes the check. The hook enforces presence, not quality or completeness. Enforcing quality would require an LLM call inside the hook to assess the logged decisions — which is slow and introduces a flaky hard gate. Acceptable tradeoff: presence enforcement is better than nothing; quality depends on CLAUDE.md instruction discipline.

---

## 3. Decision as the unit of memory

**Decision:** The stored unit is a structured decision record: choice + rationale + alternatives considered + confidence + actor + timestamp. Not a document, not a session transcript.

**Session transcripts:** High recall, low precision. Every word the agent said is in there. Retrieval is expensive and noisy. Signal-to-noise degrades with session length. You'd need extraction on retrieval (not just on ingestion), which doubles LLM costs.

**Documents (ADRs, runbooks):** Correct for decisions significant enough to warrant formal treatment. The gap this system fills is exactly the decisions that did not make it into a document — the ones that clear the implementation threshold but not the ADR threshold. Storing documents doesn't solve the informal decision gap.

**Known weakness:** The decision schema has opinions baked in. Decisions that don't fit the `description + rationale + alternatives_considered + confidence` shape — emergent constraints discovered mid-session, implicit rejections, discovered dependencies — get forced into the schema with some fidelity loss. The `brain_log_signal` tool exists as a safety valve for things that don't cleanly fit the decision shape.

---

## 4. project_id as tenant isolation

**Decision:** All nodes in Neo4j and all points in Qdrant carry a `project_id` field. Every query, write, and drift check is scoped by project_id at the service layer.

**Separate collections/databases per project:** Schema overhead and operational complexity scale with the number of projects. A separate Qdrant collection per project means separate index tuning, separate backup configs, separate connection strings. project_id as a filter is simpler and sufficient for the current scale.

**Row-level security in Postgres:** Mature, well-understood. Would require migrating off Qdrant and Neo4j — losing the vector and graph capabilities that justify the hybrid architecture in the first place.

**Known weakness:** A bug in any query that omits the project_id filter bleeds data across projects. This has happened in practice (Stop hook logging decisions to the wrong project_id when it fired from a different repository). Mitigated by enforcing project_id as a required parameter at the service method level, never as an optional filter. Any query that doesn't take a project_id parameter is a code smell.
