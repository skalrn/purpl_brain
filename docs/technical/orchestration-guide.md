# Orchestration Integration Guide

How to wire purpl-brain into an agentic orchestration system so that brain calls are structural — not dependent on LLM judgment.

---

## The pattern

When you control the orchestration layer, brain calls become explicit steps in the workflow graph rather than instructions the agent may or may not follow:

```
before task dispatch:
    context = POST /brain/query   { query: task.description, project_id }
    prompt  = system_prompt + context + task

agent runs (Claude API, GPT-4, local model — any):
    produces output + reasoning

after task completes:
    POST /brain/agent-log   { decisions extracted from output }

before significant architectural change (optional hard gate):
    POST /brain/query       { mode: "impact", change_description }
    if risk == "critical": pause and notify
```

The agent never sees the brain tools. It receives richer context and its decisions are logged automatically. This is different from the MCP path where the agent itself decides whether to call `brain_query`.

---

## REST API reference

All four operations are available as REST endpoints. Auth: `X-API-Key` header.

### Query the brain before a task

```
POST /brain/query
```

```json
{
  "query": "string — use the task description, not a generic 'recent decisions'",
  "project_id": "string",
  "mode": "project"
}
```

Response:
```json
{
  "answer": "Prior decisions relevant to your query...",
  "citations": [
    {
      "source": "agent | github | slack | meeting",
      "source_url": "https://...",
      "actor": "sam@company.com",
      "timestamp": "2026-03-14T10:22:00Z",
      "quoted_text": "..."
    }
  ]
}
```

**Query design:** use the task description as the query, not a generic phrase like "recent decisions". Generic queries return everything; specific queries return what matters for the task.

```python
# Good — specific, task-scoped
query = f"decisions about authentication and token storage relevant to: {task.description}"

# Bad — too broad, floods context with noise
query = "recent decisions for this project"
```

**Expected context size:** ~300–700 tokens per query on a healthy corpus. If `answer` is empty, the brain has no relevant decisions yet — proceed without context, don't block the task.

---

### Log decisions after a task

```
POST /brain/agent-log
```

```json
{
  "session_id": "unique per agent run — use a UUID or timestamp slug",
  "project_id": "string",
  "agent_id": "your-agent-name",
  "work_completed": "one sentence: what was built or changed",
  "decisions": [
    {
      "id": "short-kebab-slug",
      "description": "what was decided",
      "rationale": "why — this is what makes the next query useful",
      "alternatives_considered": ["option A", "option B"],
      "confidence": "high | medium | low"
    }
  ]
}
```

Response: `{"ok": true, "event_id": "...", "decisions_logged": N}`

**When to call this:** after every agent task that produced a significant choice. Not just session end — log immediately so the decision is recoverable if the session crashes or is interrupted.

**Quality gate:** the API rejects logs with missing `rationale` or `work_completed` under 10 characters. The rationale is what distinguishes "we chose Redis" (a fact) from "we chose Redis because TTL-native eviction matched the access pattern" (reasoning the next agent can apply).

---

### Impact check before a significant change

```
POST /brain/query   { "mode": "impact", "change_description": "...", "project_id": "..." }
```

Returns the same response shape as a regular query, with `overall_risk: "critical" | "high" | "medium" | "low"` added.

Use this as an optional hard gate before breaking changes:

```python
if change_is_significant:
    impact = brain_query(change_description, mode="impact")
    if impact.get("overall_risk") == "critical":
        notify_human(impact["answer"])
        return  # pause — don't proceed
```

**Latency:** 30–60s on Ollama, ~3s on Anthropic/Bedrock. On Ollama, run this asynchronously or accept the latency; don't make it a blocking inline call in an interactive flow.

---

## Python — minimal example

