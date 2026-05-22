---
sidebar_position: 3
---

# Python SDK

## Installation

```bash
pip install -e "packages/python[langgraph]"   # LangGraph / LangChain agents
pip install -e "packages/python[adk]"          # Google ADK agents
pip install -e "packages/python[all]"          # both
```

The SDK reads `BRAIN_API_URL` and `BRAIN_API_KEY` from the environment. Set these before importing:

```bash
export BRAIN_API_URL=http://localhost:3001
export BRAIN_API_KEY=your-api-key-here
```

## BrainClient

The base client wraps all four operations:

```python
from purpl_brain import BrainClient

client = BrainClient()  # reads env vars automatically
# or explicitly:
client = BrainClient(api_url="http://localhost:3001", api_key="key")

# Query
result = client.query(
    query="What decisions were made about the auth module?",
    project_id="my-project",
    mode="project"  # "project" | "expertise" | "agent_resume"
)
print(result.answer)
for citation in result.citations:
    print(f"  [{citation.source}] {citation.source_url}")

# Log a decision
client.log_decision(
    session_id="session-2026-05-22",
    project_id="my-project",
    work_completed="Added Redis-based session revocation",
    decisions=[{
        "id": "redis-revocation",
        "description": "Store revocation list in Redis",
        "rationale": "Low-latency lookup required on every request",
        "alternatives_considered": ["Postgres", "in-memory"],
        "confidence": "high"
    }]
)

# Analyze impact
impact = client.analyze_impact(
    change_description="Switching from JWT to opaque tokens",
    project_id="my-project"
)

# Log a signal
client.log_signal(
    text="jose@5.x has a JWE incompatibility — our token format won't work",
    project_id="my-project",
    source="agent"
)
```

## LangGraph integration

```python
from purpl_brain import BrainClient, langgraph_tools

client = BrainClient()
tools = langgraph_tools(client)  # returns list of @tool-decorated functions

# Each tool is a LangChain @tool — pass directly to your agent
from langgraph.prebuilt import create_react_agent
agent = create_react_agent(model, tools=tools)
```

The `langgraph_tools` function returns four tools, one per operation:
- `brain_query(query: str, project_id: str, mode: str = "project") -> str`
- `brain_log_decision(session_id: str, project_id: str, work_completed: str, decisions: list) -> str`
- `brain_analyze_impact(change_description: str, project_id: str) -> str`
- `brain_log_signal(text: str, project_id: str, source: str = "agent") -> str`

### BrainCallbackHandler

For automated write-back in LangGraph sessions, use the `BrainCallbackHandler`:

```python
from purpl_brain import BrainClient
from purpl_brain.tools_langgraph import BrainCallbackHandler

client = BrainClient()
handler = BrainCallbackHandler(
    client=client,
    session_id="session-2026-05-22",
    project_id="my-project"
)

# Pass to your graph executor
result = graph.invoke(
    inputs,
    config={"callbacks": [handler]}
)
# handler.flush() is called automatically on on_chain_end and on_chain_error
```

The `BrainCallbackHandler` calls `session.flush()` on both `on_chain_end` and `on_chain_error`, ensuring decisions are written even when the chain fails. This is the mechanism that produces >95% compliance for LangGraph agents.

## Google ADK integration

```python
from purpl_brain import BrainClient, adk_tools
from google.adk.tools import FunctionTool

client = BrainClient()
tools = [FunctionTool(fn) for fn in adk_tools(client)]

# Use tools in your ADK agent
```

### BrainSession context manager

For ADK or plain Python agents, the `BrainSession` context manager handles automatic flush:

```python
from purpl_brain import BrainClient, BrainSession

client = BrainClient()

with BrainSession(
    client=client,
    session_id="session-2026-05-22",
    project_id="my-project",
    agent_id="my-adk-agent"
) as session:
    # Do agent work
    session.add_decision(
        id="rest-over-graphql",
        description="Chose REST over GraphQL for the public API",
        rationale="GraphQL overhead not justified for current query patterns",
        alternatives_considered=["GraphQL", "gRPC"],
        confidence="high"
    )
    # ... more work

# __exit__ calls flush() automatically, even on exceptions
```

`BrainSession.__exit__` calls `flush()` on normal exit and on exceptions. If an exception occurs, the session is flushed before the exception propagates. This ensures that decisions made before a crash are preserved.

## Full session lifecycle example

```python
from purpl_brain import BrainClient, BrainSession

client = BrainClient()

with BrainSession(client, "session-001", "auth-project") as session:
    # 1. Query at session start
    context = client.query(
        query="What decisions were made about the auth module?",
        project_id="auth-project"
    )
    print(f"Context loaded: {len(context.citations)} citations")

    # 2. Check impact before significant change
    impact = client.analyze_impact(
        change_description="Adding Redis-based session revocation",
        project_id="auth-project"
    )
    if impact.overall_risk in ("critical", "high"):
        print(f"High-risk change: {impact.summary}")

    # 3. Do the work, log decisions as they are made
    session.add_decision(
        id="redis-revocation",
        description="Store session revocation list in Redis",
        rationale="TTL-native eviction, sub-millisecond lookup on every auth request",
        alternatives_considered=["Postgres", "in-memory dict"],
        confidence="high"
    )

    # 4. Log unexpected findings immediately
    client.log_signal(
        text="Redis SCAN for bulk revocation is O(N) — needs careful use",
        project_id="auth-project"
    )

# Session flushes here automatically
```
