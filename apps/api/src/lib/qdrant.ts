import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";

export const qdrant = new QdrantClient({ url: QDRANT_URL });

export const COLLECTION = "brain_chunks";

export async function ensureCollection() {
  const collections = await qdrant.getCollections();
  const exists = collections.collections.some((c: { name: string }) => c.name === COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: 768, distance: "Cosine" }, // nomic-embed-text dimension
    });
  }
}
