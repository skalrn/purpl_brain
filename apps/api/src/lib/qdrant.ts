import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";

export const qdrant = new QdrantClient({ url: QDRANT_URL });

export const COLLECTION = process.env.QDRANT_COLLECTION ?? "brain_chunks";

// Must match the embedding model output dimension:
//   768  — nomic-embed-text:v1.5 (Ollama local)
//  1024  — amazon.titan-embed-text-v2:0 (AWS Bedrock)
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE ?? "768");

/**
 * Delete all Qdrant points whose payload.source_id equals the supplied value.
 * Used before re-ingest of a document/transcript so old chunks don't linger
 * alongside new ones (stale-chunk duplication degrades retrieval quality).
 *
 * Returns the number of points reported deleted (best-effort — Qdrant's
 * filter delete is asynchronous; the response status is the surfaced signal).
 */
export async function deletePointsBySourceId(sourceId: string): Promise<void> {
  if (!sourceId) return;
  try {
    await qdrant.delete(COLLECTION, {
      filter: {
        must: [{ key: "source_id", match: { value: sourceId } }],
      },
      wait: true,
    });
  } catch (e) {
    // Collection may not exist yet on a fresh install — that is OK.
    const msg = e instanceof Error ? e.message : String(e);
    if (!msg.includes("doesn't exist") && !msg.includes("not found")) {
      throw e;
    }
  }
}

export async function ensureCollection() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c: { name: string }) => c.name === COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
  }
}
