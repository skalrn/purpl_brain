import type { EventSource } from "@purpl/types";

/**
 * Infer the EventSource for a canonical event_id.
 *
 * The event_id prefix is the only source-of-truth for source on the Event
 * node in Neo4j (we MERGE on event_id, not (source, source_actor_id)). This
 * helper consolidates the prefix-ladder that previously lived in
 * brain-writer.ts (twice), query-engine.ts, and drift-detector.ts.
 *
 * Defaults to "github" — events seeded from the initial GitHub batch use
 * prefixes like "seed_" or "gh_" and predate the canonical-id convention.
 */
export function inferSourceFromEventId(eventId: string): EventSource {
  if (eventId.startsWith("slack_")) return "slack";
  if (eventId.startsWith("meeting_")) return "meeting";
  if (eventId.startsWith("jira_")) return "jira";
  if (eventId.startsWith("doc_")) return "document";
  if (eventId.startsWith("agent_")) return "agent";
  return "github";
}
