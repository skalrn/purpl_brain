import "dotenv/config";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { STREAMS } from "../lib/redis.js";
import { getSession } from "../lib/neo4j.js";
import { qdrant, COLLECTION, ensureCollection } from "../lib/qdrant.js";
import { embed, embedBatch } from "../lib/embed.js";
import type { ExtractionResult, Decision } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const GROUP = "brain-writer";
const CONSUMER = "brain-writer-1";
const BLOCK_MS = 5000;
const CHUNK_MAX_CHARS = 1600; // ~400 tokens at 4 chars/token

async function ensureGroup() {
  try {
    await redis.xgroup("CREATE", STREAMS.EXTRACTED, GROUP, "0", "MKSTREAM");
  } catch (e: unknown) {
    if (!(e instanceof Error) || !e.message.includes("BUSYGROUP")) throw e;
  }
}

// Split content into semantically coherent chunks
function chunkContent(content: string, sourceId: string): Array<{ id: string; text: string }> {
  if (!content.trim()) return [];

  const paragraphs = content.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
  const chunks: Array<{ id: string; text: string }> = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > CHUNK_MAX_CHARS && current) {
      chunks.push({ id: `${sourceId}_${chunks.length}`, text: current.trim() });
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) {
    chunks.push({ id: `${sourceId}_${chunks.length}`, text: current.trim() });
  }

  return chunks;
}

async function writeToNeo4j(result: ExtractionResult) {
  const session = getSession();
  try {
    // Create/merge Event node
    await session.run(
      `MERGE (e:Event {event_id: $event_id})
       SET e.source = $source,
           e.event_type = $event_type,
           e.project_id = $project_id,
           e.timestamp = $timestamp,
           e.url = $url,
           e.raw_content = $raw_content
       RETURN e`,
      {
        event_id: result.event_id,
        source: "github",
        event_type: "ingested",
        project_id: result.project_id,
        timestamp: result.timestamp,
        url: result.source_url,
        raw_content: result.source_url, // store URL as ref, not full content in graph
      }
    );

    // Create/merge Person node and link to Event
    await session.run(
      `MERGE (p:Person {id: $actor_id})
       SET p.name = $actor_name, p.type = $actor_type
       WITH p
       MATCH (e:Event {event_id: $event_id})
       MERGE (e)-[:AUTHORED_BY]->(p)`,
      {
        actor_id: result.actor.id,
        actor_name: result.actor.name,
        actor_type: result.actor.type,
        event_id: result.event_id,
      }
    );

    // Create/merge Ticket nodes and link to Event
    for (const ref of result.ticket_refs) {
      await session.run(
        `MERGE (t:Ticket {ref: $ref})
         WITH t
         MATCH (e:Event {event_id: $event_id})
         MERGE (e)-[:REFERENCES]->(t)`,
        { ref, event_id: result.event_id }
      );
    }

    // Create Decision nodes and link to Event
    for (const decision of result.decisions) {
      const decisionId = uuidv4();
      await session.run(
        `MATCH (e:Event {event_id: $event_id})
         CREATE (d:Decision {
           decision_id: $decision_id,
           event_id: $event_id,
           quoted_text: $quoted_text,
           summary: $summary,
           rationale: $rationale,
           confidence: $confidence,
           valid_from: $valid_from,
           valid_to: null
         })
         CREATE (d)-[:EXTRACTED_FROM]->(e)`,
        {
          event_id: result.event_id,
          decision_id: decisionId,
          quoted_text: decision.quoted_text,
          summary: decision.summary,
          rationale: decision.rationale ?? "",
          confidence: decision.confidence,
          valid_from: result.timestamp,
        }
      );
    }

    console.log(
      `[brain-writer] neo4j: event=${result.event_id} decisions=${result.decisions.length} tickets=${result.ticket_refs.length}`
    );
  } finally {
    await session.close();
  }
}

