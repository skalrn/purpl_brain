// Canonical event schema — single source of truth shared across api and web

export type EventSource = "github" | "slack" | "jira" | "linear" | "meeting" | "agent";

export type ActorType = "human" | "agent";

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
  | "slack_message"
  | "meeting_transcript"
  | "jira_issue"
  | "jira_comment";

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
}

// Drift detection

export type DriftResolution = "pending" | "keep" | "under_review" | "reopen";

export interface DriftAlert {
  alert_id: string;
  decision_id: string;
  event_id: string;
  source: EventSource;
  content: string;         // truncated challenging content
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
}

export interface ExtractionResult {
  event_id: string;
  project_id: string;
  source_url: string;
  raw_content: string;
  actor: Actor;
  timestamp: string;
  decisions: Decision[];
  ticket_refs: string[];
  person_mentions: string[];
  concept_tags: string[];
  decision_candidate: boolean;
}

// Query layer

export type QueryMode = "project" | "temporal";

export interface QueryRequest {
  query: string;
  project_id: string;
  mode?: QueryMode;
  time_range?: {
    from: string;
    to: string;
  };
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

// Project registration

export interface Project {
  project_id: string;
  name: string;
  github_repo_url: string;
  created_at: string;
}
