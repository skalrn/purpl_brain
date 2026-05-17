/**
 * Resets the processing pipeline so all events in events:raw are
 * re-processed by the normalizer → extractor → brain-writer chain
 * without hitting GitHub or any external API.
 *
 * Use this after changing:
 *   - Decision marker phrases in normalizer.ts
 *   - The extractor LLM prompt
 *   - Brain-writer graph/vector logic
 *
 * What it does:
 *   1. Trims events:normalized and events:extracted to empty
 *   2. Resets the normalizer consumer group offset to 0 (start of events:raw)
 *   3. Clears Neo4j nodes and Qdrant points for the target project
 *   4. Clears extractor + brain-writer consumer groups so they start fresh
 *
 * After running: restart all three workers. They will replay the full
 * events:raw stream with the current code.
 *
 * Usage:
 *   tsx src/scripts/reset-pipeline.ts [--project encode_httpx]
 */

import "dotenv/config";
import { Redis } from "ioredis";
import neo4j from "neo4j-driver";
import { QdrantClient } from "@qdrant/js-client-rest";

const REDIS_URL   = process.env.REDIS_URL    ?? "redis://localhost:6379";
const NEO4J_URL   = process.env.NEO4J_URI    ?? "bolt://localhost:7687";
const NEO4J_USER  = process.env.NEO4J_USER   ?? "neo4j";
const NEO4J_PASS  = process.env.NEO4J_PASSWORD ?? process.env.NEO4J_PASS ?? "password";
const QDRANT_URL  = process.env.QDRANT_URL   ?? "http://localhost:6333";
const COLLECTION  = process.env.QDRANT_COLLECTION ?? "brain_chunks";

const STREAMS = {
  RAW:        "events:raw",
  NORMALIZED: "events:normalized",
  EXTRACTED:  "events:extracted",
} as const;

const CONSUMER_GROUPS = {
  NORMALIZER:   { stream: STREAMS.RAW,        group: "normalizer" },
  EXTRACTOR:    { stream: STREAMS.NORMALIZED,  group: "extractor" },
  BRAIN_WRITER: { stream: STREAMS.EXTRACTED,   group: "brain-writer" },
} as const;

async function run() {
  const args = process.argv.slice(2);
  const projectIdx = args.indexOf("--project");
  const projectId  = projectIdx !== -1 ? args[projectIdx + 1] : "encode_httpx";

  console.log(`[reset] target project: ${projectId}`);
  console.log("[reset] this will erase all processed data for the project and replay from events:raw\n");

  const redis  = new Redis(REDIS_URL);
  const driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASS));
  const qdrant = new QdrantClient({ url: QDRANT_URL });

  // 1. Trim downstream streams to empty
  console.log("[reset] trimming events:normalized and events:extracted...");
  await redis.xtrim(STREAMS.NORMALIZED, "MAXLEN", 0);
  await redis.xtrim(STREAMS.EXTRACTED,  "MAXLEN", 0);
  console.log("         done");

  // 2. Reset normalizer group to start of events:raw
  //    SETID to 0-0 means "deliver all messages from the beginning"
  console.log("[reset] resetting normalizer consumer group to start of events:raw...");
  try {
    await redis.xgroup("SETID", STREAMS.RAW, CONSUMER_GROUPS.NORMALIZER.group, "0-0");
    console.log("         done");
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("NOGROUP")) {
      // Group doesn't exist yet — create it at position 0
      await redis.xgroup("CREATE", STREAMS.RAW, CONSUMER_GROUPS.NORMALIZER.group, "0", "MKSTREAM");
      console.log("         group created at 0");
    } else {
      throw e;
    }
  }

  // 3. Delete extractor and brain-writer groups so they start fresh on the new streams
  console.log("[reset] deleting extractor and brain-writer consumer groups...");
  for (const { stream, group } of [CONSUMER_GROUPS.EXTRACTOR, CONSUMER_GROUPS.BRAIN_WRITER]) {
    try {
      await redis.xgroup("DESTROY", stream, group);
      console.log(`         destroyed ${group} on ${stream}`);
    } catch {
      // Group may not exist — fine
    }
  }

  // 4. Clear Neo4j nodes for the project
  console.log(`[reset] deleting Neo4j nodes for project ${projectId}...`);
  const session = driver.session();
  try {
    const result = await session.run(
      `MATCH (n) WHERE n.project_id = $projectId DETACH DELETE n RETURN count(n) AS deleted`,
      { projectId }
    );
    const deleted = result.records[0]?.get("deleted")?.toNumber() ?? 0;
    console.log(`         deleted ${deleted} nodes`);
  } finally {
    await session.close();
  }

  // 5. Delete Qdrant points for the project
  console.log(`[reset] deleting Qdrant points for project ${projectId}...`);
  try {
    await qdrant.delete(COLLECTION, {
      filter: { must: [{ key: "project_id", match: { value: projectId } }] },
    });
    console.log("         done");
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Not found")) {
      console.log("         collection not found — skipping");
    } else {
      throw e;
    }
  }

  await redis.quit();
  await driver.close();

  console.log(`
[reset] complete. Now restart the workers:

  npm run worker:normalizer   # re-normalizes all events:raw with new markers
  npm run worker:extractor    # re-extracts decisions with current prompt
  npm run worker:brain-writer # re-writes graph + vectors

Then run the eval:

  npm run eval:extraction
`);
}

run().catch((e) => {
  console.error("[reset] fatal:", e);
  process.exit(1);
});
