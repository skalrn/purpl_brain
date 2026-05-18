import "dotenv/config";
import { Redis } from "ioredis";
import { v4 as uuidv4 } from "uuid";
import { STREAMS } from "../lib/redis.js";
import { StreamWorker } from "../lib/stream-worker.js";
import { driver, getSession, resolveOrCreateActorPerson } from "../lib/neo4j.js";
import { qdrant, COLLECTION, ensureCollection } from "../lib/qdrant.js";
import { embed, embedBatch } from "../lib/embed.js";
import { inferSourceFromEventId } from "../lib/event-source.js";
import type { ExtractionResult, Decision } from "@purpl/types";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

const CHUNK_MAX_CHARS = 1600; // ~400 tokens at 4 chars/token

// Qdrant retry queue uses a two-key pattern (requires Redis 6.2+ for LMOVE):
//   RETRY_KEY      — waiting to be retried
//   PROCESSING_KEY — currently being processed (crash-safe: items here are moved
//                    back to RETRY_KEY on the next startup)
const QDRANT_RETRY_KEY = "retry:qdrant_writes";
const QDRANT_PROCESSING_KEY = "retry:qdrant_processing";
const QDRANT_RETRY_MAX = 3;

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

async function writeToNeo4j(result: ExtractionResult): Promise<string> {
  const source = inferSourceFromEventId(result.event_id);

  const personId = await resolveOrCreateActorPerson({
    actor_id: result.actor.id,
    actor_name: result.actor.name,
    actor_type: result.actor.type,
    source,
  });

  const session = getSession();
  try {
    await session.run(
      `MERGE (e:Event {event_id: $event_id})
       SET e.source = $source,
           e.event_type = $event_type,
           e.project_id = $project_id,
           e.timestamp = $timestamp,
           e.url = $url,
           e.raw_content = $raw_content,
           e.actor_person_id = $person_id
       WITH e
       MATCH (p:Person {person_id: $person_id})
       MERGE (e)-[:AUTHORED_BY]->(p)`,
      {
        event_id: result.event_id,
        source,
        event_type: "ingested",
        project_id: result.project_id,
        timestamp: result.timestamp,
        url: result.source_url,
        raw_content: result.raw_content,
        person_id: personId,
      }
    );

    for (const ref of result.ticket_refs) {
      await session.run(
        `MERGE (t:Ticket {ref: $ref})
         WITH t
         MATCH (e:Event {event_id: $event_id})
         MERGE (e)-[:REFERENCES]->(t)`,
        { ref, event_id: result.event_id }
      );
    }

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
           codegen_prompt: $codegen_prompt,
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
          codegen_prompt: decision.codegen_prompt ?? null,
          valid_from: result.timestamp,
        }
      );
    }

    if (result.decisions.length > 0 && result.ticket_refs.length > 0) {
      await session.run(
        `MATCH (d:Decision)-[:EXTRACTED_FROM]->(e:Event {event_id: $event_id})
         MATCH (e)-[:REFERENCES]->(t:Ticket)
         MERGE (d)-[:INFORMS]->(t)`,
        { event_id: result.event_id }
      );
    }

    console.log(
      `[brain-writer] neo4j: event=${result.event_id} person=${personId} decisions=${result.decisions.length} tickets=${result.ticket_refs.length}`
    );
    return personId;
  } finally {
    await session.close();
  }
}

async function writeToQdrant(result: ExtractionResult, actorPersonId: string) {
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
  const source = inferSourceFromEventId(result.event_id);

  const points = allChunks.map((chunk, i) => ({
    id: uuidv4(),
    vector: vectors[i],
    payload: {
      chunk_id: chunk.id,
      source_id: result.source_id,
      graph_node_id: result.event_id,
      project_id: result.project_id,
      source,
      source_url: result.source_url,
      actor_id: result.actor.id,
      actor_name: result.actor.name,
      actor_person_id: actorPersonId,
      timestamp: result.timestamp,
      content: chunk.text,
      has_decisions: result.decisions.length > 0,
      decision_count: result.decisions.length,
    },
  }));

  await qdrant.upsert(COLLECTION, { points });
  console.log(`[brain-writer] qdrant: ${points.length} chunk(s) indexed for ${result.event_id}`);
}

