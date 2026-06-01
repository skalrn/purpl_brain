/**
 * MCP smoke test — verifies all MCP tools work against the live API.
 * Calls the API directly (same path the MCP server takes) to validate
 * inputs/outputs before testing the MCP protocol layer.
 *
 * Tools covered: brain_query (×3), brain_log_decision, brain_log_signal,
 *                brain_analyze_impact, drift-alerts resource
 */
import "dotenv/config";

const API = process.env.BRAIN_API_URL ?? "http://localhost:3741";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

const results: { id: string; pass: boolean; note: string }[] = [];

// T1 — brain_query: gzip compression decision
process.stdout.write("T1 brain_query (compression)... ");
try {
  const r = await post<{ answer: string; citations: unknown[] }>("/brain/query", {
    query: "What is the httpx compression policy?",
    project_id: "encode_httpx",
    mode: "project",
  });
  const pass = r.answer.length > 20 && r.citations.length > 0;
  results.push({ id: "T1", pass, note: `answer=${r.answer.slice(0,60)}... citations=${r.citations.length}` });
  console.log(pass ? "✓" : "✗");
} catch (e) { results.push({ id: "T1", pass: false, note: String(e) }); console.log("✗"); }

// T2 — brain_query: Jira auth decision
process.stdout.write("T2 brain_query (Jira auth)... ");
try {
  const r = await post<{ answer: string; citations: unknown[] }>("/brain/query", {
    query: "What was decided about the httpx authentication API?",
    project_id: "encode_httpx",
  });
  const pass = r.answer.length > 20;
  results.push({ id: "T2", pass, note: `answer=${r.answer.slice(0,60)}...` });
  console.log(pass ? "✓" : "✗");
} catch (e) { results.push({ id: "T2", pass: false, note: String(e) }); console.log("✗"); }

// T3 — brain_query: no-info negative
process.stdout.write("T3 brain_query (negative — GraphQL)... ");
try {
  const r = await post<{ answer: string; citations: unknown[] }>("/brain/query", {
    query: "What was decided about GraphQL support?",
    project_id: "encode_httpx",
  });
  const pass = r.answer.toLowerCase().includes("no") || r.citations.length === 0;
  results.push({ id: "T3", pass, note: `answer=${r.answer.slice(0,60)}...` });
  console.log(pass ? "✓" : "✗");
} catch (e) { results.push({ id: "T3", pass: false, note: String(e) }); console.log("✗"); }

// T4 — brain_log_decision (agent write-back)
process.stdout.write("T4 brain_log_decision... ");
try {
  const r = await post<{ ok: boolean; event_id: string }>("/brain/agent-log", {
    schema_version: "1.0",
    session_id: `mcp-smoke-test-${Date.now()}`,
    agent_id: "claude-code-smoke-test",
    project_id: "encode_httpx",
    timestamp_start: new Date().toISOString(),
    timestamp_end: new Date().toISOString(),
    decisions: [{
      id: "smoke-001",
      description: "Use stdio transport for local MCP server",
      rationale: "stdio is simpler than HTTP+SSE for local Claude Code use; defer remote transport to M6",
      alternatives_considered: ["HTTP+SSE", "WebSocket"],
      confidence: "high",
    }],
    work_completed: "MCP server scaffold with brain_query and brain_log_decision tools",
    files_modified: ["apps/mcp/src/index.ts"],
  });
  const pass = r.ok === true && typeof r.event_id === "string";
  results.push({ id: "T4", pass, note: `event_id=${r.event_id}` });
  console.log(pass ? "✓" : "✗");
} catch (e) { results.push({ id: "T4", pass: false, note: String(e) }); console.log("✗"); }

// T5 — drift alerts resource (GET)
process.stdout.write("T5 drift-alerts GET... ");
try {
  const r = await get<{ alerts: unknown[] }>("/brain/drift-alerts?project_id=encode_httpx");
  const pass = Array.isArray(r.alerts);
  results.push({ id: "T5", pass, note: `alerts=${r.alerts.length}` });
  console.log(pass ? "✓" : "✗");
} catch (e) { results.push({ id: "T5", pass: false, note: String(e) }); console.log("✗"); }

// T6 — brain_analyze_impact
process.stdout.write("T6 brain_analyze_impact... ");
try {
  const r = await post<{ overall_risk: string; summary: string; affected_decisions: unknown[] }>("/brain/query", {
    query: "switch from httpx to aiohttp",
    project_id: "encode_httpx",
    mode: "impact",
    change_description: "switch from httpx to aiohttp for all HTTP calls",
  });
  const validRisk = ["critical", "high", "medium", "low"].includes(r.overall_risk);
  const pass = validRisk && typeof r.summary === "string" && Array.isArray(r.affected_decisions);
  results.push({ id: "T6", pass, note: `risk=${r.overall_risk} decisions=${r.affected_decisions.length}` });
  console.log(pass ? "✓" : "✗");
} catch (e) { results.push({ id: "T6", pass: false, note: String(e) }); console.log("✗"); }

// T7 — brain_log_signal (agent drift signal)
process.stdout.write("T7 brain_log_signal... ");
try {
  const r = await post<{ ok: boolean; drift_alerts_created: number; matched_decisions: number }>("/brain/signals", {
    text: "Discovered that httpx does not support HTTP/3 natively — may require rethinking transport layer",
    project_id: "encode_httpx",
    source: "agent",
    actor_id: "claude-code-smoke-test",
    actor_name: "claude-code-smoke-test",
  });
  const pass = r.ok === true && typeof r.drift_alerts_created === "number";
  results.push({ id: "T7", pass, note: `ok=${r.ok} drift_alerts=${r.drift_alerts_created} matched=${r.matched_decisions}` });
  console.log(pass ? "✓" : "✗");
} catch (e) { results.push({ id: "T7", pass: false, note: String(e) }); console.log("✗"); }

// Scorecard
const passed = results.filter(r => r.pass).length;
console.log(`\n${"═".repeat(60)}`);
console.log("  MCP SMOKE TEST — SCORECARD");
console.log("═".repeat(60));
for (const r of results) console.log(`  ${r.pass ? "✓" : "✗"} ${r.id}: ${r.note}`);
console.log("─".repeat(60));
console.log(`  ${passed}/${results.length} passed`);
console.log("═".repeat(60));
process.exit(passed === results.length ? 0 : 1);
