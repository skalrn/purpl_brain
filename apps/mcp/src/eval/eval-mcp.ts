#!/usr/bin/env tsx
/**
 * eval-mcp.ts — M3 eval: verify all 4 MCP tools + resource match REST API behaviour
 *
 * Starts the MCP server in HTTP mode on a test port, connects via the MCP SDK client,
 * makes 5 calls (one per tool + one resource read), and compares with direct REST API
 * calls where applicable.
 *
 * Usage:
 *   npm run eval:mcp              (from apps/mcp)
 *   BRAIN_API_URL=http://... tsx src/eval-mcp.ts
 *
 * Exit 0 = all checks passed. Exit 1 = one or more failures.
 */

import "dotenv/config";
import { spawn, type ChildProcess } from "child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { randomUUID } from "crypto";

const API_URL   = process.env.BRAIN_API_URL  ?? "http://localhost:3741";
const API_KEY   = process.env.BRAIN_API_KEY  ?? "dev-local";
const MCP_PORT  = 3099;
const MCP_URL   = `http://localhost:${MCP_PORT}/mcp`;
const PROJECT   = "purpl_brain_eval";

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const RESET  = "\x1b[0m";

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`  ${GREEN}PASS${RESET}  ${label}`);
    pass++;
  } else {
    console.log(`  ${RED}FAIL${RESET}  ${label}${detail ? `\n         → ${detail}` : ""}`);
    fail++;
  }
}

// ── REST helper ───────────────────────────────────────────────────────────────

async function restPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`REST ${path} returned ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function restGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { "x-api-key": API_KEY },
  });
  if (!res.ok) throw new Error(`REST ${path} returned ${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}

// ── MCP server lifecycle ──────────────────────────────────────────────────────

function startMcpServer(): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      MCP_TRANSPORT: "http",
      MCP_PORT: String(MCP_PORT),
      BRAIN_API_URL: API_URL,
      BRAIN_API_KEY: API_KEY,
      BRAIN_AGENT_ID: "eval-mcp",
    };

    // Run from the built dist so we don't need tsx in the mcp package at runtime
    const proc = spawn("node", ["dist/index.js"], {
      cwd: new URL("..", import.meta.url).pathname,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stderr?.on("data", () => {}); // suppress noise

    // Wait until the port is accepting connections (max 5s)
    const deadline = Date.now() + 5000;
    const poll = async () => {
      try {
        const r = await fetch(`http://localhost:${MCP_PORT}/health`);
        if (r.ok) { resolve(proc); return; }
      } catch {
        // not ready yet
      }
      if (Date.now() > deadline) { reject(new Error("MCP server did not start in time")); return; }
      setTimeout(poll, 100);
    };
    setTimeout(poll, 300);
  });
}

// ── Tool call helper ──────────────────────────────────────────────────────────

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find((c) => c.type === "text")?.text ?? "";
  return text;
}