async function writeToQdrant(result: ExtractionResult) {
  // Decision events: index clean decision text for precise retrieval
  // Candidate events with no extracted decision: index raw_content (relevant but LLM missed)
  // Non-candidate events: skip Qdrant (not semantically meaningful for decision queries)
  if (result.decisions.length === 0 && !result.decision_candidate) return;

  const rawFallback = (result.raw_content?.trim() || result.source_url).slice(0, CHUNK_MAX_CHARS);
  const textToChunk = result.decisions.length > 0
    ? result.decisions
        .map((d: Decision) => [d.quoted_text, d.summary, d.rationale].filter(Boolean).join("\n"))
        .join("\n\n")
    : rawFallback;

  const allChunks = chunkContent(textToChunk, result.event_id);
  if (allChunks.length === 0) allChunks.push({ id: `${result.event_id}_0`, text: result.source_url });

  if (allChunks.length === 0) return;

  const vectors = await embedBatch(allChunks.map((c) => c.text));

  const points = allChunks.map((chunk, i) => ({
    id: uuidv4(),
    vector: vectors[i],
    payload: {
      chunk_id: chunk.id,
      graph_node_id: result.event_id,
      project_id: result.project_id,
      source_url: result.source_url,
      actor_id: result.actor.id,
      actor_name: result.actor.name,
      timestamp: result.timestamp,
      content: chunk.text,
      has_decisions: result.decisions.length > 0,
      decision_count: result.decisions.length,
    },
  }));

  await qdrant.upsert(COLLECTION, { points });

  console.log(`[brain-writer] qdrant: ${points.length} chunk(s) indexed for ${result.event_id}`);
}

async function processMessage(id: string, result: ExtractionResult) {
  await writeToNeo4j(result);
  await writeToQdrant(result);
  await redis.xack(STREAMS.EXTRACTED, GROUP, id);
  console.log(`[brain-writer] done: ${result.event_id}`);
}

async function drainPending() {
  console.log("[brain-writer] checking for pending messages...");
  let recovered = 0;

  while (true) {
    const results = await redis.xreadgroup(
      "GROUP",
      GROUP,
      CONSUMER,
      "COUNT",
      10,
      "STREAMS",
      STREAMS.EXTRACTED,
      "0" // "0" delivers already-claimed pending messages, not new ones
    );

    if (!results) break;
    const messages = (results as [string, [string, string[]][]][])[0]?.[1];
    if (!messages || messages.length === 0) break;

    for (const [id, fields] of messages) {
      const resultJson = fields[fields.indexOf("result") + 1];
      if (!resultJson) {
        await redis.xack(STREAMS.EXTRACTED, GROUP, id);
        continue;
      }
      try {
        const result = JSON.parse(resultJson) as ExtractionResult;
        await processMessage(id, result);
        recovered++;
      } catch (e) {
        console.error(`[brain-writer] pending retry failed for ${id}:`, e);
        // ACK to prevent infinite retry loop — event goes to dead-letter inspection
        await redis.xack(STREAMS.EXTRACTED, GROUP, id);
      }
    }
  }

  if (recovered > 0) {
    console.log(`[brain-writer] recovered ${recovered} pending messages`);
  }
}

async function run() {
  await ensureCollection();
  await ensureGroup();
  await drainPending();
  console.log("[brain-writer] started, reading from", STREAMS.EXTRACTED);

  while (true) {
    const results = await redis.xreadgroup(
      "GROUP",
      GROUP,
      CONSUMER,
      "COUNT",
      10,
      "BLOCK",
      BLOCK_MS,
      "STREAMS",
      STREAMS.EXTRACTED,
      ">"
    );

    if (!results) continue;

    for (const [, messages] of results as [string, [string, string[]][]][]) {
      for (const [id, fields] of messages) {
        const resultJson = fields[fields.indexOf("result") + 1];
        if (!resultJson) continue;
        try {
          const result = JSON.parse(resultJson) as ExtractionResult;
          await processMessage(id, result);
        } catch (e) {
          console.error(`[brain-writer] failed to process ${id}:`, e);
        }
      }
    }
  }
}

run().catch((e) => {
  console.error("[brain-writer] fatal:", e);
  process.exit(1);
});