// ── Qdrant retry queue (crash-safe two-list pattern, requires Redis 6.2+) ────

async function enqueueQdrantRetry(result: ExtractionResult, personId: string, attempt: number): Promise<void> {
  await redis.lpush(QDRANT_RETRY_KEY, JSON.stringify({ result, personId, attempt, failed_at: new Date().toISOString() }));
}

async function drainQdrantRetries(): Promise<void> {
  // Crash recovery: items in PROCESSING were being worked on when the last crash
  // happened. Move them back to the retry queue so they get another attempt.
  while (true) {
    const stuck = await redis.lmove(QDRANT_PROCESSING_KEY, QDRANT_RETRY_KEY, "LEFT", "RIGHT");
    if (!stuck) break;
    console.log("[brain-writer] crash-recovery: moved stuck retry item back to queue");
  }

  const count = await redis.llen(QDRANT_RETRY_KEY);
  if (count === 0) return;
  console.log(`[brain-writer] retrying ${count} failed Qdrant write(s)...`);

  for (let i = 0; i < count; i++) {
    // Atomically move to processing list before touching — survives a mid-retry crash
    const raw = await redis.lmove(QDRANT_RETRY_KEY, QDRANT_PROCESSING_KEY, "RIGHT", "LEFT");
    if (!raw) break;

    let parsed: { result: ExtractionResult; personId: string; attempt: number };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
      await writeToQdrant(parsed.result, parsed.personId);
      // Success — remove from processing list
      await redis.lrem(QDRANT_PROCESSING_KEY, 1, raw);
      console.log(`[brain-writer] qdrant retry succeeded: ${parsed.result.event_id}`);
    } catch (e) {
      parsed = JSON.parse(raw) as typeof parsed;
      // Remove from processing list regardless — either re-queue or discard
      await redis.lrem(QDRANT_PROCESSING_KEY, 1, raw);
      if (parsed.attempt < QDRANT_RETRY_MAX) {
        await enqueueQdrantRetry(parsed.result, parsed.personId, parsed.attempt + 1);
        console.warn(`[brain-writer] qdrant retry ${parsed.attempt + 1}/${QDRANT_RETRY_MAX} queued: ${parsed.result.event_id}`);
      } else {
        console.error(`[brain-writer] qdrant write permanently failed after ${QDRANT_RETRY_MAX} attempts: ${parsed.result.event_id}`, e);
      }
    }
  }
}

class BrainWriter extends StreamWorker {
  constructor() {
    super(redis, {
      name: "brain-writer",
      stream: STREAMS.EXTRACTED,
      group: "brain-writer",
      consumer: "brain-writer-1",
      fieldName: "result",
    });
  }

  protected async processMessage(id: string, value: string): Promise<void> {
    const result = JSON.parse(value) as ExtractionResult;
    const personId = await writeToNeo4j(result);
    try {
      await writeToQdrant(result, personId);
    } catch (e) {
      console.error(`[brain-writer] qdrant write failed for ${result.event_id}, queuing retry:`, e);
      await enqueueQdrantRetry(result, personId, 1);
    }
    await redis.xack(STREAMS.EXTRACTED, "brain-writer", id);
    console.log(`[brain-writer] done: ${result.event_id}`);
  }

  protected override async onShutdown(): Promise<void> {
    await driver.close().catch(() => undefined);
  }

  override async run(): Promise<void> {
    await ensureCollection();
    await drainQdrantRetries();
    await super.run();
  }
}

new BrainWriter().run().catch((e) => {
  console.error("[brain-writer] fatal:", e);
  process.exit(1);
});
