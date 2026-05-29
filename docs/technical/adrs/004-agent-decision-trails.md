# ADR-004: Agent Decision Trails as a First-Class Brain Source

**Status:** Accepted  
**Date:** 2026-05-15  
**Deciders:** Deepak Kollipalli  

---

## Context

AI codegen and design agents make consequential decisions during a session — library choices, architectural patterns, error handling approaches, tradeoff resolutions. These decisions are currently lost at session end. The next actor (human or agent) must re-derive context, potentially contradicting prior choices.

Two approaches were considered: (1) treat agents as passive consumers of the brain only, or (2) treat agents as first-class actors that both read from and write to the brain.

## Decision

**Agents are first-class brain actors.** They read context on session start and write structured decision logs on session end (or at defined checkpoints). Agent-emitted decision logs are ingested, processed, and stored with the same priority and visibility as human-generated signals.

**Decision log schema (v1):**
```json
{
  "schema_version": "1.0",
  "session_id": "uuid — unique per agent session",
  "agent_id": "identifier for the agent type/instance",
  "operator": { "id": "sam@company.com", "name": "Sam" },
  "task_id": "associated Jira/Linear ticket ID or description",
  "project_id": "brain project namespace",
  "codebase": "repo URL or identifier",
  "timestamp_start": "ISO 8601",
  "timestamp_end": "ISO 8601",
  "decisions": [
    {
      "id": "uuid",
      "description": "chose REST over GraphQL for the public API",
      "rationale": "GraphQL overhead not justified for the current query patterns; can revisit if mobile client is added",
      "alternatives_considered": ["GraphQL", "gRPC"],
      "confidence": "high | medium | low"
    }
  ],
  "work_completed": "free text summary of what was built",
  "unresolved": ["list of questions or blockers the agent did not resolve"],
  "next_steps": ["recommended follow-on actions"],
  "files_modified": ["list of file paths touched"]
}
```

**Emission:** Agents emit logs by calling `POST /brain/agent-log`. Authentication is via API key (one key per agent instance in Phase 2; more granular identity model deferred).

**Phase 2 constraint:** Agents must explicitly emit logs — automatic instrumentation is not implemented in Phase 2. The reference implementation (Claude via API) will include a prompt template that instructs the agent to emit a structured log at session end.

## Alternatives Considered

**Agents as read-only brain consumers**  
Rejected. This captures only half the value. The novel insight is that agent decisions are the *most important* missing context — they are invisible to all current tools. Not capturing them means the brain cannot serve agent continuity, which is a primary use case.

**Automatic session capture (instrument the agent runtime)**  
Deferred to post-Phase 2. Requires access to the agent's internal tool call log or streaming output. Feasible for Claude via the API (streaming tool use events), but complex and brittle for third-party agents. Explicit emission is simpler and sufficient for the POC.

**Natural language session summaries only (no structured schema)**  
Rejected. Unstructured summaries cannot be reliably parsed for entity extraction, graph linking, or contradiction detection. The structured schema enables the processing pipeline to treat agent decisions the same as human decisions — with typed graph edges and queryable fields.

## Consequences

- A published decision log schema is a contract — breaking changes require versioning (`schema_version` field included for this reason)
- Agents that do not emit logs still benefit from reading the brain; the write-back loop is additive, not required
- The prompt template for structured log emission must be maintained as the reference implementation for developers integrating agents
- In Phase 4, automatic instrumentation (no explicit log emission required) becomes feasible and should be explored for Claude via streaming API

## Future Enhancements

**A2A compatibility:** A2A (Agent-to-Agent) and purpl-brain answer different questions. A2A answers "has this task been completed?" — purpl-brain answers "why was this decided, what alternatives were considered, and has anything since contradicted it?" In an A2A deployment, agents would use A2A for task handoff and call `brain_query` to load decision rationale. The protocols are complementary, not competing. Real-time drift notification via A2A push is a future path once agent runtimes adopt stable A2A endpoints.

**Infrastructure agents:** The `POST /brain/agent-log` schema works unchanged for infrastructure agents (schema migrations, topic partitioning, index strategy). The integration pattern — `brain_analyze_impact` before a destructive operation, `brain_log_decision` after — is the same as for coding agents. No schema changes needed.
