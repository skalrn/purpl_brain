"""
Google ADK agent with Purpl Brain memory.

Install:
    pip install "purpl-brain[adk]" google-adk

Run:
    BRAIN_API_URL=http://localhost:3001 \
    BRAIN_API_KEY=your-key \
    GOOGLE_API_KEY=your-key \
    python examples/adk_example.py

Write-back pattern
------------------
Wrap the agent run in a BrainSession context manager. The orchestrator adds decisions
to the session as they are made; flush() is called automatically on __exit__, including
when the run raises an exception.

The agent's instruction no longer needs "call brain_log_decision at session end" —
the context manager is the enforcement layer, not the agent's willingness to call a tool.
"""

import asyncio
import uuid

from google.adk import Agent, Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import FunctionTool
from google.genai.types import Content, Part

from purpl_brain import BrainClient, BrainSession, adk_tools

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
        "If you discover something that may contradict a past decision, call brain_log_signal immediately. "
        # brain_log_decision is intentionally omitted — the BrainSession context manager
        # in the orchestrator handles write-back, so the agent does not need to call it.
    ),
    tools=tools,
)


async def run_session(runner: Runner, session_id: str, query: str) -> str:
    message = Content(role="user", parts=[Part(text=query)])
    final = ""
    async for event in runner.run_async(
        user_id="developer",
        session_id=session_id,
        new_message=message,
    ):
        if event.is_final_response() and event.content:
            for part in event.content.parts:
                if part.text:
                    final += part.text
    return final


async def main():
    session_service = InMemorySessionService()
    adk_session = await session_service.create_session(
        app_name="purpl-brain-example",
        user_id="developer",
        session_id=str(uuid.uuid4()),
    )
    runner = Runner(agent=agent, app_name="purpl-brain-example", session_service=session_service)

    # BrainSession wraps the entire agent run.
    # All decisions accumulated inside flush automatically on __exit__.
    with client.session(
        session_id=f"adk-{adk_session.id}",
        project_id=PROJECT_ID,
        agent_id="adk-agent",
    ) as brain:
        brain.work_completed = "Auth library evaluation"

        # Session start: load prior context
        print("=== Session start: querying brain for prior decisions ===\n")
        response = await run_session(
            runner,
            adk_session.id,
            f"Use brain_query to load recent architectural decisions for project '{PROJECT_ID}'. "
            "Summarize what you found.",
        )
        print(response)

        # Pre-flight: check impact
        print("\n=== Pre-flight impact check ===\n")
        response = await run_session(
            runner,
            adk_session.id,
            f"I'm considering switching our auth library from Passport.js to better-auth in '{PROJECT_ID}'. "
            "Use brain_analyze_impact to check whether this conflicts with existing decisions.",
        )
        print(response)

        # Orchestrator records the decision after evaluating the impact result
        brain.add_decision(
            id="keep-passport-js",
            description="Keep Passport.js instead of migrating to better-auth",
            rationale=(
                "Existing middleware depends on Passport's session serialization format. "
                "Migration requires a coordinated multi-PR effort across four services "
                "with no immediate functional benefit."
            ),
            alternatives_considered=["better-auth", "Auth.js"],
            confidence="high",
        )
        brain.next_steps = ["Revisit if Passport.js drops Node 22 support"]

        print(f"\n=== Session complete — flushing decisions to brain (session: adk-{adk_session.id}) ===\n")

    # BrainSession.__exit__ has now called flush() — decisions are posted to /brain/agent-log


if __name__ == "__main__":
    asyncio.run(main())
