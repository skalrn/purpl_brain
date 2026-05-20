"""
Google ADK tool wrappers for Purpl Brain.

ADK converts plain Python functions to FunctionDeclarations automatically.
Pass the returned callables directly to FunctionTool or Agent.tools.

Usage:
    from purpl_brain import BrainClient, adk_tools
    from google.adk.tools import FunctionTool
    from google.adk import Agent

    client = BrainClient()
    tools = [FunctionTool(fn) for fn in adk_tools(client)]

    agent = Agent(
        name="my_agent",
        model="gemini-2.0-flash",
        instruction="Before starting work, call brain_query to load prior decisions...",
        tools=tools,
    )
"""

from datetime import datetime, timezone

from .client import BrainClient


def make_brain_tools(client: BrainClient) -> list:
    """Return the 4 Purpl Brain tools as plain Python callables for ADK."""

    def brain_query(query: str, project_id: str, mode: str = "project") -> dict:
        """Query the project brain for decisions, architecture context, and team knowledge.

        Returns a cited answer grounded in GitHub PRs, Slack discussions, Jira tickets,
        meeting notes, and prior agent sessions. Call this at session start before making
        any architectural or library choice that may have been decided before.

        Args:
            query: Natural language question about the project.
            project_id: Project namespace (e.g. 'my_org_my_repo').
            mode: 'project' (default) for general context, 'expertise' for cross-project
                  knowledge, 'agent_resume' to recall what prior agent sessions decided.

        Returns:
            answer: Cited answer from the brain.
            citations: List of source citations (source, actor, url, date).
            latency_ms: Query latency in milliseconds.
        """
        resp = client.post("/query", {"query": query, "project_id": project_id, "mode": mode})
        return {
            "answer": resp["answer"],
            "citations": [
                {
                    "source": c["source"],
                    "actor": c["actor"]["name"],
                    "url": c["source_url"],
                    "date": c["timestamp"][:10],
                }
                for c in resp.get("citations", [])
            ],
            "latency_ms": resp.get("latency_ms"),
        }

    def brain_log_decision(
        project_id: str,
        session_id: str,
        decisions: list[dict],
        work_completed: str,
        agent_id: str = "adk-agent",
        files_modified: list[str] | None = None,
        unresolved: list[str] | None = None,
        next_steps: list[str] | None = None,
    ) -> dict:
        """Write this agent session's decisions into the project brain.

        Call this at session end to persist architectural choices, library selections,
        and rejected alternatives so future sessions can query them with citations.

        Args:
            project_id: Project namespace this session operated on.
            session_id: Unique identifier for this session (UUID or timestamp slug).
            decisions: List of decisions. Each dict must have 'id', 'description', 'rationale'.
                       Optional keys: 'alternatives_considered' (list of strings),
                       'confidence' ('high', 'medium', or 'low').
            work_completed: Short summary of what was built or changed.
            agent_id: Identifier written into the brain log (default: 'adk-agent').
            files_modified: File paths touched during this session.
            unresolved: Open questions not resolved in this session.
            next_steps: Recommended follow-on actions.

        Returns:
            ok: True on success.
            decisions_logged: Number of decisions persisted.
            project_id: Project namespace confirmed.
        """
        now = datetime.now(timezone.utc).isoformat()
        client.post("/brain/agent-log", {
            "schema_version": "1.0",
            "session_id": session_id,
            "agent_id": agent_id,
            "project_id": project_id,
            "timestamp_start": now,
            "timestamp_end": now,
            "decisions": decisions,
            "work_completed": work_completed,
            "files_modified": files_modified or [],
            "unresolved": unresolved or [],
            "next_steps": next_steps or [],
        })
        return {"ok": True, "decisions_logged": len(decisions), "project_id": project_id}

    def brain_analyze_impact(change_description: str, project_id: str) -> dict:
        """Analyze which existing decisions a proposed change may affect.

        Returns overall risk tier and a summary of affected decisions. Call before
        refactoring a core module, switching a library, changing an API contract, or
        any change that could invalidate a prior design decision.

        Args:
            change_description: Plain-English description of the change to be made.
                                 Be specific: mention the module, library, or API being changed.
            project_id: Project namespace to search (e.g. 'my_org_my_repo').

        Returns:
            overall_risk: 'critical', 'high', 'medium', or 'low'.
            summary: Human-readable risk summary.
            affected_decisions: List of decisions that may be impacted.
        """
        resp = client.post("/query", {
            "project_id": project_id,
            "mode": "impact",
            "change_description": change_description,
            "query": change_description,
        })
        return {
            "overall_risk": resp["overall_risk"],
            "summary": resp["summary"],
            "affected_decisions": resp.get("affected_decisions", []),
        }

    def brain_log_signal(
        text: str,
        project_id: str,
        actor_id: str = "adk-agent",
        actor_name: str = "ADK Agent",
        source: str = "agent",
    ) -> dict:
        """Report an observation or finding that may contradict an existing decision.

        The brain matches it against known decisions and creates drift alerts for human
        review. Use this when you discover something unexpected during implementation —
        a library limitation, a performance finding, an API constraint — that the team
        should know about relative to past decisions.

        Args:
            text: The observation or finding to report. Be specific.
            project_id: Project namespace.
            actor_id: Identifier for this agent.
            actor_name: Display name for this agent.
            source: Signal origin — 'github', 'slack', 'jira', 'meeting', 'agent', or 'document'.

        Returns:
            ok: True on success.
            drift_alerts_created: Number of new drift alerts created.
            matched_decisions: Number of existing decisions that matched.
        """
        resp = client.post("/brain/signals", {
            "text": text,
            "project_id": project_id,
            "source": source,
            "actor_id": actor_id,
            "actor_name": actor_name,
        })
        return {
            "ok": resp.get("ok", True),
            "drift_alerts_created": resp.get("drift_alerts_created", 0),
            "matched_decisions": resp.get("matched_decisions", 0),
        }

    return [brain_query, brain_log_decision, brain_analyze_impact, brain_log_signal]
