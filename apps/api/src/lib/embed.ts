import OpenAI from "openai";

// Embeddings always use Ollama (nomic-embed-text) regardless of LLM provider.
// This keeps a single embedding space across both paths so Qdrant collections
// stay compatible when switching between Anthropic and Ollama for LLM calls.
const ollamaClient = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: "ollama",
});

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text:v1.5";

/** Returns the embedding model name used for all embed() calls. */
export function currentEmbeddingModel(): string {
  return EMBED_MODEL;
}

export async function embed(text: string): Promise<number[]> {
  const response = await ollamaClient.embeddings.create({
    model: EMBED_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const response = await ollamaClient.embeddings.create({
    model: EMBED_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}
