/**
 * Seed a synthetic VTT meeting transcript containing real architectural decisions.
 * Usage: npm run seed:transcript -w apps/api -- [--project <id>] [--force]
 */
import "dotenv/config";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    project: { type: "string", default: "purpl_brain" },
    force: { type: "boolean", default: false },
  },
  strict: false,
});

const PROJECT_ID = args.project as string;
const API_BASE = process.env.API_BASE ?? "http://localhost:3001";

// Synthetic VTT transcript of an architecture decision meeting
const MEETING_VTT = `WEBVTT

00:00:05.000 --> 00:00:15.000
Alice: Okay everyone, let's align on the caching strategy for the query layer before we start implementing.

00:00:15.500 --> 00:00:30.000
Alice: We've been debating Redis versus Memcached for weeks. I want to make a decision today.

00:00:31.000 --> 00:00:50.000
Bob: My vote is Redis. We already use it for Redis Streams in our ingestion pipeline, so adding another dependency just for caching doesn't make sense. Operational cost matters.

00:00:51.000 --> 00:01:10.000
Carol: I agree with Bob. Redis gives us persistence, pub/sub, and sorted sets if we ever need TTL-based cache invalidation. Memcached is faster for pure string caching but we'd lose all those features.

00:01:11.000 --> 00:01:30.000
Alice: What about the memory overhead? Redis keeps everything in RAM too.

00:01:31.000 --> 00:01:50.000
Bob: At our scale it's not a concern. We're caching query embeddings and LLM responses, not raw event data. The cache entries are small.

00:01:51.000 --> 00:02:10.000
Dave: We should set a max memory policy. I recommend allkeys-lru with a 512MB cap to start. We can increase it as we understand usage patterns.

00:02:11.000 --> 00:02:30.000
Alice: Agreed. Decision made: we use Redis for query result caching with allkeys-lru eviction and 512MB initial cap. No Memcached.

00:02:31.000 --> 00:02:50.000
Carol: The next question is cache key design. Do we cache by query string hash, or by the embedding vector?

00:02:51.000 --> 00:03:10.000
Bob: Cache by query string hash — SHA-256 of the normalized query. Embedding vectors are expensive to compare as cache keys. Normalize by lowercasing and stripping punctuation before hashing.

00:03:11.000 --> 00:03:30.000
Dave: TTL should be 15 minutes for query results. Stale answers after a few minutes are acceptable given our ingestion latency anyway.

00:03:31.000 --> 00:03:50.000
Alice: Perfect. So: Redis, SHA-256 key on normalized query string, 15 minute TTL, 512MB cap, allkeys-lru. That's the caching decision locked.

00:03:51.000 --> 00:04:10.000
Carol: One more thing — do we cache the embedding vectors themselves? Generating embeddings costs money if we're on OpenAI.

00:04:11.000 --> 00:04:30.000
Bob: Yes. Cache embeddings by query text, 1 hour TTL. Embeddings are deterministic so there's no staleness risk. This is the biggest cost saving.

00:04:31.000 --> 00:04:50.000
Alice: Embedding cache: 1 hour TTL, Redis, same SHA-256 key scheme. Approved. Let's move to the next topic.
`;

async function main() {
  const title = "Architecture Decision: Query Layer Caching Strategy";
  const occurredAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(); // 2 days ago

  if (args.force) {
    console.log("--force: skipping dedup check (new sourceId per run)");
  }

  console.log(`Seeding meeting transcript to project '${PROJECT_ID}'...`);

  const res = await fetch(`${API_BASE}/brain/ingest/transcript`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: MEETING_VTT,
      title,
      occurred_at: occurredAt,
      project_id: PROJECT_ID,
      source_url: `brain://meeting/seed/${Date.now()}`,
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    console.error("FAILED:", res.status, body);
    process.exit(1);
  }

  console.log("OK:", body);
  console.log(`Format detected: ${body.format}`);
  console.log(`Speakers found: ${body.speakers?.join(", ")}`);
  console.log(`Chunks queued: ${body.chunks_queued}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
