import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { getSession } from "../lib/neo4j.js";
import { chat, chatStream, MODELS, PROVIDER } from "../lib/llm.js";
import { inferSourceFromEventId } from "../lib/event-source.js";
import type { QueryRequest, QueryResponse, Citation } from "@purpl/types";

// Ollama local dev uses tighter defaults to keep latency tolerable
const TOP_K = parseInt(process.env.QUERY_TOP_K ?? (PROVIDER === "ollama" ? "8" : "20"));
const CONTEXT_BUDGET_CHARS = parseInt(process.env.QUERY_CONTEXT_BUDGET ?? (PROVIDER === "ollama" ? "6000" : "12000"));

// Minimum cosine similarity score for a chunk to be included in context.
// Chunks below this threshold are dropped before the LLM sees them.
// Real-data eval showed noisy low-score chunks actively hurt agent alignment.
// Default 0.50 — conservative start; raise to 0.60-0.65 if results stay noisy.
const QUERY_MIN_SCORE = parseFloat(process.env.QUERY_MIN_SCORE ?? "0.50");

const ANSWER_SYSTEM_PROMPT = `You are a precise knowledge assistant for software engineering teams.
Answer questions using ONLY the provided source chunks. Every claim must be cited with [N] where N is the chunk number.

Citation rules:
- Use [N] immediately after any claim derived from chunk N
- If a claim spans multiple chunks, cite all of them: [1][3]
- Never state anything not grounded in the provided chunks
- If the chunks do not contain enough information, say so explicitly

Response format:
- Answer in plain prose, 2-5 sentences per point
- Do not add a Sources section — citations are shown separately`;

interface QdrantResult {
  id: string | number;
  score: number;
  payload?: Record<string, unknown>;
}

interface ContextChunk {
  index: number;
  content: string;
  source: string;
  source_url: string;
  actor_name: string;
  timestamp: string;
  project_id: string;
  score: number;
  graph_node_id: string;
}

async function vectorSearch(queryVector: number[], projectId: string): Promise<QdrantResult[]> {
  const results = await qdrant.search(COLLECTION, {
    vector: queryVector,
    limit: TOP_K,
    filter: {
      must: [{ key: "project_id", match: { value: projectId } }],
    },
    with_payload: true,
  });
  return results as QdrantResult[];
}

interface GraphContext {
  event_id: string;
  author_name: string;
  author_person_id: string;
  decisions: Array<{ summary: string; confidence: string; status: string }>;
  related_event_ids: string[];      // events sharing same decisions
  recent_author_activity: Array<{ event_id: string; timestamp: string; source: string }>;
  ticket_refs: string[];
  co_referenced_event_ids: string[]; // events sharing same tickets
}

/**
 * Multi-hop graph traversal from seed event_ids. For each seed, runs three
 * traversal patterns in parallel:
 *   1. Decision chain — decisions extracted from this event + other events
 *      sharing those decisions
 *   2. Author activity — other recent events by the same Person in this project
 *   3. Ticket linkage — tickets referenced by this event + other events
 *      referencing the same tickets (cross-source same-work-item context)
 */