```python
import httpx, uuid

BRAIN_URL = "http://localhost:3001"
BRAIN_KEY = "your-api-key"   # grep BRAIN_API_KEY apps/mcp/.env | cut -d= -f2
PROJECT_ID = "your_project"  # grep DEFAULT_PROJECT_ID apps/api/.env | cut -d= -f2

headers = {"X-API-Key": BRAIN_KEY, "Content-Type": "application/json"}

def brain_query(task_description: str) -> str:
    r = httpx.post(f"{BRAIN_URL}/brain/query", headers=headers, json={
        "query": task_description,
        "project_id": PROJECT_ID,
        "mode": "project",
    }, timeout=60)
    if not r.is_success:
        return ""  # brain unavailable — proceed without context
    body = r.json()
    return body.get("answer", "")

def brain_log(task_description: str, decisions: list[dict]) -> None:
    httpx.post(f"{BRAIN_URL}/brain/agent-log", headers=headers, json={
        "session_id": f"agent-{uuid.uuid4().hex[:8]}",
        "project_id": PROJECT_ID,
        "agent_id": "my-orchestration-agent",
        "work_completed": task_description[:200],
        "decisions": decisions,
    }, timeout=30)

def run_task(task: str) -> str:
    # 1. Pre-fetch brain context
    context = brain_query(task)

    # 2. Build prompt with context injected
    system = "You are a senior software engineer."
    user = f"{context}\n\n---\n\nTask: {task}" if context else f"Task: {task}"

    # 3. Run agent (replace with your LLM call)
    result = call_llm(system, user)

    # 4. Log decisions from output
    decisions = extract_decisions(result)  # your parsing logic
    if decisions:
        brain_log(task, decisions)

    return result
```

---

## LangGraph — node-based integration

```python
from langgraph.graph import StateGraph
from typing import TypedDict

class AgentState(TypedDict):
    task: str
    brain_context: str
    output: str
    decisions: list[dict]

def load_brain_context(state: AgentState) -> AgentState:
    context = brain_query(state["task"])
    return {**state, "brain_context": context}

def run_agent(state: AgentState) -> AgentState:
    user = (
        f"Prior decisions:\n{state['brain_context']}\n\n---\n\nTask: {state['task']}"
        if state["brain_context"]
        else f"Task: {state['task']}"
    )
    output = call_llm("You are a senior software engineer.", user)
    decisions = extract_decisions(output)
    return {**state, "output": output, "decisions": decisions}

def save_to_brain(state: AgentState) -> AgentState:
    if state["decisions"]:
        brain_log(state["task"], state["decisions"])
    return state

graph = StateGraph(AgentState)
graph.add_node("load_context", load_brain_context)
graph.add_node("agent",        run_agent)
graph.add_node("save",         save_to_brain)
graph.set_entry_point("load_context")
graph.add_edge("load_context", "agent")
graph.add_edge("agent",        "save")
app = graph.compile()
```

The brain calls (`load_context`, `save`) are explicit graph nodes — they run on every task regardless of what the agent outputs.

---

## CI / PR agent pattern

For agents that run on pull request events:

```python
def on_pull_request(pr: dict) -> None:
    task = f"Review PR: {pr['title']}\n\n{pr['body']}"

    # Load brain context scoped to the files changed
    files = ", ".join(pr["changed_files"][:5])
    context = brain_query(f"decisions about {files} and related architecture")

    # Run review agent
    review = call_llm(REVIEW_SYSTEM_PROMPT, f"{context}\n\n---\n\n{task}")

    # Log any significant decisions surfaced during review
    decisions = extract_decisions(review)
    if decisions:
        brain_log(f"PR review: {pr['title']}", decisions)

    post_pr_comment(pr["number"], review)
```

---

## Graceful degradation

Brain calls should never block a task. The brain is an enhancement, not a dependency:

```python
def brain_query_safe(task: str) -> str:
    try:
        return brain_query(task)
    except Exception:
        return ""  # proceed without context if brain is unavailable

def brain_log_safe(task: str, decisions: list) -> None:
    try:
        brain_log(task, decisions)
    except Exception:
        pass  # log failure is non-fatal
```

If the brain is down or slow, the agent degrades to a cold-start — same as before purpl-brain existed. It should never raise an exception that stops the task.

---

## Verifying it works

After wiring in your orchestration system, run the A/B eval to confirm brain context is actually improving agent alignment:

```bash
npm run eval:agent-value -w apps/api
```

This seeds 5 decisions, runs 3 tasks under cold vs brain-assisted conditions, and reports alignment and contradiction rates. On a healthy setup you should see alignment rate ≥ 60% for the brain condition and contradiction rate ≤ cold. See [eval results in README](../../README.md#real-numbers).
