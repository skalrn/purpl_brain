import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";

export const qdrant = new QdrantClient({ url: QDRANT_URL });

export const COLLECTION = process.env.QDRANT_COLLECTION ?? "brain_chunks";

// Must match the embedding model output dimension:
//   768  — nomic-embed-text:v1.5 (Ollama local)
//  1024  — amazon.titan-embed-text-v2:0 (AWS Bedrock)
const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE ?? "768");

export async function ensureCollection() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c: { name: string }) => c.name === COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: VECTOR_SIZE, distance: "Cosine" },
    });
  }
}