async function graphExpand(
  eventIds: string[],
  projectId: string,
  since: string
): Promise<GraphContext[]> {
  if (eventIds.length === 0) return [];

  const expandOne = async (eventId: string): Promise<GraphContext> => {
    const [decisionRes, authorRes, ticketRes] = await Promise.all([
      (async () => {
        const s = getSession();
        try {
          return await s.run(
            `MATCH (seed:Event {event_id: $event_id})
             OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(seed)
               WHERE NOT (d)<-[:SUPERSEDES]-()
             OPTIONAL MATCH (d)-[:EXTRACTED_FROM]->(related:Event)
               WHERE related.event_id <> seed.event_id
               AND related.project_id = seed.project_id
             RETURN d.summary AS decision_summary,
                    d.confidence AS confidence,
                    d.status AS status,
                    collect(DISTINCT related.event_id) AS related_event_ids`,
            { event_id: eventId }
          );
        } finally { await s.close(); }
      })(),
      (async () => {
        const s = getSession();
        try {
          return await s.run(
            `MATCH (seed:Event {event_id: $event_id})-[:AUTHORED_BY]->(p:Person)
             OPTIONAL MATCH (p)<-[:AUTHORED_BY]-(recent:Event)
               WHERE recent.project_id = seed.project_id
               AND recent.event_id <> seed.event_id
               AND recent.timestamp >= $since
             WITH p, recent
             ORDER BY recent.timestamp DESC
             WITH p, collect(DISTINCT {event_id: recent.event_id, timestamp: recent.timestamp, source: recent.source})[..5] AS recent_activity
             RETURN p.name AS author_name,
                    p.person_id AS author_person_id,
                    recent_activity`,
            { event_id: eventId, since }
          );
        } finally { await s.close(); }
      })(),
      (async () => {
        const s = getSession();
        try {
          return await s.run(
            `MATCH (seed:Event {event_id: $event_id})-[:REFERENCES]->(t:Ticket)
             OPTIONAL MATCH (other:Event)-[:REFERENCES]->(t)
               WHERE other.event_id <> seed.event_id
               AND other.project_id = seed.project_id
             RETURN t.ref AS ticket_ref,
                    collect(DISTINCT other.event_id) AS co_referenced_event_ids`,
            { event_id: eventId }
          );
        } finally { await s.close(); }
      })(),
    ]);

      // Aggregate decisions
      const decisions: GraphContext["decisions"] = [];
      const relatedEventIdsSet = new Set<string>();
      for (const r of decisionRes.records) {
        const summary = r.get("decision_summary") as string | null;
        if (summary) {
          decisions.push({
            summary,
            confidence: (r.get("confidence") as string) ?? "",
            status: (r.get("status") as string) ?? "",
          });
        }
        const related = (r.get("related_event_ids") as string[]) ?? [];
        for (const id of related) if (id) relatedEventIdsSet.add(id);
      }

      // Author info
      let author_name = "";
      let author_person_id = "";
      let recent_author_activity: GraphContext["recent_author_activity"] = [];
      if (authorRes.records.length > 0) {
        const r = authorRes.records[0];
        author_name = (r.get("author_name") as string) ?? "";
        author_person_id = (r.get("author_person_id") as string) ?? "";
        const ra = (r.get("recent_activity") as Array<{
          event_id: string | null;
          timestamp: string | null;
          source: string | null;
        }>) ?? [];
        recent_author_activity = ra
          .filter((a) => a.event_id)
          .map((a) => ({
            event_id: a.event_id as string,
            timestamp: a.timestamp ?? "",
            source: a.source ?? "",
          }));
      }

      // Tickets
      const ticketRefs: string[] = [];
      const coReferencedSet = new Set<string>();
      for (const r of ticketRes.records) {
        const ref = r.get("ticket_ref") as string | null;
        if (ref) ticketRefs.push(ref);
        const co = (r.get("co_referenced_event_ids") as string[]) ?? [];
        for (const id of co) if (id) coReferencedSet.add(id);
      }

      return {
        event_id: eventId,
        author_name,
        author_person_id,
        decisions,
        related_event_ids: [...relatedEventIdsSet],
        recent_author_activity,
        ticket_refs: ticketRefs,
        co_referenced_event_ids: [...coReferencedSet],
      };
  };

  return Promise.all(eventIds.map(expandOne));
}

function assembleContext(chunks: ContextChunk[]): string {
  let context = "";
  let budget = CONTEXT_BUDGET_CHARS;

  for (const chunk of chunks) {
    const entry = `[${chunk.index}] Source: ${chunk.source_url} | Author: ${chunk.actor_name} | ${chunk.timestamp}\n${chunk.content}\n\n`;
    if (entry.length > budget) break;
    context += entry;
    budget -= entry.length;
  }

  return context.trim();
}

function extractCitationIndices(answer: string): number[] {
  const matches = answer.matchAll(/\[(\d+)\]/g);
  return [...new Set([...matches].map((m) => parseInt(m[1])))];
}

function validateCitations(answer: string, chunks: ContextChunk[]): boolean {
  const cited = extractCitationIndices(answer);
  return cited.every((i) => chunks.some((c) => c.index === i));
}

// ── Shared context preparation (embed → Qdrant → graph → assemble) ───────────

interface PreparedContext {
  chunks: ContextChunk[];
  context: string;
  userMessage: string;
  startMs: number;
}

