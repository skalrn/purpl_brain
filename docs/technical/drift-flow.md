# Drift Detection Flow

Three diagrams — read in order.

1. **Single agent, happy path** — what exists today
2. **Parallel agents, conflict** — the ICP problem
3. **Proposed: push notification** — what closes the loop

---

## 1. Current pipeline — single agent, no conflict

```mermaid
sequenceDiagram
    actor Agent
    participant API as API /brain/agent-log
    participant Redis as Redis Streams
    participant BW as brain-writer
    participant DD as drift-detector
    participant Neo4j
    participant Qdrant

    Agent->>API: POST /brain/agent-log\n{ decisions: [...] }
    API->>API: quality gate\n(min chars, rationale present)
    API->>Redis: xadd events:extracted\n(bypasses normalizer/extractor\n— already structured)
    API-->>Agent: 202 { ok, event_id }\n← agent moves on, no feedback on conflicts

    Redis-->>BW: consume events:extracted
    BW->>Neo4j: MERGE Decision nodes\nMERGE AgentSession node\nlink EXTRACTED_FROM → Event
    BW->>Qdrant: upsert vector chunk\nhas_decisions: true

    Redis-->>DD: consume events:extracted
    DD->>Qdrant: Stage A — embed decision text\nsearch for similar confirmed decisions\n(score ≥ DRIFT_SEMANTIC_THRESHOLD 0.55)
    alt no candidates above threshold
        DD-->>Neo4j: nothing written
    else candidates found
        DD->>Neo4j: Stage C — LLM confirms conflict
        DD->>Neo4j: MERGE DriftAlert node\nCHALLENGES → Decision
        Note over Neo4j: DriftAlert sits pending\nNo one is notified
    end
```

**Gap:** the agent that created the conflict never learns about it. The DriftAlert exists in Neo4j but is only visible if a human opens the web inbox — or if the next agent session loads the `brain://project/...` MCP resource snapshot.

---

## 2. Parallel agents — the ICP problem

```mermaid
sequenceDiagram
    actor AgentA as Agent A\n(auth feature)
    actor AgentB as Agent B\n(session handling)
    participant API
    participant Redis
    participant BW as brain-writer
    participant DD as drift-detector
    participant Neo4j
    actor Human

    par Agent A and Agent B running simultaneously
        AgentA->>API: POST /brain/agent-log\n"Store tokens in Redis, TTL 24h"
        API->>Redis: xadd events:extracted [A]
        API-->>AgentA: 202 ← no conflict signal\n(Agent B's decision not in brain yet)

        AgentB->>API: POST /brain/agent-log\n"Do not persist tokens server-side,\nuse stateless JWT only"
        API->>Redis: xadd events:extracted [B]
        API-->>AgentB: 202 ← no conflict signal\n(Agent A's decision not in brain yet)
    end

    Note over AgentA,AgentB: Both agents continue writing code\nbased on conflicting assumptions

    Redis-->>BW: process [A] → Decision node written
    Redis-->>BW: process [B] → Decision node written

    Redis-->>DD: process [A] → Stage A search\n(B not in Qdrant yet — miss)
    Redis-->>DD: process [B] → Stage A search\n(A now in Qdrant — HIT)
    DD->>Neo4j: DriftAlert created\n"JWT-only conflicts with Redis token store"

    Note over Neo4j: DriftAlert: pending\nBoth agents: already merged conflicting code\nHuman: unaware

    Human->>Neo4j: opens drift inbox\n(hours or days later)
    Neo4j-->>Human: ⚠️ conflict found\n(too late to prevent — already merged)
```

**The problem:** the race window between two parallel agents means neither gets conflict feedback in time. By the time the DriftAlert is created, both agents have moved on. The human only sees the conflict when they check the inbox, which may be hours after the damage is done.

---

## 3. Proposed fix — push notification on DriftAlert creation

