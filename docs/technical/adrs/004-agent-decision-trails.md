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

### A2A Notification Path for Live Agent Sessions

The current model is pull-based: agents emit a log at session end, and the next session reads it. This leaves a gap for long-running agent sessions that span hours — they are unaware of `DriftAlert` nodes created after they started.

**A2A-based push notification:**

If an agent session registers itself as an A2A-addressable endpoint at session start (supplying its A2A callback URL alongside `POST /brain/agent-log` or a new `POST /brain/agent-sessions/register` endpoint), the brain can deliver drift alerts as inbound A2A messages:

```
POST <agent-a2a-url>
{
  "type": "drift_alert",
  "alert_id": "...",
  "severity": "high",
  "summary": "Your current session may be building on a decision that was contradicted 12 minutes ago",
  "brain_query_hint": "use brain_query with mode=conflict to retrieve details"
}
```

This converts drift detection from an asynchronous post-session concern to a real-time in-session signal. The agent can choose to pause, query the brain, and adjust before committing contradictory code.

**Cross-agent coordination scenario this addresses:**

Multiple agents working on adjacent features in the same project. Agent A (working on payments) decides to use PostgreSQL for session storage at T=0. Agent B (working on auth) decides Redis at T=1. Brain detects contradiction at T=2 and creates a `DriftAlert`. Currently, neither running agent is notified — they find out at next session start. With A2A, the brain notifies both within seconds.

**Why deferred:** Most agents today run as short ephemeral CLI invocations without stable A2A endpoints. This enhancement becomes viable as more agent runtimes adopt A2A as a persistent service model. The brain-side implementation (watching for DriftAlert creation and dispatching notifications) can be added independently once agent A2A adoption is sufficient to justify it.

### Infrastructure Agent Decision Trails

The current agent log schema is designed around coding agents. Infrastructure agents — those using Postgres MCP, Cassandra MCP, Kafka MCP, or similar data-store tool servers — make equally consequential decisions: schema migrations, topic partitioning, index strategy, keyspace design. These decisions are currently invisible to the brain.

**Two additions to the agent trail protocol for infra agents:**

**1. Pre-flight check before destructive operations**

Before executing a DDL change or schema migration, an infra agent should call `brain_analyze_impact` with the operation description. The brain queries for semantically similar prior decisions and surfaces conflicts. Example: an agent about to drop a Cassandra table is told "session `abc` decided this keyspace is being deprecated in favour of PostgreSQL — see PR #201." The agent pauses and surfaces this to the developer instead of executing.

**2. Post-execution decision log**

After a successful schema change, the infra agent calls `POST /brain/agent-log` with the operation as a structured decision:

```json
{
  "agent_id": "cassandra-migration-agent",
  "project_id": "checkout-service",
  "decisions": [{
    "description": "Added compound partition key (tenant_id, order_id) to orders table",
    "rationale": "Single-column partition key caused hotspots at >10k orders/tenant",
    "alternatives_considered": ["bucketing by date", "denormalized read table"],
    "confidence": "high"
  }],
  "work_completed": "Applied migration V12 to orders keyspace",
  "files_modified": ["migrations/V12__orders_partition_key.cql"]
}
```

This makes schema decisions first-class brain entries — queryable alongside code decisions, subject to the same drift detection, and citable in future sessions. A coding agent building the orders service query layer will retrieve the partition key decision when it calls `brain_query` on session start.

**Why this matters for Profile B:** A concurrent-project developer running overnight infrastructure agents across multiple projects has no visibility into schema decisions those agents made. The brain becomes the overnight ledger — every infra change is logged, drift-checked, and surfaced in the morning dashboard.
