// Canonical event schema — single source of truth shared across api and web

export type EventSource = "github" | "slack" | "jira" | "linear" | "meeting" | "agent" | "document";

export type ActorType = "human" | "agent" | "collective";

export type EventType =
  | "pr_opened"
  | "pr_merged"
  | "pr_closed"
  | "pr_review"
  | "issue_created"
  | "issue_updated"
  | "comment"
  | "commit"
  | "agent_log"
  | "agent_session"
  | "slack_message"
  | "meeting_transcript"
  | "jira_issue"
  | "jira_comment"
  | "document_chunk";

export interface Actor {
  type: ActorType;
  id: string;
  name: string;
}

export interface CanonicalEvent {
  event_id: string;
  source: EventSource;
  source_id: string;
  project_id: string;
  actor: Actor;
  timestamp: string; // ISO 8601
  event_type: EventType;
  raw_content: string;
  url: string;
  // Slack-specific (optional)
  slack_channel?: string;
  slack_thread_ts?: string;
  slack_workspace?: string;
  // Jira-specific (optional)
  jira_issue_key?: string;
  jira_project_key?: string;
  // Meeting-specific (optional)
  meeting_title?: string;
  meeting_participants?: string[];
  // Document-specific (optional)
  document_title?: string;
  document_path?: string;
  document_type?: "adr" | "architecture" | "prd" | "runbook" | "demo" | "pitch" | "review" | "unknown";
  document_contributors?: string[]; // all git authors — populated for collective-authored docs
  chunk_index?: number;
  total_chunks?: number;
}

// Drift detection

export type DriftResolution = "pending" | "keep" | "under_review" | "reopen";

export interface DriftAlert {
  alert_id: string;
  decision_id: string;
  event_id: string;
  source: EventSource;
  content: string;         // truncated challenging content
  reason?: string;         // LLM one-sentence explanation of the contradiction
  actor: string;
  timestamp: string;
  confirmed_by_llm: boolean;
  resolution: DriftResolution;
  resolved_at?: string;
}

// Entity extraction output

export type ConfidenceLevel = "high" | "medium" | "low";

export interface Decision {
  quoted_text: string;
  summary: string;
  rationale: string | null;
  alternatives_considered: string[];
  confidence: ConfidenceLevel;
  // Fields from entity-extraction spec (optional — populated when extractable)
  decision_maker?: string;   // who made or announced the decision
  scope?: string;            // what this decision applies to
  reversible?: boolean;      // false = final, true = tentative/revisable
  codegen_prompt?: string;   // AI-ready implementation prompt, only for code-change decisions
}

export interface FollowUpTask {
  task_id: string;
  project_id: string;
  title: string;
  description: string;
  suggested_owner?: string;
  codegen_prompt?: string;
  source: "drift_reopen" | "manual";
  status: "open" | "in_progress" | "done";
  decision_id: string;
  decision_summary: string;
  created_at: string;
}

export interface ExtractionResult {
  event_id: string;
  project_id: string;
  source_id?: string;
  source_url: string;
  raw_content: string;
  actor: Actor;
  operator?: Actor; // human who triggered the agent session (agent logs only)
  timestamp: string;
  decisions: Decision[];
  ticket_refs: string[];
  person_mentions: string[];
  concept_tags: string[];
  decision_candidate: boolean;
}

// Query layer

// "project" and "temporal" are fully implemented.
// "expertise", "agent-resume", "impact" are spec-defined, degrade to "project" until implemented.
export type QueryMode = "project" | "temporal" | "expertise" | "agent-resume" | "impact";

export interface QueryRequest {
  query: string;
  project_id: string;
  mode?: QueryMode;
  time_range?: {
    from: string;
    to: string;
  };
  // Optional filters parsed from intent or passed directly
  domain_tags?: string[];          // e.g. ["auth", "payments"]
  question_type?: "current-state" | "why-decided" | "what-changed" | "what-affects";
  person_id?: string;              // filter by actor_person_id (for @mention queries)
}

export interface Citation {
  chunk_id: string;
  source: EventSource;
  source_url: string;
  actor: Actor;
  timestamp: string;
  quoted_text: string;
}

export interface QueryResponse {
  answer: string;
  citations: Citation[];
  latency_ms: number;
  citation_warning: boolean;
}

// Impact analysis

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

// Signal ingestion

export interface SignalRequest {
  text: string;
  project_id: string;
  source: EventSource;
  actor_id: string;
  actor_name: string;
  url?: string;
  occurred_at?: string;
}

export interface SignalResponse {
  ok: boolean;
  drift_alerts_created: number;
  matched_decisions: number;
  message: string;
}

// Project registration

export interface Project {
  project_id: string;
  name: string;
  github_repo_url: string;
  created_at: string;
}
