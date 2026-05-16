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
  | "agent_log";

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
  mode: QueryMode;
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
