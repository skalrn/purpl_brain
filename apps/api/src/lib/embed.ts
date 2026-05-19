import OpenAI from "openai";
import { PROVIDER } from "./llm.js";

// Anthropic path: OpenAI text-embedding-3-small with dimension reduction to 768
// so the Qdrant collection stays compatible between providers.
const openaiClient = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? "",
});

const ollamaClient = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: "ollama",
});

const VECTOR_SIZE = parseInt(process.env.QDRANT_VECTOR_SIZE ?? "768");

const OPENAI_EMBED_MODEL = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text:v1.5";

/** Returns the embedding model name that will be used for all embed() calls. */
export function currentEmbeddingModel(): string {
  return PROVIDER === "anthropic" ? OPENAI_EMBED_MODEL : OLLAMA_EMBED_MODEL;
}

export async function embed(text: string): Promise<number[]> {
  if (PROVIDER === "anthropic") {
    const response = await openaiClient.embeddings.create({
      model: OPENAI_EMBED_MODEL,
      input: text,
      dimensions: VECTOR_SIZE,
    });
    return response.data[0].embedding;
  }

  const response = await ollamaClient.embeddings.create({
    model: OLLAMA_EMBED_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (PROVIDER === "anthropic") {
    const response = await openaiClient.embeddings.create({
      model: OPENAI_EMBED_MODEL,
      input: texts,
      dimensions: VECTOR_SIZE,
    });
    return response.data.map((d) => d.embedding);
  }

  const response = await ollamaClient.embeddings.create({
    model: OLLAMA_EMBED_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}
