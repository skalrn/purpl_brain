import os
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
