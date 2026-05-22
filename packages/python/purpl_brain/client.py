import os
from datetime import datetime, timezone

import requests


class BrainClient:
    """Thin HTTP client for the Purpl Brain REST API."""

    def __init__(self, base_url: str | None = None, api_key: str | None = None):
        self.base_url = (base_url or os.environ.get("BRAIN_API_URL", "http://localhost:3001")).rstrip("/")
        self.api_key = api_key or os.environ.get("BRAIN_API_KEY", "")

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        return h

    def post(self, path: str, body: dict) -> dict:
        r = requests.post(f"{self.base_url}{path}", json=body, headers=self._headers(), timeout=30)
        r.raise_for_status()
        return r.json()

    def get(self, path: str) -> dict:
        r = requests.get(f"{self.base_url}{path}", headers=self._headers(), timeout=30)
        r.raise_for_status()
        return r.json()

    def session(self, session_id: str, project_id: str, agent_id: str = "python-agent") -> "BrainSession":
        """Return a BrainSession context manager for this client."""
        return BrainSession(self, session_id=session_id, project_id=project_id, agent_id=agent_id)


class BrainSession:
    """Context manager that accumulates decisions and flushes them to the brain on exit.

    This is the log_on_exit primitive for Python-based agents (LangGraph, ADK, or plain
    Python orchestrators). The orchestrator wraps its agent run in a BrainSession; any
    decisions made during the run are added via add_decision() and automatically posted
    to /brain/agent-log when the context exits — even if the run raises an exception.

    Usage:
        with client.session("my-session-id", "my_project") as session:
            session.work_completed = "Implemented the ingestion pipeline"
            # ... agent does work ...
            session.add_decision(
                id="chose-redis",
                description="Use Redis Streams for the event queue",
                rationale="Built-in consumer groups, persistence, no extra infra",
                alternatives_considered=["RabbitMQ", "SQS"],
                confidence="high",
            )
        # flush() is called automatically on __exit__
    """

    def __init__(self, client: BrainClient, session_id: str, project_id: str, agent_id: str = "python-agent"):
        self.client = client
        self.session_id = session_id
        self.project_id = project_id
        self.agent_id = agent_id
        self.work_completed: str = ""
        self.files_modified: list[str] = []
        self.unresolved: list[str] = []
        self.next_steps: list[str] = []
        self._decisions: list[dict] = []

    def add_decision(
        self,
        id: str,
        description: str,
        rationale: str,
        alternatives_considered: list[str] | None = None,
        confidence: str | None = None,
    ) -> None:
        """Accumulate a decision to be flushed at session end."""
        d: dict = {"id": id, "description": description, "rationale": rationale}
        if alternatives_considered:
            d["alternatives_considered"] = alternatives_considered
        if confidence:
            d["confidence"] = confidence
        self._decisions.append(d)

    def flush(self) -> dict | None:
        """Post all accumulated decisions to the brain. Returns API response, or None if nothing to log."""
        if not self._decisions:
            return None
        now = datetime.now(timezone.utc).isoformat()
        return self.client.post("/brain/agent-log", {
            "schema_version": "1.0",
            "session_id": self.session_id,
            "agent_id": self.agent_id,
            "project_id": self.project_id,
            "timestamp_start": now,
            "timestamp_end": now,
            "decisions": self._decisions,
            "work_completed": self.work_completed or f"Agent session {self.session_id}",
            "files_modified": self.files_modified,
            "unresolved": self.unresolved,
            "next_steps": self.next_steps,
        })

    def __enter__(self) -> "BrainSession":
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> bool:
        self.flush()
        return False  # never suppress exceptions
