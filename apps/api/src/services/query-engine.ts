import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";
import { getSession } from "../lib/neo4j.js";
import { chat, MODELS } from "../lib/llm.js";
import type { QueryRequest, QueryResponse, Citation } from "@purpl/types";

const TOP_K = 10;
const CONTEXT_BUDGET_CHARS = 24000; // ~6000 tokens at 4 chars/token

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

async function graphExpand(eventIds: string[]): Promise<Record<string, unknown>[]> {
  if (eventIds.length === 0) return [];
  const session = getSession();
  try {
    const result = await session.run(
      `UNWIND $event_ids AS eid
       MATCH (e:Event {event_id: eid})
       OPTIONAL MATCH (e)-[:AUTHORED_BY]->(p:Person)
       OPTIONAL MATCH (d:Decision)-[:EXTRACTED_FROM]->(e)
       OPTIONAL MATCH (e)-[:REFERENCES]->(t:Ticket)
       RETURN e.event_id AS event_id,
              p.name AS author,
              collect(DISTINCT d.summary) AS decisions,
              collect(DISTINCT t.ref) AS tickets`,
      { event_ids: eventIds }
    );
    return result.records.map((r) => r.toObject());
  } finally {
    await session.close();
  }
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

export async function runQuery(request: QueryRequest): Promise<QueryResponse> {
  const startMs = Date.now();

  // Step 1: embed the query
  const queryVector = await embed(request.query);

  // Step 2: vector search filtered by project
  const vectorResults = await vectorSearch(queryVector, request.project_id);

  if (vectorResults.length === 0) {
    return {
      answer: "No relevant information found in the brain for this project. Try ingesting more GitHub events first.",
      citations: [],
      latency_ms: Date.now() - startMs,
      citation_warning: false,
    };
  }

  // Step 3: build context chunks from vector results
  const chunks: ContextChunk[] = vectorResults
    .filter((r) => r.payload)
    .map((r, i) => ({
      index: i + 1,
      content: String(r.payload!.content ?? ""),
      source_url: String(r.payload!.source_url ?? ""),
      actor_name: String(r.payload!.actor_name ?? ""),
      timestamp: String(r.payload!.timestamp ?? ""),
      project_id: String(r.payload!.project_id ?? ""),
      score: r.score,
      graph_node_id: String(r.payload!.graph_node_id ?? ""),
    }));

  // Step 4: graph expand to pull in decisions and linked entities
  const eventIds = [...new Set(chunks.map((c) => c.graph_node_id))];
  const graphData = await graphExpand(eventIds);

  // Append graph context to relevant chunks
  for (const node of graphData) {
    const decisions = node.decisions as string[];
    const tickets = node.tickets as string[];
    const chunk = chunks.find((c) => c.graph_node_id === node.event_id);
    if (chunk && decisions.length > 0) {
      chunk.content += `\nDecisions: ${decisions.filter(Boolean).join("; ")}`;
    }
    if (chunk && tickets.length > 0) {
      chunk.content += `\nLinked tickets: ${tickets.filter(Boolean).join(", ")}`;
    }
  }

  // Step 5: assemble context window
  const context = assembleContext(chunks);

  // Step 6: generate grounded answer
  const userMessage = `Question: ${request.query}

Retrieved context:
${context}

Answer the question using only the context above. Cite every claim with [N].`;

  const raw = await chat(
    MODELS.QUERY,
    [
      { role: "system", content: ANSWER_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    { maxTokens: 1024, temperature: 0 }
  );

  // Strip the Sources section — citations are shown via UI cards
  const answer = raw.replace(/\n+Sources:[\s\S]*$/i, "").trim();

  // Step 7: validate citations
  const citationWarning = !validateCitations(answer, chunks);

  // Step 8: build citation objects for cited chunks only
  const citedIndices = extractCitationIndices(answer);
  const citations: Citation[] = chunks
    .filter((c) => citedIndices.includes(c.index))
    .map((c) => ({
      chunk_id: `${c.graph_node_id}_${c.index}`,
      source: "github" as const,
      source_url: c.source_url,
      actor: { type: "human" as const, id: c.actor_name, name: c.actor_name },
      timestamp: c.timestamp,
      quoted_text: c.content.slice(0, 200),
    }));

  return {
    answer,
    citations,
    latency_ms: Date.now() - startMs,
    citation_warning: citationWarning,
  };
}
