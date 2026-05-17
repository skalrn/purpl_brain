#!/usr/bin/env node
/**
 * Purpl Brain — MCP server (stdio transport)
 *
 * Exposes the brain query interface as MCP tools so Claude Code (and any
 * MCP-compatible client) can query project decisions inline during a session.
 *
 * Tools:
 *   brain_query          — natural language query, returns cited answer
 *   brain_log_decision   — write agent decisions back into the brain
 *
 * Resources:
 *   brain://project/{project_id} — project snapshot (recent decisions + open drift alerts)
 *
 * Configuration (env or .env):
 *   BRAIN_API_URL   — base URL of the Purpl Brain API  (default: http://localhost:3001)
 *   BRAIN_API_KEY   — optional bearer token for authenticated deployments
 */
import "dotenv/config";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_URL = process.env.BRAIN_API_URL ?? "http://localhost:3001";
const API_KEY = process.env.BRAIN_API_KEY ?? "";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brain API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;

  const res = await fetch(`${API_URL}${path}`, { headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Brain API error ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Response types ────────────────────────────────────────────────────────────

interface Citation {
  source: string;
  source_url: string;
  actor: { name: string };
  timestamp: string;
}

interface QueryResponse {
  answer: string;
  citations: Citation[];
  latency_ms: number;
  citation_warning: boolean;
}

interface DriftAlert {
  alert_id: string;
  source: string;
  content: string;
  decision_summary: string;
  resolution: string;
}

interface DriftAlertsResponse {
  alerts: DriftAlert[];
}

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "purpl-brain",
  version: "0.1.0",
});

// ── Tool: brain_query ─────────────────────────────────────────────────────────

server.tool(
  "brain_query",
  "Query the project brain for decisions, architecture context, and team knowledge. " +
  "Returns a cited answer grounded in GitHub PRs, Slack discussions, Jira tickets, and meeting notes. " +
  "Always use this before making architectural decisions or asking about past team choices.",
  {
    query: z.string().describe("Natural language question about the project"),
    project_id: z.string().describe(
      "Project namespace to search (e.g. 'encode_httpx', 'my_org_my_repo'). " +
      "Use underscore-separated org_repo format matching how the project was registered."
    ),
    mode: z.enum(["project", "expertise", "agent_resume"]).optional().describe(
      "Query mode: 'project' (default) for general project context, " +
      "'expertise' for cross-project domain knowledge, " +
      "'agent_resume' to recall what a previous agent session decided."
    ),
  },
  async ({ query, project_id, mode }) => {
    const response = await apiPost<QueryResponse>("/brain/query", {
      query,
      project_id,
      mode: mode ?? "project",
    });

    // Format citations as a readable list
    const citationLines = response.citations.map((c, i) => {
      const date = new Date(c.timestamp).toLocaleDateString();
      return `[${i + 1}] ${c.actor.name} via ${c.source} (${date}): ${c.source_url}`;
    });

    const warningLine = response.citation_warning
      ? "\n⚠️  Some claims could not be fully grounded in retrieved sources."
      : "";

    const text = [
      response.answer,
      "",
      citationLines.length > 0 ? "Sources:" : "",
      ...citationLines,
      warningLine,
    ]
      .filter((l) => l !== undefined)
      .join("\n")
      .trim();

    return { content: [{ type: "text", text }] };
  }
);

// ── Tool: brain_log_decision ──────────────────────────────────────────────────

const DecisionSchema = z.object({
  id: z.string().describe("Unique ID for this decision (generate a short slug)"),
  description: z.string().describe("What was decided"),
  rationale: z.string().describe("Why this choice was made"),
  alternatives_considered: z.array(z.string()).optional().describe("Other options that were evaluated"),
  confidence: z.enum(["high", "medium", "low"]).optional().describe("How confident the agent is in this decision"),
});

server.tool(
  "brain_log_decision",
  "Write this agent session's decisions back into the project brain so future sessions " +
  "(human or agent) can query them. Call this at the end of a session or after making " +
  "a significant architectural choice. Logged decisions are treated as first-class brain " +
  "knowledge alongside GitHub PRs and Jira tickets.",
  {
    project_id: z.string().describe("Project namespace this session operated on"),
    session_id: z.string().describe("Unique identifier for this agent session (use a UUID or timestamp-slug)"),
    decisions: z.array(DecisionSchema).describe("List of decisions made during this session"),
    work_completed: z.string().describe("Short summary of what was built or changed"),
    files_modified: z.array(z.string()).optional().describe("File paths touched during this session"),
    unresolved: z.array(z.string()).optional().describe("Open questions or blockers not resolved"),
    next_steps: z.array(z.string()).optional().describe("Recommended follow-on actions"),
  },
  async ({ project_id, session_id, decisions, work_completed, files_modified, unresolved, next_steps }) => {
    // TODO: add API key auth before production deployment
    await apiPost("/brain/agent-log", {
      schema_version: "1.0",
      session_id,
      agent_id: "claude-code",
      project_id,
      timestamp_start: new Date().toISOString(),
      timestamp_end: new Date().toISOString(),
      decisions,
      work_completed,
      files_modified: files_modified ?? [],
      unresolved: unresolved ?? [],
      next_steps: next_steps ?? [],
    });

    return {
      content: [{
        type: "text",
        text: `✓ Logged ${decisions.length} decision${decisions.length !== 1 ? "s" : ""} to project brain (${project_id}).\n` +
          decisions.map((d) => `  • ${d.description}`).join("\n"),
      }],
    };
  }
);

// ── Resource: brain://project/{project_id} ────────────────────────────────────

server.resource(
  "project-snapshot",
  new ResourceTemplate("brain://project/{project_id}", { list: undefined }),
  async (uri, { project_id }) => {
    const id = Array.isArray(project_id) ? project_id[0] : project_id;

    // Fetch recent decisions + open drift alerts in parallel
    const [decisionsRes, alertsRes] = await Promise.allSettled([
      apiPost<QueryResponse>("/brain/query", {
        query: "What are the most recent decisions made in this project?",
        project_id: id,
        mode: "project",
      }),
      apiGet<DriftAlertsResponse>(`/brain/drift-alerts?project_id=${encodeURIComponent(id)}`),
    ]);

    const lines: string[] = [`# Brain snapshot — ${id}`, ""];

    if (decisionsRes.status === "fulfilled") {
      lines.push("## Recent decisions", decisionsRes.value.answer, "");
    }

    if (alertsRes.status === "fulfilled" && alertsRes.value.alerts.length > 0) {
      lines.push(`## Open drift alerts (${alertsRes.value.alerts.length})`);
      for (const a of alertsRes.value.alerts.slice(0, 5)) {
        lines.push(`- [${a.source}] ${a.content.slice(0, 100)} → challenges: "${a.decision_summary?.slice(0, 60)}"`);
      }
      lines.push("");
    }

    return {
      contents: [{
        uri: uri.href,
        text: lines.join("\n"),
        mimeType: "text/markdown",
      }],
    };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
// MCP servers communicate over stdio — no console.log after this point
