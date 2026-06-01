const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3741";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? "";

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      ...init?.headers,
    },
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ── Response types ──────────────────────────────────────────────────────────

export interface Project {
  project_id: string;
  event_count: number;
  decision_count: number;
  pending_drift_count: number;
  pending_tasks_count: number;
  sessions_since: number;
  decisions_since: number;
  last_event_at: string | null;
  last_decision_logged_at: string | null;
  last_session_agent_id: string | null;
  last_session_operator_name: string | null;
  last_session_work_summary: string | null;
  active_sources: string[];
}

export interface ProjectsResponse {
  projects: Project[];
  total: number;
  since: string | null;
}

export interface DriftAlert {
  alert_id: string;
  decision_id: string;
  decision_summary: string;
  project_id: string;
  source: string;
  content: string;
  reason: string | null;
  actor: string;
  timestamp: string;
  resolution: string;
  confirmed_by_llm: boolean;
  fingerprint: string | null;
}

export interface DriftAlertsResponse {
  alerts: DriftAlert[];
  project_id: string | null;
}

export interface AgentSession {
  event_id: string;
  agent_id: string;
  agent_type: "coding" | "infra" | "other";
  operator_id: string | null;
  operator_name: string | null;
  timestamp: string;
  decision_count: number;
  decisions_with_alternatives: number;
  work_summary: string;
}

export interface AgentSessionsResponse {
  sessions: AgentSession[];
  total: number;
  project_id: string;
}

export interface DecisionDetail {
  decision_id: string;
  summary: string;
  rationale: string | null;
  alternatives_considered: string[];
  confidence: string;
  status: string;
}

export interface PreflightCheck {
  check_id: string;
  change_description: string;
  overall_risk: string;
  summary: string;
  affected_decision_count: number;
  checked_at: string;
}

export interface AgentSessionDetail {
  event_id: string;
  agent_id: string;
  agent_type: "coding" | "infra" | "other";
  operator_id: string | null;
  operator_name: string | null;
  project_id: string;
  timestamp: string;
  raw_content: string;
  decisions: DecisionDetail[];
  preflight_checks: PreflightCheck[];
  brain_query_results_count: number | null;
  brain_query_distinct_sessions_count: number | null;
}

export interface Decision {
  decision_id: string;
  summary: string;
  rationale: string | null;
  confidence: string;
  alternatives_considered: string[];
  valid_from: string;
  agent_id: string;
  operator_name: string | null;
  event_id: string;
  event_source: string;
  has_lineage: boolean;
}

export interface ChainNode {
  decision_id: string;
  summary: string;
  rationale: string | null;
  valid_from: string;
  confidence: string;
  status: string;
  drift_alerts: Array<{
    alert_id: string;
    reason: string | null;
    content: string;
    resolution: string;
    resolution_reason: string | null;
    timestamp: string;
    source: string;
  }>;
}

export function fetchDecisionChain(decisionId: string): Promise<{ chain: ChainNode[] }> {
  return apiFetch<{ chain: ChainNode[] }>(`/brain/decisions/${encodeURIComponent(decisionId)}/chain`);
}

export interface DecisionsResponse {
  decisions: Decision[];
  project_id: string;
  total: number;
}

export interface FollowUpTask {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  suggested_owner?: string;
  codegen_prompt?: string | null;
  requires_approval: boolean;
  source: string;
  status: string;
  decision_id: string;
  decision_summary: string;
  created_at: string;
}

export interface TasksResponse {
  tasks: FollowUpTask[];
  total: number;
}

// ── API helpers ─────────────────────────────────────────────────────────────

export interface QueryResult {
  answer: string;
  citations: Array<{ source_url?: string; quoted_text?: string }>;
  corpus_size: number;
  citation_warning: boolean;
}

export function apiBrainQuery(query: string, projectId: string): Promise<QueryResult> {
  return apiFetch<QueryResult>("/brain/query", {
    method: "POST",
    body: JSON.stringify({ query, project_id: projectId }),
  });
}

export function fetchProjects(since?: string): Promise<ProjectsResponse> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  return apiFetch<ProjectsResponse>(`/brain/projects${qs}`);
}

export function fetchDriftAlerts(projectId?: string): Promise<DriftAlertsResponse> {
  const qs = projectId ? `?project_id=${encodeURIComponent(projectId)}` : "";
  return apiFetch<DriftAlertsResponse>(`/brain/drift-alerts${qs}`);
}

export function resolveDriftAlert(
  alertId: string,
  resolution: "keep" | "under_review" | "reopen" | "escalate",
  resolution_reason?: string
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/brain/drift-alerts/${alertId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolution, resolution_reason }),
  });
}