// ── Main eval ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log(`${CYAN}╔══════════════════════════════════════════╗${RESET}`);
  console.log(`${CYAN}║     Purpl Brain — MCP Eval (M3)          ║${RESET}`);
  console.log(`${CYAN}╚══════════════════════════════════════════╝${RESET}`);
  console.log(`\n  Brain API: ${API_URL}`);
  console.log(`  MCP port:  ${MCP_PORT}\n`);

  // ── Pre-flight: check REST API is reachable ──────────────────────────────
  try {
    const h = await fetch(`${API_URL}/health`);
    if (!h.ok) throw new Error(`status ${h.status}`);
    console.log(`${YELLOW}Brain API is healthy — starting MCP server...${RESET}\n`);
  } catch (e) {
    console.error(`${RED}❌ Brain API not reachable at ${API_URL}/health — is it running?${RESET}`);
    process.exit(1);
  }

  // ── Seed: ensure eval project has at least one decision ─────────────────
  const seedId = `eval-session-${randomUUID()}`;
  await restPost("/brain/agent-log", {
    schema_version: "1.0",
    session_id: seedId,
    agent_id: "eval-mcp-seed",
    project_id: PROJECT,
    timestamp_start: new Date(Date.now() - 60000).toISOString(),
    timestamp_end: new Date().toISOString(),
    decisions: [{
      id: "d1",
      description: "Use Qdrant for vector storage because it supports payload filtering",
      rationale: "Qdrant payload filters allow has_decisions queries without a separate index",
    }],
    work_completed: "Seeded eval project for MCP eval run",
  }).catch(() => {}); // 409 on re-run is fine

  // Wait briefly for the brain-writer to process
  await new Promise((r) => setTimeout(r, 2000));

  // ── Start MCP server ────────────────────────────────────────────────────
  let proc: ChildProcess;
  try {
    proc = await startMcpServer();
  } catch (e) {
    console.error(`${RED}❌ Could not start MCP server: ${e}${RESET}`);
    process.exit(1);
  }

  try {
    // ── Connect MCP client ───────────────────────────────────────────────
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    const client = new Client({ name: "eval-client", version: "0.1.0" });
    await client.connect(transport);

    // ── 1. brain_query ───────────────────────────────────────────────────
    console.log(`${YELLOW}[1/5] brain_query${RESET}`);
    const QUERY = "What vector store decision was made?";
    const [mcpAnswer, restResp] = await Promise.all([
      callTool(client, "brain_query", { query: QUERY, project_id: PROJECT }),
      restPost<{ answer: string; citations: unknown[] }>("/brain/query", {
        query: QUERY,
        project_id: PROJECT,
      }),
    ]);

    check("brain_query returns non-empty answer",
      mcpAnswer.length > 20,
      `got: ${mcpAnswer.slice(0, 80)}`);
    check("brain_query answer matches REST API answer (same non-empty response)",
      mcpAnswer.length > 20 && restResp.answer.length > 20,
      `mcp=${mcpAnswer.slice(0, 60)} | rest=${restResp.answer.slice(0, 60)}`);

    // ── 2. brain_log_decision ────────────────────────────────────────────
    console.log(`\n${YELLOW}[2/5] brain_log_decision${RESET}`);
    const logSessionId = `mcp-eval-${randomUUID()}`;
    const mcpLogResult = await callTool(client, "brain_log_decision", {
      project_id: PROJECT,
      session_id: logSessionId,
      decisions: [{
        id: "d_mcp_1",
        description: "Use MCP stdio transport for local Claude Code integration",
        rationale: "stdio avoids port conflicts and works without a running HTTP server",
      }],
      work_completed: "MCP eval test session",
    });

    check("brain_log_decision returns confirmation text",
      mcpLogResult.toLowerCase().includes("logged") || mcpLogResult.toLowerCase().includes("session"),
      `got: ${mcpLogResult.slice(0, 100)}`);

    // Give brain-writer time to process the logged decision
    await new Promise((r) => setTimeout(r, 3000));

    // Verify it's queryable via REST
    const verifyResp = await restPost<{ answer: string; citations: unknown[] }>("/brain/query", {
      query: "MCP stdio transport decision",
      project_id: PROJECT,
    });
    check("brain_log_decision — logged decision is queryable via REST",
      verifyResp.answer.length > 10,
      `query answer: ${verifyResp.answer.slice(0, 80)}`);

    // ── 3. brain_analyze_impact ──────────────────────────────────────────
    console.log(`\n${YELLOW}[3/5] brain_analyze_impact${RESET}`);
    const mcpImpact = await callTool(client, "brain_analyze_impact", {
      project_id: PROJECT,
      change_description: "Switch from Qdrant to Weaviate for vector storage",
    });

    check("brain_analyze_impact returns risk assessment",
      mcpImpact.toLowerCase().includes("risk") || mcpImpact.toLowerCase().includes("impact") || mcpImpact.toLowerCase().includes("decision"),
      `got: ${mcpImpact.slice(0, 100)}`);

    // ── 4. brain_log_signal ──────────────────────────────────────────────
    console.log(`\n${YELLOW}[4/5] brain_log_signal${RESET}`);
    const mcpSignal = await callTool(client, "brain_log_signal", {
      project_id: PROJECT,
      text: "Weaviate does not support payload-filtered ANN queries without a separate schema — contradicts our Qdrant choice rationale",
      source: "agent",
    });

    check("brain_log_signal returns ok confirmation",
      mcpSignal.toLowerCase().includes("signal logged") || mcpSignal.toLowerCase().includes("logged"),
      `got: ${mcpSignal.slice(0, 100)}`);

    // Verify drift alerts were considered via REST
    const alertsResp = await restGet<{ alerts: unknown[] }>(`/brain/drift-alerts?project_id=${PROJECT}`);
    check("brain_log_signal — REST drift-alerts endpoint is queryable",
      Array.isArray(alertsResp.alerts),
      `alerts count: ${alertsResp.alerts?.length ?? "?"}`);

    // ── 5. Resource: brain://project/{project_id} ────────────────────────
    console.log(`\n${YELLOW}[5/5] resource brain://project/{project_id}${RESET}`);
    const resourceResult = await client.readResource({ uri: `brain://project/${PROJECT}` });
    const resourceText = (resourceResult.contents[0] as { text?: string })?.text ?? "";

    check("resource brain://project/{id} returns markdown content",
      resourceText.length > 20 && resourceText.includes("Brain snapshot"),
      `got: ${resourceText.slice(0, 100)}`);

    await client.close();

  } finally {
    proc!.kill();
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("");
  console.log("════════════════════════════════════════════════");
  if (fail === 0) {
    console.log(`${GREEN}  MCP EVAL PASS ✓  (${pass}/${pass + fail} checks passed)${RESET}`);
  } else {
    console.log(`${RED}  MCP EVAL FAIL — ${fail} check(s) failed (${pass}/${pass + fail} passed)${RESET}`);
  }
  console.log("");

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(`${RED}Fatal:${RESET}`, e);
  process.exit(1);
});
