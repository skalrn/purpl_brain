"""
LangGraph / LangChain tool wrappers for Purpl Brain.

Usage:
    from purpl_brain import BrainClient, langgraph_tools
    from langgraph.prebuilt import create_react_agent

    client = BrainClient()
    agent = create_react_agent(model, langgraph_tools(client))
"""

from datetime import datetime, timezone
from typing import Literal

from langchain_core.tools import tool

from .client import BrainClient


def make_brain_tools(client: BrainClient) -> list:
    """Return the 4 Purpl Brain tools as LangChain @tool instances."""

    @tool
    def brain_query(query: str, project_id: str, mode: str = "project") -> str:
        """Query the project brain for decisions, architecture context, and team knowledge.

        Returns a cited answer grounded in GitHub PRs, Slack discussions, Jira tickets,
        meeting notes, and prior agent sessions. Call this at session start before making
        any architectural or library choice that may have been decided before.

        Args:
            query: Natural language question about the project.
            project_id: Project namespace (e.g. 'my_org_my_repo').
            mode: 'project' (default) for general context, 'expertise' for cross-project
                  knowledge, 'agent_resume' to recall what prior agent sessions decided.
        """
        resp = client.post("/query", {"query": query, "project_id": project_id, "mode": mode})
        citations = "\n".join(
            f"[{i + 1}] {c['actor']['name']} via {c['source']} ({c['timestamp'][:10]}): {c['source_url']}"
            for i, c in enumerate(resp.get("citations", []))
        )
        answer = resp["answer"]
        return f"{answer}\n\nSources:\n{citations}" if citations else answer

    @tool
    def brain_log_decision(
        project_id: str,
        session_id: str,
        decisions: list[dict],
        work_completed: str,
        agent_id: str = "langgraph-agent",
        files_modified: list[str] | None = None,
        unresolved: list[str] | None = None,
        next_steps: list[str] | None = None,
    ) -> str:
        """Write this agent session's decisions into the project brain.

        Call this at session end to persist architectural choices, library selections,
        and rejected alternatives so future sessions can query them with citations.

        Args:
            project_id: Project namespace this session operated on.
            session_id: Unique identifier for this session (UUID or timestamp slug).
            decisions: List of decisions. Each dict must have 'id', 'description', 'rationale'.
                       Optional keys: 'alternatives_considered' (list[str]), 'confidence' ('high'|'medium'|'low').
            work_completed: Short summary of what was built or changed.
            agent_id: Identifier written into the brain log (default: 'langgraph-agent').
            files_modified: File paths touched during this session.
            unresolved: Open questions not resolved in this session.
            next_steps: Recommended follow-on actions.
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
        bullet = "\n".join(f"  • {d['description']}" for d in decisions)
        return f"Logged {len(decisions)} decision(s) to project brain ({project_id}).\n{bullet}"

    @tool
    def brain_analyze_impact(change_description: str, project_id: str) -> str:
        """Analyze which existing decisions a proposed change may affect.

        Returns overall risk tier (critical/high/medium/low) and a summary of affected
        decisions. Call before refactoring a core module, switching a library, changing
        an API contract, or any change that could invalidate a prior design decision.

        Args:
            change_description: Plain-English description of the change to be made.
                                 Be specific: mention the module, library, or API being changed.
            project_id: Project namespace to search (e.g. 'my_org_my_repo').
        """
        resp = client.post("/query", {
            "project_id": project_id,
            "mode": "impact",
            "change_description": change_description,
            "query": change_description,
        })
        lines = [
            f"## Impact Analysis — {resp['overall_risk'].upper()} risk",
            "",
            resp["summary"],
        ]
        for d in resp.get("affected_decisions", []):
            lines.append(f"\n**{d['summary']}** [{d['status']}]")
            for t in d.get("affected_tickets", []):
                jira = f" — {t['jira_summary']} ({t.get('jira_status', 'unknown')})" if t.get("jira_summary") else ""
                lines.append(f"  • {t['ticket_ref']}{jira} [{t['risk_tier']}] {t['reason']}")
        return "\n".join(lines)

    @tool
    def brain_log_signal(
        text: str,
        project_id: str,
        source: str = "agent",
        actor_id: str = "langgraph-agent",
        actor_name: str = "LangGraph Agent",
    ) -> str:
        """Report an observation or finding that may contradict an existing decision.

        The brain matches it against known decisions and creates drift alerts for human
        review. Use this when you discover something unexpected during implementation —
        a library limitation, a performance finding, an API constraint — that the team
        should know about relative to past decisions.

        Args:
            text: The observation or finding to report. Be specific.
            project_id: Project namespace.
            source: Signal origin — 'github'|'slack'|'jira'|'meeting'|'agent'|'document'.
            actor_id: Identifier for this agent.
            actor_name: Display name for this agent.
        """
        resp = client.post("/brain/signals", {
            "text": text,
            "project_id": project_id,
            "source": source,
            "actor_id": actor_id,
            "actor_name": actor_name,
        })
        if resp.get("drift_alerts_created", 0) > 0:
            return f"Signal logged — created {resp['drift_alerts_created']} drift alert(s) for team review."
        return "Signal logged — no existing decisions matched (threshold not met)."

    return [brain_query, brain_log_decision, brain_analyze_impact, brain_log_signal]
