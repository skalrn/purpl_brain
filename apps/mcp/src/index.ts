#!/usr/bin/env node
/**
 * Purpl Brain — MCP server
 *
 * Supports two transports:
 *   stdio (default) — for local Claude Code / Cursor use
 *   http            — for remote clients connecting to cloud-hosted brain
 *                     Start with: MCP_TRANSPORT=http MCP_PORT=3742 node dist/index.js
 *
 * Tools:
 *   brain_query          — natural language query, returns cited answer
 *   brain_log_decision   — write agent decisions back into the brain
 *
 * Resources:
 *   brain://project/{project_id} — project snapshot (recent decisions + open drift alerts)
 *
 * Configuration (env or .env):
 *   BRAIN_API_URL   — base URL of the Purpl Brain API  (default: http://localhost:3741)
 *   BRAIN_API_KEY   — bearer token for authenticated deployments
 *   BRAIN_AGENT_ID  — identifier written into agent-log entries (default: claude-code)
 *   MCP_TRANSPORT   — "stdio" (default) | "http"
 *   MCP_PORT        — port for HTTP transport (default: 3002)
 *   MCP_BIND_HOST   — bind address for HTTP transport (default: 127.0.0.1; use 0.0.0.0 in Docker)
 */
import "dotenv/config";
import { randomUUID } from "crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { z } from "zod";

const API_URL = process.env.BRAIN_API_URL ?? "http://localhost:3741";
const API_KEY = process.env.BRAIN_API_KEY ?? "";
const AGENT_ID = process.env.BRAIN_AGENT_ID ?? "claude-code";

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

