import Anthropic from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const MODELS = {
  EXTRACTION: "claude-haiku-4-5",
  QUERY: "claude-sonnet-4-6",
} as const;
