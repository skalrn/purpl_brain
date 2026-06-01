import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

type Provider = "anthropic" | "ollama";

const PROVIDER: Provider =
  (process.env.LLM_PROVIDER as Provider | undefined) === "anthropic"
    ? "anthropic"
    : "ollama";

// Ollama exposes an OpenAI-compatible API at port 11434
const ollamaClient = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
  apiKey: "ollama", // required by SDK but ignored by Ollama
});

const anthropicClient = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MODELS = {
  // Fast model for extraction and intent parsing — override via EXTRACTION_MODEL env var
  EXTRACTION: PROVIDER === "anthropic"
    ? (process.env.EXTRACTION_MODEL ?? "claude-haiku-4-5-20251001")
    : (process.env.OLLAMA_FAST_MODEL ?? "llama3.1:8b"),
  // Full model for query answering — override via LLM_MODEL env var
  QUERY: PROVIDER === "anthropic"
    ? (process.env.LLM_MODEL ?? "claude-sonnet-4-6")
    : (process.env.OLLAMA_SMART_MODEL ?? "llama3.1:8b"),
} as const;

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
}

/**
 * Send a chat completion request. Returns the response text.
 * For Anthropic in production: system prompt caching is applied per CLAUDE.md rules.
 * For Ollama in local dev: no caching — calls are cheap and local.
 */
export async function chat(
  model: string,
  messages: Message[],
  options: LLMOptions = {}
): Promise<string> {
  const { temperature = 0, maxTokens = 1024 } = options;

  if (PROVIDER === "anthropic") {
    const system = messages.find((m) => m.role === "system")?.content;
    const userMessages = messages.filter((m) => m.role !== "system");

    const response = await anthropicClient.messages.create({
      model,
      max_tokens: maxTokens,
      // Cache control on system prompt per CLAUDE.md requirements
      system: system
        // cast required: SDK TextBlockParam types lag behind API — cache_control is valid per Anthropic docs
        ? ([{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as unknown as Anthropic.Messages.TextBlockParam[])
        : undefined,
      messages: userMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    });

    return response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("");
  }

  // Ollama via OpenAI-compatible API
  const response = await ollamaClient.chat.completions.create({
    model,
    temperature,
    max_tokens: maxTokens,
    messages,
  });

  return response.choices[0]?.message?.content ?? "";
}

/**
 * Chat completion that returns parsed JSON.
 * Instructs the model via system prompt — works with both Anthropic and Ollama.
 */
export async function chatJSON<T>(
  model: string,
  messages: Message[],
  options: LLMOptions = {}
): Promise<T> {
  const systemMsg = messages.find((m) => m.role === "system");
  const jsonInstruction = "Respond with valid JSON only. No markdown, no explanation, no code fences.";

  const augmented: Message[] = systemMsg
    ? messages.map((m) =>
        m.role === "system"
          ? { ...m, content: `${m.content}\n\n${jsonInstruction}` }
          : m
      )
    : [{ role: "system", content: jsonInstruction }, ...messages];

  const raw = await chat(model, augmented, options);

  // Strip markdown code fences if model wraps output anyway
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  return JSON.parse(cleaned) as T;
}

/**
 * Streaming chat completion — yields text tokens as they arrive.
 * Anthropic: uses messages.stream(). Ollama: uses OpenAI stream: true.
 */
export async function* chatStream(
  model: string,
  messages: Message[],
  options: LLMOptions = {}
): AsyncGenerator<string> {
  const { maxTokens = 1024 } = options;

  if (PROVIDER === "anthropic") {
    const system = messages.find((m) => m.role === "system")?.content;
    const userMessages = messages.filter((m) => m.role !== "system");

    const stream = anthropicClient.messages.stream({
      model,
      max_tokens: maxTokens,
      system: system
        ? ([{ type: "text", text: system, cache_control: { type: "ephemeral" } }] as unknown as Anthropic.Messages.TextBlockParam[])
        : undefined,
      messages: userMessages.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
    return;
  }

  // Ollama via OpenAI-compatible streaming API
  const stream = await ollamaClient.chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages,
    stream: true as const,
  });

  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content ?? "";
    if (text) yield text;
  }
}

export { PROVIDER };