function buildServer(): McpServer {
  const server = new McpServer({
    name: "purpl-brain",
    version: "0.1.0",
  });

  // ── Tool: brain_query ───────────────────────────────────────────────────────

  server.tool(
    "brain_query",
    "Query the project brain for decisions, architecture context, and team knowledge. " +
    "Returns a cited answer grounded in GitHub PRs, Slack discussions, Jira tickets, meeting notes, and prior agent sessions. " +
    "Call this at session start when working on an existing project, or before making any architectural or library choice that may have been decided before.",
    {
      query: z.string().describe("Natural language question about the project"),
      project_id: z.string().describe(
        "Project namespace to search (e.g. 'my_org_my_repo'). " +
        "Use underscore-separated org_repo format matching how the project was registered."
      ),
      mode: z.enum(["project"]).optional().describe(
        "Query mode. Currently only 'project' is active — scopes the query to the given project_id."
      ),
    },
    async ({ query, project_id, mode }) => {
      const response = await apiPost<QueryResponse>("/brain/query", {
        query,
        project_id,
        mode: mode ?? "project",
      });

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

  // ── Tool: brain_log_decision ────────────────────────────────────────────────

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
    "(human or agent) can query them with citations. Call this when making a significant architectural " +
    "choice, choosing a library, rejecting an approach, or identifying an unresolved question. " +
    "Logged decisions are treated as first-class brain knowledge alongside GitHub PRs and Jira tickets.",
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
      const now = new Date().toISOString();
      await apiPost("/brain/agent-log", {
        schema_version: "1.0",
        session_id,
        agent_id: AGENT_ID,
        project_id,
        timestamp_start: now,
        timestamp_end: now,
        decisions,
        work_completed,
        files_modified: files_modified ?? [],
        unresolved: unresolved ?? [],
        next_steps: next_steps ?? [],
      });

      return {
        content: [{
          type: "text",
          text:
            `✓ Logged ${decisions.length} decision${decisions.length !== 1 ? "s" : ""} to project brain (${project_id}).\n` +
            decisions.map((d) => `  • ${d.description}`).join("\n"),
        }],
      };
    }
  );

  // ── Tool: brain_analyze_impact ─────────────────────────────────────────────

  server.tool(
    "brain_analyze_impact",
    "Before making a significant code change, analyze which existing architectural decisions and linked tasks " +
    "it may affect. Returns risk tier (critical/high/medium/low) per decision, live Jira ticket status for " +
    "affected tasks, and an overall risk summary. Call this before refactoring a core module, switching a " +
    "library, changing an API contract, or any change that could invalidate a prior design decision.",
    {
      change_description: z.string().describe(
        "Plain-English description of the change you are about to make. " +
        "Be specific: mention the module, library, pattern, or API being changed."
      ),
      project_id: z.string().describe("Project namespace to search (e.g. 'my_org_my_repo')"),
    },
    async ({ change_description, project_id }) => {
      const response = await apiPost<{
        overall_risk: string;
        summary: string;
        affected_decisions: Array<{
          decision_id: string;
          summary: string;
          status: string;
          risk_tier: string;
          affected_tickets: Array<{
            ticket_ref: string;
            jira_summary?: string;
            jira_status?: string;
            jira_assignee?: string;
            jira_url?: string;
            risk_tier: string;
            reason: string;
          }>;
        }>;
        latency_ms: number;
      }>("/brain/query", {
        project_id,
        mode: "impact",
        change_description,
        query: change_description,
      });

      // Deterministic verdict — gives agents a machine-readable action without
      // requiring them to reason over the full report.
      const VERDICT_MAP: Record<string, { recommended_action: string; one_line: string }> = {
        critical: { recommended_action: "BLOCK",       one_line: "Stop — this change directly breaks an existing architectural decision." },
        high:     { recommended_action: "BLOCK",       one_line: "High risk — significant rework likely; consult team before proceeding." },
        medium:   { recommended_action: "FLAG",        one_line: "Medium risk — possible friction; log acknowledgment and proceed carefully." },
        low:      { recommended_action: response.affected_decisions.length > 0 ? "ACKNOWLEDGE" : "LOG_CLEAN", one_line: response.affected_decisions.length > 0 ? "Low risk — review affected decisions before proceeding." : "No conflicts found — safe to proceed." },
      };
      const verdict = VERDICT_MAP[response.overall_risk] ?? VERDICT_MAP["low"];

      const lines: string[] = [
        `## VERDICT: ${verdict.recommended_action}`,
        `> ${verdict.one_line}`,
        "",
        `## Impact Analysis — ${response.overall_risk.toUpperCase()} risk`,
        "",
        response.summary,
        "",
      ];

      if (response.affected_decisions.length > 0) {
        lines.push(`### Affected decisions (${response.affected_decisions.length})`);
        for (const d of response.affected_decisions.slice(0, 3)) {
          lines.push(`\n**${d.summary}** [${d.status}]`);
          if (d.affected_tickets.length > 0) {
            for (const t of d.affected_tickets) {
              const jiraInfo = t.jira_summary ? ` — ${t.jira_summary} (${t.jira_status ?? "unknown"})` : "";
              const assignee = t.jira_assignee ? ` · ${t.jira_assignee}` : "";
              lines.push(`  • ${t.ticket_ref}${jiraInfo}${assignee} [${t.risk_tier}] ${t.reason}`);
            }
          } else {
            lines.push(`  Risk: ${d.risk_tier}`);
          }
        }
      } else {
        lines.push("No existing decisions are relevant to this change.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  // ── Tool: brain_log_signal ──────────────────────────────────────────────────

  server.tool(
    "brain_log_signal",
    "Report an observation, finding, or new piece of information that may contradict or affect an existing " +
    "architectural decision. The brain will match it against known decisions and create drift alerts for human " +
    "review. Use this when you discover something unexpected during implementation — a library limitation, " +
    "a performance finding, an API constraint — that the team should know about relative to past decisions.",
    {
      text: z.string().describe("The observation or finding to report. Be specific."),
      project_id: z.string().describe("Project namespace"),
      source: z.enum(["github", "slack", "jira", "meeting", "agent", "document"]).describe(
        "Where this signal originated"
      ).default("agent"),
    },
    async ({ text, project_id, source }) => {
      const response = await apiPost<{
        ok: boolean;
        drift_alerts_created: number;
        matched_decisions: number;
        message: string;
      }>("/brain/signals", {
        text,
        project_id,
        source,
        actor_id: AGENT_ID,
        actor_name: AGENT_ID,
      });

      const summary = response.drift_alerts_created > 0
        ? `Signal logged — created ${response.drift_alerts_created} drift alert(s) for team review.`
        : `Signal logged — no existing decisions matched (threshold not met).`;

      return { content: [{ type: "text", text: summary }] };
    }
  );

  // ── Resource: brain://project/{project_id} ──────────────────────────────────

  server.resource(
    "project-snapshot",
    new ResourceTemplate("brain://project/{project_id}", { list: undefined }),
    async (uri, { project_id }) => {
      const id = Array.isArray(project_id) ? project_id[0] : project_id;

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

  return server;
}

// ── Start ─────────────────────────────────────────────────────────────────────

if (process.env.MCP_TRANSPORT === "http") {
  // HTTP + Streamable HTTP mode — remote clients (cloud-deployed brain)
  const port = parseInt(process.env.MCP_PORT ?? "3002");
  const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

  if (!MCP_AUTH_TOKEN) {
    console.warn("[purpl-brain-mcp] WARNING: MCP_AUTH_TOKEN is not set. HTTP transport is unauthenticated. Set MCP_AUTH_TOKEN in the environment before exposing this port to any network.");
  }

  // One transport per session; keyed by the session ID the transport assigns.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ status: "ok", transport: "streamable-http", sessions: sessions.size }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404).end("Not found");
      return;
    }

    // Require bearer token on all /mcp requests when MCP_AUTH_TOKEN is configured
    if (MCP_AUTH_TOKEN) {
      const authHeader = req.headers["authorization"] ?? "";
      const provided = Array.isArray(authHeader) ? authHeader[0] : authHeader;
      const token = provided.replace(/^Bearer\s+/i, "").trim();
      if (token !== MCP_AUTH_TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Unauthorized — set Authorization: Bearer <MCP_AUTH_TOKEN>" }));
        return;
      }
    }

    // Route to existing session if client sends Mcp-Session-Id
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      // New session — sessionId is assigned during handleRequest (initialize)
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });
      const server = buildServer();
      await server.connect(transport);
    }

    // Read body for POST requests
    let body: unknown;
    if (req.method === "POST") {
      body = await new Promise((resolve, reject) => {
        let raw = "";
        req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
        req.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
        });
        req.on("error", reject);
      });
    }

    await transport.handleRequest(req, res, body);

    // Register session after handleRequest assigns the session ID
    if (transport.sessionId && !sessions.has(transport.sessionId)) {
      sessions.set(transport.sessionId, transport);
      transport.onclose = () => sessions.delete(transport!.sessionId!);
    }
  });

  const bindHost = process.env.MCP_BIND_HOST ?? "127.0.0.1";
  httpServer.listen(port, bindHost, () => {
    console.log(`[purpl-brain-mcp] Streamable HTTP transport on ${bindHost}:${port}`);
    console.log(`[purpl-brain-mcp] Brain API: ${API_URL}`);
    console.log(`[purpl-brain-mcp] Endpoint: http://localhost:${port}/mcp`);
  });

} else {
  // stdio mode — local Claude Code / Cursor (default)
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No console.log after connect — stdio is the MCP channel
}
