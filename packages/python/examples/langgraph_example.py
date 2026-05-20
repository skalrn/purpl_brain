"""
LangGraph agent with Purpl Brain memory.

Install:
    pip install "purpl-brain[langgraph]" langchain-anthropic langgraph

Run:
    BRAIN_API_URL=http://localhost:3001 \
    BRAIN_API_KEY=your-key \
    ANTHROPIC_API_KEY=your-key \
    python examples/langgraph_example.py
"""

import uuid
from langgraph.prebuilt import create_react_agent
from langchain_anthropic import ChatAnthropic
from purpl_brain import BrainClient, langgraph_tools

PROJECT_ID = "my_org_my_repo"

client = BrainClient()
tools = langgraph_tools(client)
model = ChatAnthropic(model="claude-sonnet-4-6")
agent = create_react_agent(model, tools)

# ── Session start: load prior context ────────────────────────────────────────

print("=== Session start: querying brain for prior decisions ===\n")

result = agent.invoke({
    "messages": [(
        "user",
        f"Use brain_query to load the most recent architectural decisions for project '{PROJECT_ID}', "
        "then summarize what you found.",
    )]
})
print(result["messages"][-1].content)

# ── Mid-session: check impact before a change ─────────────────────────────────

print("\n=== Pre-flight impact check ===\n")

result = agent.invoke({
    "messages": [(
        "user",
        f"I'm about to replace our Redis cache with Memcached in project '{PROJECT_ID}'. "
        "Use brain_analyze_impact to check whether this conflicts with any existing decisions.",
    )]
})
print(result["messages"][-1].content)

# ── Session end: write decisions back ─────────────────────────────────────────

print("\n=== Session end: logging decisions to brain ===\n")

session_id = f"langgraph-{uuid.uuid4()}"

result = agent.invoke({
    "messages": [(
        "user",
        f"Use brain_log_decision to record this session's decisions for project '{PROJECT_ID}'. "
        f"Session ID: {session_id}. "
        "Decisions: we chose to keep Redis (not Memcached) because our existing session TTL logic "
        "relies on Redis keyspace notifications, which Memcached does not support. "
        "Work completed: evaluated caching alternatives. "
        "Unresolved: whether to migrate to Redis Cluster for high-availability.",
    )]
})
print(result["messages"][-1].content)
