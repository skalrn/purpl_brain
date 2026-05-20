"""
Google ADK agent with Purpl Brain memory.

Install:
    pip install "purpl-brain[adk]" google-adk

Run:
    BRAIN_API_URL=http://localhost:3001 \
    BRAIN_API_KEY=your-key \
    GOOGLE_API_KEY=your-key \
    python examples/adk_example.py
"""

import asyncio
import uuid

from google.adk import Agent, Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool
from google.genai.types import Content, Part

from purpl_brain import BrainClient, adk_tools

PROJECT_ID = "my_org_my_repo"

client = BrainClient()
tools = [FunctionTool(fn) for fn in adk_tools(client)]

agent = Agent(
    name="purpl_brain_agent",
    model="gemini-2.0-flash",
    instruction=(
        "You are a software engineering agent. "
        "At the start of every session, call brain_query to load prior decisions for the project. "
        "Before any significant architectural change, call brain_analyze_impact. "
        "At the end of every session, call brain_log_decision to persist what you decided. "
        "If you discover something unexpected that may contradict a past decision, call brain_log_signal."
    ),
    tools=tools,
)


async def run_session(query: str) -> str:
    session_service = InMemorySessionService()
    session = await session_service.create_session(
        app_name="purpl-brain-example",
        user_id="developer",
        session_id=str(uuid.uuid4()),
    )
    runner = Runner(agent=agent, app_name="purpl-brain-example", session_service=session_service)

    message = Content(role="user", parts=[Part(text=query)])
    final = ""
    async for event in runner.run_async(
        user_id=session.user_id,
        session_id=session.id,
        new_message=message,
    ):
        if event.is_final_response() and event.content:
            for part in event.content.parts:
                if part.text:
                    final += part.text
    return final


async def main():
    # Session start: load context
    print("=== Session start: querying brain for prior decisions ===\n")
    response = await run_session(
        f"Use brain_query to load recent architectural decisions for project '{PROJECT_ID}'. "
        "Summarize what you found."
    )
    print(response)

    # Pre-flight: check impact
    print("\n=== Pre-flight impact check ===\n")
    response = await run_session(
        f"I'm considering switching our auth library from Passport.js to better-auth in '{PROJECT_ID}'. "
        "Use brain_analyze_impact to check whether this conflicts with existing decisions."
    )
    print(response)

    # Session end: write back
    print("\n=== Session end: logging decisions ===\n")
    response = await run_session(
        f"Use brain_log_decision to record decisions for project '{PROJECT_ID}'. "
        f"Session ID: adk-{uuid.uuid4()}. "
        "We decided to stay with Passport.js because the team has existing middleware depending on "
        "its session serialization format; migrating would require a coordinated multi-PR effort. "
        "Work completed: auth library evaluation. "
        "Next steps: revisit if Passport.js drops Node 22 support."
    )
    print(response)


if __name__ == "__main__":
    asyncio.run(main())
