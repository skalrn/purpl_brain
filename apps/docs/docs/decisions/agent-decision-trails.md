---
sidebar_position: 4
---

# ADR-004: Agent Decision Trails as a First-Class Brain Source

**Status:** Accepted | **Date:** 2026-05-15

## The problem

AI agents make consequential decisions during a session — library choices, architectural patterns, error handling approaches, tradeoff resolutions. These decisions are currently lost at session end. The next actor (human or agent) must re-derive context, potentially contradicting prior choices.

Two approaches were considered: (1) treat agents as passive consumers of the brain only — they read context but do not write to it, or (2) treat agents as first-class actors that both read from and write to the brain.

## The decision

**Agents are first-class brain actors.** They read context on session start and write structured decision logs at defined checkpoints. Agent-emitted decision logs are ingested, processed, and stored with the same priority as human-generated signals. They are subject to drift detection, citation, and temporal versioning.

## The decision log schema

The schema is the most important design artifact in this ADR. Decisions about what fields to include, what is required, and what is optional directly affect drift detection accuracy, query quality, and the write-back compliance gap.

```json
{
  "schema_version": "1.0",
  "session_id": "unique-per-session",
  "agent_id": "claude-code",
  "operator": { "id": "developer@company.com", "name": "Developer" },
  "task_id": "PROJ-412",
  "project_id": "brain-project-namespace",
  "codebase": "https://github.com/org/repo",
  "timestamp_start": "2026-05-22T10:00:00Z",
  "timestamp_end": "2026-05-22T11:30:00Z",
  "decisions": [
    {
      "id": "redis-revocation-list",
      "description": "Store session revocation list in Redis",
      "rationale": "Low-latency lookup on every auth request; TTL-native eviction avoids scheduled cleanup",
      "alternatives_considered": ["Postgres", "in-memory with restart-risk"],
      "confidence": "high"
    }
  ],
  "work_completed": "Added Redis-based session revocation to auth-service",
  "unresolved": ["Do we need a per-user revoke-all endpoint?"],
  "next_steps": ["Add revocation check to the token validation middleware"],
  "files_modified": ["apps/api/src/auth/revocation.ts"]
}
```

**Why `alternatives_considered` matters for drift detection:** If an agent explicitly rejects "long-lived tokens" as an alternative, and a human later decides to use them, semantic similarity may miss this — the phrasing is different enough that the cosine similarity falls below the threshold. The structured alternatives list makes it a deterministic lookup: "does this new decision match any `alternatives_considered` in existing agent-sourced decisions?" No LLM needed, no threshold to tune.

**Why `session_id` is the deduplication key:** Agents can fail and retry. If the same session writes the same decisions twice, the brain should not create duplicate nodes. Session ID is stored in Redis on first write; subsequent writes with the same ID are idempotent.

**Why `confidence` is agent-controlled:** The agent knows how certain it is better than any post-hoc inference system. A high-confidence decision made after explicit evaluation is different from a medium-confidence decision made under uncertainty. The confidence field flows through to the drift detector — low-confidence agent decisions do not trigger alerts against high-confidence human decisions.

## What was rejected

**Agents as read-only consumers:** This captures only half the value. The novel insight is that agent decisions are the *most important* missing context — they are invisible to all current tools. Provider memory (Claude Projects, Cursor Rules) is human-authored. Agent decisions are not captured anywhere. Not capturing them means the brain cannot serve agent continuity, which is the primary use case.

**Automatic session capture (instrument the runtime):** Feasible for Claude via the streaming API — tool call events are observable. But complex and brittle for third-party agents. Explicit emission is simpler, and the data quality is higher: an agent explicitly thinking about "what did I decide" produces better structured output than extraction from raw session output.

**Natural language session summaries only:** Unstructured summaries cannot be reliably parsed for entity extraction, graph linking, or contradiction detection. "Decided to use Redis for caching" in a paragraph is harder to extract than `{ "description": "Use Redis for caching", "rationale": "...", "alternatives_considered": [...] }` in structured JSON.

## Compliance engineering

The schema being well-designed is not enough. The agent must actually call the write-back tool, and the content must meet quality standards. This led to a parallel set of compliance engineering decisions:

**Stop hook for Claude Code:** A shell script that runs at session end, queries Neo4j for decisions logged in the current window, and exits with code 2 if none are found. Code 2 triggers a re-entry turn where the agent can see the hook's message.

**`BrainCallbackHandler` for LangGraph:** Calls `flush()` on `on_chain_end` and `on_chain_error`. Automated — the developer does not need to remember to flush.

**`BrainSession` context manager for ADK:** `__exit__` calls `flush()` on normal exit and exceptions.

**422 validation gate:** Server-side rejection with structured `violations[]` for missing rationale or short descriptions. Forces the agent to write something meaningful or not write at all.

## Consequences

The schema is a contract. Breaking changes require versioning — the `schema_version` field exists for this reason. Any change to required fields that would reject previously valid logs is a breaking change and must be treated as such.

Agents that do not emit logs still benefit from reading the brain. The write-back loop is additive — a read-only agent gets context from prior sessions; it just does not contribute to future sessions. This asymmetry means partial adoption still provides value: even 60% write-back compliance means 60% of sessions contribute to the brain, and every session benefits from what those sessions contributed.
