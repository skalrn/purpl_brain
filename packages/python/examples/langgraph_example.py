"""
LangGraph agent with Purpl Brain memory.

Install:
    pip install "purpl-brain[langgraph]" langchain-anthropic langgraph

Run:
    BRAIN_API_URL=http://localhost:3001 \
    BRAIN_API_KEY=your-key \
    ANTHROPIC_API_KEY=your-key \
    python examples/langgraph_example.py

Write-back pattern
------------------
Use BrainCallbackHandler instead of prompting the agent to call brain_log_decision
at session end. The orchestrator accumulates decisions on the handler's session object
as the run progresses; the callback flushes them to the brain automatically when the
graph finishes — including on errors.

If the agent itself calls brain_log_decision mid-session (for time-sensitive decisions),
those are posted immediately and the handler's flush at chain end picks up anything else.
Both paths co-exist safely.
"""

import uuid

from langchain_anthropic import ChatAnthropic
from langgraph.prebuilt import create_react_agent

from purpl_brain import BrainCallbackHandler, BrainClient, langgraph_tools

PROJECT_ID = "my_org_my_repo"
SESSION_ID = f"langgraph-{uuid.uuid4()}"

client = BrainClient()
tools = langgraph_tools(client)
model = ChatAnthropic(model="claude-sonnet-4-6")
agent = create_react_agent(model, tools)

# ── Attach BrainCallbackHandler — decisions flush automatically on chain end ──

handler = BrainCallbackHandler(client, session_id=SESSION_ID, project_id=PROJECT_ID)
handler.session.work_completed = "Evaluated caching layer alternatives"

# ── Session start: load prior context ────────────────────────────────────────

print("=== Session start: querying brain for prior decisions ===\n")

result = agent.invoke(
    {
        "messages": [(
            "user",
            f"Use brain_query to load the most recent architectural decisions for project '{PROJECT_ID}', "
            "then summarize what you found.",
        )]
    },
    config={"callbacks": [handler]},
)
print(result["messages"][-1].content)

# ── Mid-session: check impact before a change ─────────────────────────────────

print("\n=== Pre-flight impact check ===\n")

result = agent.invoke(
    {
        "messages": [(
            "user",
            f"I'm about to replace our Redis cache with Memcached in project '{PROJECT_ID}'. "
            "Use brain_analyze_impact to check whether this conflicts with any existing decisions.",
        )]
    },
    config={"callbacks": [handler]},
)
print(result["messages"][-1].content)

# ── Orchestrator records the decision as it's made ───────────────────────────
# The orchestrator knows the outcome of the evaluation above and adds it directly
# to the session. The agent does not need to call brain_log_decision as a tool.

handler.session.add_decision(
    id="keep-redis-over-memcached",
    description="Keep Redis instead of switching to Memcached for the caching layer",
    rationale=(
        "Existing session TTL logic relies on Redis keyspace notifications, "
        "which Memcached does not support. Migrating would require rewriting "
        "the TTL callback layer across three services."
    ),
    alternatives_considered=["Memcached", "DragonflyDB"],
    confidence="high",
)
handler.session.unresolved = ["whether to migrate to Redis Cluster for high-availability"]

# ── Graph exit: handler.on_chain_end fires, session.flush() posts to brain ───
# Nothing more to do — the callback handles it.
print(f"\n=== Session complete — decisions will flush to brain (session: {SESSION_ID}) ===\n")
