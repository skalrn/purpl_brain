import OpenAI from "openai";

const ollamaClient = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: "ollama",
});

const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text:v1.5";

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