```mermaid
sequenceDiagram
    actor AgentA as Agent A
    actor AgentB as Agent B
    participant DD as drift-detector
    participant Neo4j
    participant Push as Push Notifier\n(new — end of drift-detector)
    participant Webhook as DRIFT_WEBHOOK_URL\n(Slack / custom endpoint)
    actor Human
    actor Coordinator as Coordinator Agent\n(optional)

    Note over AgentA,AgentB: Both agents log conflicting decisions\n(same race as Diagram 2)

    DD->>Neo4j: MERGE DriftAlert\nresolution: pending
    DD->>Push: emit drift alert payload\n{ alert_id, decision_a, decision_b,\n  risk: HIGH, project_id, timestamp }

    Push->>Webhook: POST DRIFT_WEBHOOK_URL\n{ alert }

    alt Webhook is a Slack channel
        Webhook-->>Human: ⚠️ Drift detected\n"JWT-only conflicts with Redis token store"\nAgent A · Agent B · 4 min ago\n[Review] [Dismiss]
        Human->>Neo4j: POST /brain/drift-alerts/:id/resolve\nresolution: "under_review"
        Human->>AgentA: intervene — stop, conflict found
        Human->>AgentB: intervene — stop, conflict found
    else Webhook is a coordinator agent endpoint
        Webhook-->>Coordinator: receives alert payload
        Coordinator->>Neo4j: brain_query — "what is the right auth approach?"
        Coordinator->>AgentA: signal to pause / rollback
        Coordinator->>AgentB: signal to pause / rollback
        Coordinator->>Neo4j: brain_log_decision\n"Resolved: use stateless JWT,\ntoken blacklist in Redis for logout only"
    end
```

**What changes in code:**

```
drift-detector.ts — after writeDriftAlert():
  if (DRIFT_WEBHOOK_URL) {
    fetch(DRIFT_WEBHOOK_URL, {
      method: "POST",
      body: JSON.stringify({
        alert_id, project_id, risk,
        challenging_summary, challenged_decision_summary,
        timestamp: new Date().toISOString()
      })
    })
  }

.env.example — add:
  DRIFT_WEBHOOK_URL=        # POST target for drift alerts (Slack incoming webhook, custom URL)
```

One env var. One fetch call. No new infrastructure.

---

## Why not sync Stage A in brain_log_decision?

```mermaid
flowchart TD
    A[Agent logs decision] --> B[Sync Stage A check\nembedding + Qdrant search]
    B --> C{conflict found?}
    C -->|yes| D[Return drift_risk: HIGH\nto agent]
    C -->|no| E[Return ok, no conflicts]
    D --> F{Agent acts on it?}
    F -->|Interactive session\nhuman watching| G[Agent updates rationale\nor calls brain_log_signal ✓]
    F -->|Autonomous parallel agent\nno human watching| H[Agent ignores response\nand continues ✗]
    H --> I[Code already written\nConflict not resolved]
    G --> J[Better rationale in brain\nConflict acknowledged]

    style H fill:#7f1d1d,color:#fff
    style I fill:#7f1d1d,color:#fff
    style G fill:#14532d,color:#fff
    style J fill:#14532d,color:#fff
```

Sync Stage A is useful for **interactive sessions** where a human can respond to the feedback.
For parallel autonomous agents — your ICP — it adds latency and the feedback is not acted on.
Push notification on DriftAlert creation is the right primitive for the ICP.

---

## Summary: what to build and when

| Mechanism | Solves | When |
|---|---|---|
| Push notification on DriftAlert (`DRIFT_WEBHOOK_URL`) | Cross-agent conflict, parallel agents, ICP | Beta |
| Drift inbox UI (web) | Human review + resolve workflow | Beta |
| `brain_analyze_impact` as hard pre-flight | Single-agent pre-commit check | Beta (CLAUDE.md enforcement) |
| Sync Stage A in `brain_log_decision` | Rationale quality in interactive sessions | Post-beta, nice-to-have |
| Coordinator agent endpoint | Fully autonomous conflict resolution | Post-beta |