export function fetchAgentSessions(projectId: string): Promise<AgentSessionsResponse> {
  return apiFetch<AgentSessionsResponse>(
    `/brain/agent-sessions?project_id=${encodeURIComponent(projectId)}`
  );
}

export function fetchAgentSession(eventId: string): Promise<AgentSessionDetail> {
  return apiFetch<AgentSessionDetail>(`/brain/agent-sessions/${encodeURIComponent(eventId)}`);
}

export function logSeedDecision(
  projectId: string,
  description: string,
  rationale: string
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  return apiFetch<{ ok: boolean }>("/brain/agent-log", {
    method: "POST",
    body: JSON.stringify({
      schema_version: "1.0",
      session_id: `seed-${Date.now()}`,
      agent_id: "human-seed",
      project_id: projectId,
      timestamp_start: now,
      timestamp_end: now,
      work_completed: "Manual seed decision logged via onboarding",
      decisions: [
        {
          id: "seed-1",
          description,
          rationale,
          confidence: "high",
        },
      ],
    }),
  });
}

export function fetchDecisions(projectId: string, limit = 50): Promise<DecisionsResponse> {
  return apiFetch<DecisionsResponse>(
    `/brain/decisions?project_id=${encodeURIComponent(projectId)}&limit=${limit}`
  );
}

export interface DecisionDriftAlert {
  alert_id: string;
  source: string;
  content: string;
  reason: string | null;
  actor: string;
  timestamp: string;
  resolution: string;
}

export interface DecisionFollowUpTask {
  task_id: string;
  title: string;
  description: string | null;
  status: string;
  created_at: string;
  suggested_owner?: string;
  codegen_prompt?: string | null;
}

export interface LineageNode {
  decision_id: string;
  summary: string;
  valid_from: string;
}

export interface DecisionFull {
  decision_id: string;
  summary: string;
  rationale: string | null;
  alternatives_considered: string[];
  confidence: string;
  status: string;
  valid_from: string;
  event_id: string;
  event_source: string;
  event_url: string | null;
  event_timestamp: string;
  agent_id: string;
  operator_name: string | null;
  project_id: string;
  codegen_prompt?: string | null;
  drift_alerts: DecisionDriftAlert[];
  follow_up_tasks: DecisionFollowUpTask[];
  supersedes: LineageNode | null;
  superseded_by: LineageNode | null;
}

// ── Impact analysis ──────────────────────────────────────────────────────────

export interface ImpactTask {
  ticket_ref: string;
  jira_summary?: string;
  jira_status?: string;
  jira_assignee?: string;
  jira_url?: string;
  risk_tier: "critical" | "high" | "medium" | "low";
  reason: string;
}

export interface ImpactDecision {
  decision_id: string;
  summary: string;
  rationale: string | null;
  status: string;
  affected_tickets: ImpactTask[];
}

export interface ImpactResponse {
  change_description: string;
  overall_risk: "critical" | "high" | "medium" | "low";
  summary: string;
  affected_decisions: ImpactDecision[];
  latency_ms: number;
}

export function fetchDecisionDetail(decisionId: string): Promise<DecisionFull> {
  return apiFetch<DecisionFull>(`/brain/decisions/${encodeURIComponent(decisionId)}`);
}

export function fetchTasks(projectId: string, status?: string): Promise<TasksResponse> {
  const qs = status
    ? `?project_id=${encodeURIComponent(projectId)}&status=${encodeURIComponent(status)}`
    : `?project_id=${encodeURIComponent(projectId)}`;
  return apiFetch<TasksResponse>(`/brain/tasks${qs}`);
}

export function analyzeImpact(projectId: string, changeDescription: string): Promise<ImpactResponse> {
  return apiFetch<ImpactResponse>("/query", {
    method: "POST",
    body: JSON.stringify({
      query: changeDescription,
      project_id: projectId,
      mode: "impact",
      change_description: changeDescription,
    }),
  });
}

export function ingestTranscript(params: {
  project_id: string;
  text: string;
  title?: string;
  occurred_at?: string;
  source_url?: string;
}): Promise<{ ok: boolean; chunks_queued: number; format: string; speakers: string[]; message: string }> {
  return apiFetch("/brain/ingest/transcript", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export function submitSignal(params: {
  project_id: string;
  text: string;
  source: string;
  actor_id: string;
  actor_name: string;
  url?: string;
  occurred_at?: string;
}): Promise<{ ok: boolean; drift_alerts_created: number; matched_decisions: number; message: string }> {
  return apiFetch("/brain/signals", {
    method: "POST",
    body: JSON.stringify(params),
  });
}

// ── Utilities ───────────────────────────────────────────────────────────────

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
