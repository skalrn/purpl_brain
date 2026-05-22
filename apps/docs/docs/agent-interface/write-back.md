---
sidebar_position: 4
---

# Agent Write-Back

## The write-back problem

The brain's value is entirely dependent on agents writing to it. An agent that queries the brain at session start and finds nothing concludes the product does not work. An agent that writes nothing to the brain after making a dozen decisions leaves the brain in the same empty state for the next session. The cold-start problem is severe: a new installation produces nothing from `brain_query` until agents have populated it, but agents only populate it if they are configured to do so, and configuration requires a developer who is willing to invest in a system that currently returns nothing.

Two distinct failure modes require different interventions. Both look the same to the user (the brain is not useful), but they have completely different causes and fixes.

**Failure mode A: trigger discipline.** The agent does not call `brain_log_decision` at all. The session ends — cleanly, via context compaction, or through interruption — and no decisions are written.

**Failure mode B: content quality.** The agent calls the tool but logs noise: no rationale, trivial decisions ("added a helper function"), missing alternatives. A brain full of low-signal entries returns results for every query, but none of them help the next agent pick up where the previous one left off. This failure mode is harder to diagnose than an empty brain.

## Compliance by setup type

| Setup | Write-back compliance |
|---|---|
| Claude Code with Stop hook | 85-90% |
| Claude Code without Stop hook | 60-70% |
| Cursor (.cursor/rules instruction only) | 40-60% |
| LangGraph with BrainCallbackHandler | >95% |
| ADK with BrainSession context manager | >95% |

Cursor has no hook system. The 40-60% compliance for Cursor sessions comes from instruction-following variance. There is no automated enforcement for Cursor beyond the schema validation gate that rejects low-quality submissions.

## The Stop hook

The Claude Code Stop hook is a shell script at `.claude/hooks/check-brain-decisions.sh`. Claude Code runs this script when a session ends. If the script exits with code 2, Claude Code feeds the stderr output back to the agent as one final turn, giving the agent an opportunity to write the missing decisions.

The implementation has three non-obvious design choices that are all necessary:

**Why stderr, not stdout:** Claude Code hook output must go to stderr to feed back to the agent. stdout is ignored. The hook must print its message to `>&2`, not to stdout.

**Why exit code 2, not exit code 1:** Exit code 1 triggers a hard stop. Exit code 2 triggers a re-entry turn where the agent can see the hook's message and respond. The distinction is not documented prominently in Claude Code's hook documentation.

**Why Neo4j directly, not `brain_query`:** The hook needs to check whether decisions were logged in the current session window (approximately the last 2 hours). Using `brain_query` for this would require interpreting a natural language answer. Using Neo4j directly gives a deterministic count query:

```cypher
MATCH (d:Decision)
WHERE d.created_at > datetime() - duration('PT2H')
  AND d.project_id = $project_id
RETURN count(d) as decision_count
```

If `decision_count = 0`, the hook prints a message to stderr and exits 2. The agent sees: "No decisions logged in the last 2 hours. Before this session ends, review what was decided and call brain_log_decision for each significant choice."

## Schema validation gate

Server-side validation on `POST /brain/agent-log` enforces minimum quality standards:

**422 with `violations[]` (hard rejection):**
- `description` shorter than 20 characters
- `rationale` missing or empty
- `work_completed` shorter than 10 characters

**202 with `warnings[]` (accepted, flagged):**
- `alternatives_considered` absent or empty

The violations response is structured so the agent can read it and retry:

```json
{
  "error": "Schema validation failed",
  "violations": [
    {
      "decision_id": "my-decision",
      "field": "rationale",
      "message": "rationale is required and must not be empty"
    },
    {
      "decision_id": "my-decision",
      "field": "description",
      "message": "description must be at least 20 characters"
    }
  ]
}
```

The agent can read this, improve the decision log, and retry. This is significantly better than a generic 400 — the structured response tells the agent exactly what to fix.

## Onboarding seed (pre-beta)

The cold-start problem cannot be fully solved by compliance tooling alone. A new user who installs the brain and immediately runs an agent session will get an empty brain query result on the first session — there is simply nothing to return yet.

The onboarding seed mitigation: before the first agent session, the UI (SeedBrainBanner) prompts the user to create one manual decision log documenting the project's existing architectural state. This gives the brain enough content to return meaningful results from `brain_query` in session one, which is what motivates the developer to continue using the brain.

Seed content does not need to be comprehensive. One decision log with 3-5 meaningful decisions about the project's stack, key constraints, and recent choices is enough to demonstrate that the brain has context worth reading.

## Auto-extraction fallback (deferred post-beta)

For sessions where no decision was logged but file changes occurred, an auto-extraction fallback could run transcript extraction at `confidence: "low"` to recover decisions that were made but not explicitly logged. This is deferred post-beta — the approach requires beta validation to determine whether low-confidence auto-extracted decisions are useful or just noise that needs manual cleanup.

The concern: automatically populating the brain with low-quality decisions is failure mode B materialized as a feature. If auto-extracted decisions are not clearly labeled as low-confidence and distinct from agent-logged decisions, the noise damages trust in query results.

## The WriteBackQualityBadge

The UI exposes a `WriteBackQualityBadge` at the project level. Green means all logged decisions have `alternatives_considered`. Amber means none do. This surfaces the failure mode B problem to developers without requiring them to audit individual decision logs.

The badge is not a compliance metric — it does not count write-back calls. It measures content quality. A project can have 100% write-back compliance and still show amber if every decision log is missing alternatives. The distinction matters because it directs attention to the right intervention.