async function prepareContext(request: QueryRequest): Promise<PreparedContext | null> {
  const startMs = Date.now();

  const queryVector = await embed(request.query);
  const vectorResults = await vectorSearch(queryVector, request.project_id);

  if (vectorResults.length === 0) return null;

  // Drop chunks below the minimum score threshold before they reach the LLM.
  // Low-score chunks are semantically distant from the query — injecting them
  // confuses the agent more than helping (validated in eval-agent-value-hono).
  const aboveThreshold = vectorResults.filter((r) => r.score >= QUERY_MIN_SCORE);
  if (aboveThreshold.length === 0) return null;

  const chunks: ContextChunk[] = aboveThreshold
    .filter((r) => r.payload)
    .map((r, i) => ({
      index: i + 1,
      content: String(r.payload!.content ?? ""),
      source: r.payload!.source
        ? String(r.payload!.source)
        : inferSourceFromEventId(String(r.payload!.graph_node_id ?? "")),
      source_url: String(r.payload!.source_url ?? ""),
      actor_name: String(r.payload!.actor_name ?? ""),
      timestamp: String(r.payload!.timestamp ?? ""),
      project_id: String(r.payload!.project_id ?? ""),
      score: r.score,
      graph_node_id: String(r.payload!.graph_node_id ?? ""),
    }));

  const eventIds = [...new Set(chunks.map((c) => c.graph_node_id))].filter(Boolean);
  const sinceIso =
    request.time_range?.from ??
    new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const graphData = await graphExpand(eventIds, request.project_id, sinceIso);

  const nowMs = Date.now();
  const formatAgo = (ts: string): string => {
    if (!ts) return "";
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return ts;
    const days = Math.max(0, Math.round((nowMs - t) / 86400000));
    if (days === 0) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  };

  for (const node of graphData) {
    const chunk = chunks.find((c) => c.graph_node_id === node.event_id);
    if (!chunk) continue;

    if (node.decisions.length > 0) {
      chunk.content += `\nDecisions: ${node.decisions.map((d) => `${d.summary} (${d.status || "unknown"}, ${d.confidence || "?"})`).join("; ")}`;
    }
    if (node.related_event_ids.length > 0) {
      const sample = node.related_event_ids.slice(0, 3).join(", ");
      const more = node.related_event_ids.length > 3 ? ` (+${node.related_event_ids.length - 3} more)` : "";
      chunk.content += `\nRelated events via shared decisions: ${sample}${more}`;
    }
    if (node.ticket_refs.length > 0) {
      chunk.content += `\nLinked tickets: ${node.ticket_refs.join(", ")}`;
    }
    if (node.co_referenced_event_ids.length > 0) {
      const sample = node.co_referenced_event_ids.slice(0, 3).join(", ");
      const more = node.co_referenced_event_ids.length > 3 ? ` (+${node.co_referenced_event_ids.length - 3} more)` : "";
      chunk.content += `\nOther events referencing same tickets: ${sample}${more}`;
    }
    if (node.recent_author_activity.length > 0) {
      const acts = node.recent_author_activity
        .map((a) => `${a.event_id} (${a.source || "unknown"}, ${formatAgo(a.timestamp)})`)
        .join("; ");
      chunk.content += `\n${node.author_name || "Author"} also worked on: ${acts}`;
    }
  }

  const context = assembleContext(chunks);
  const userMessage = `Question: ${request.query}

Retrieved context:
${context}

Answer the question using only the context above. Cite every claim with [N].`;

  return { chunks, context, userMessage, startMs };
}

function buildCitations(answer: string, chunks: ContextChunk[]): { citations: Citation[]; citationWarning: boolean } {
  const citationWarning = !validateCitations(answer, chunks);
  const citedIndices = extractCitationIndices(answer);
  const citations: Citation[] = chunks
    .filter((c) => citedIndices.includes(c.index))
    .map((c) => ({
      chunk_id: `${c.graph_node_id}_${c.index}`,
      source: c.source as Citation["source"],
      source_url: c.source_url,
      actor: { type: "human" as const, id: c.actor_name, name: c.actor_name },
      timestamp: c.timestamp,
      quoted_text: c.content.slice(0, 200),
      score: Math.round(c.score * 1000) / 1000, // 3 decimal places
    }));
  return { citations, citationWarning };
}

// ── Non-streaming (existing callers / MCP) ────────────────────────────────────

export async function runQuery(request: QueryRequest): Promise<QueryResponse> {
  const prepared = await prepareContext(request);

  if (!prepared) {
    return {
      answer: "No relevant information found in the brain for this project. Try ingesting more GitHub events first.",
      citations: [],
      latency_ms: 0,
      citation_warning: false,
    };
  }

  const { chunks, userMessage, startMs } = prepared;

  const raw = await chat(
    MODELS.QUERY,
    [
      { role: "system", content: ANSWER_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { maxTokens: PROVIDER === "ollama" ? 512 : 1024, temperature: 0 }
  );

  const answer = raw.replace(/\n+Sources:[\s\S]*$/i, "").trim();
  const { citations, citationWarning } = buildCitations(answer, chunks);

  return { answer, citations, latency_ms: Date.now() - startMs, citation_warning: citationWarning };
}

// ── Streaming — yields SSE-ready events ───────────────────────────────────────

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; answer: string; citations: Citation[]; citation_warning: boolean; latency_ms: number }
  | { type: "error"; message: string };

export async function* runQueryStream(request: QueryRequest): AsyncGenerator<StreamEvent> {
  let prepared: PreparedContext | null;
  try {
    prepared = await prepareContext(request);
  } catch (e) {
    yield { type: "error", message: String(e) };
    return;
  }

  if (!prepared) {
    yield {
      type: "done",
      answer: "No relevant information found in the brain for this project. Try ingesting more events first.",
      citations: [],
      citation_warning: false,
      latency_ms: 0,
    };
    return;
  }

  const { chunks, userMessage, startMs } = prepared;
  let fullAnswer = "";

  try {
    const tokenStream = chatStream(
      MODELS.QUERY,
      [
        { role: "system", content: ANSWER_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      { maxTokens: PROVIDER === "ollama" ? 512 : 1024, temperature: 0 }
    );

    for await (const token of tokenStream) {
      fullAnswer += token;
      yield { type: "delta", text: token };
    }
  } catch (e) {
    yield { type: "error", message: String(e) };
    return;
  }

  const answer = fullAnswer.replace(/\n+Sources:[\s\S]*$/i, "").trim();
  const { citations, citationWarning } = buildCitations(answer, chunks);

  yield {
    type: "done",
    answer,
    citations,
    citation_warning: citationWarning,
    latency_ms: Date.now() - startMs,
  };
}
