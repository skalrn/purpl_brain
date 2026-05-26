import "dotenv/config";
import { validateEnv } from "./lib/config.js";
validateEnv();
import { createHash } from "crypto";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import { webhookRoutes } from "./routes/webhooks.js";
import { queryRoutes } from "./routes/query.js";
import { projectRoutes } from "./routes/projects.js";
import { brainRoutes } from "./routes/brain.js";
import { authRoutes } from "./routes/auth.js";
import { ingestRoutes } from "./routes/ingest.js";
import { identityRoutes } from "./routes/identity.js";
import { checkEmbeddingModel } from "./lib/qdrant.js";
import { currentEmbeddingModel } from "./lib/embed.js";
import { ensureBotPerson } from "./lib/neo4j.js";

// DEV_API_KEY bypasses all project membership checks — must never be set in
// production. Fail fast rather than silently running without tenant isolation.
if (process.env.DEV_API_KEY && process.env.NODE_ENV === "production") {
  console.error("FATAL: DEV_API_KEY must not be set in production — it bypasses all project access controls.");
  process.exit(1);
}

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: (origin, cb) => {
    const allowed = process.env.UI_BASE_URL ?? "http://localhost:3000";
    // In dev, allow any localhost port so the Next.js dev server can run on any available port.
    if (!origin || origin === allowed || (process.env.NODE_ENV !== "production" && /^http:\/\/localhost:\d+$/.test(origin))) {
      cb(null, true);
    } else {
      cb(new Error("CORS: origin not allowed"), false);
    }
  },
  credentials: true,
});

// Global rate limit — keyed by API key when present, otherwise by IP.
// Protects LLM-backed routes from runaway spend on a compromised key.
await app.register(rateLimit, {
  global: true,
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "60"),
  timeWindow: "1 minute",
  keyGenerator: (req) => {
    // Hash the raw key so the plaintext never lands in Redis — a Redis dump
    // or logs can't be used to replay API requests with a leaked key.
    const apiKey = req.headers["x-api-key"] as string | undefined;
    if (apiKey) return `key:${createHash("sha256").update(apiKey).digest("hex").slice(0, 32)}`;
    const auth = req.headers["authorization"] as string | undefined;
    if (auth?.startsWith("Bearer ")) return `key:${createHash("sha256").update(auth.slice(7)).digest("hex").slice(0, 32)}`;
    return req.ip;
  },
  errorResponseBuilder: (_req, context) => {
    const err = new Error(`Rate limit exceeded — max ${context.max} requests per minute`) as Error & { statusCode: number; retry_after_ms?: number };
    err.statusCode = context.ban ? 403 : 429;
    err.retry_after_ms = context.ttl;
    return err;
  },
});
await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: process.env.SESSION_SECRET ?? "purpl-brain-dev-secret-change-in-production",
  cookie: {
    // Secure by default — opt out with SESSION_COOKIE_SECURE=false only in
    // local dev (http://localhost). Never disable in production.
    secure: process.env.SESSION_COOKIE_SECURE !== "false",
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

// Fail fast if the configured embedding model doesn't match the one used to
// build the existing Qdrant collection. Mismatched models produce silent garbage
// retrieval — surfacing it here is far better than invisible quality regression.
const embeddingModel = currentEmbeddingModel();
const { ok: embeddingOk, stored: storedModel } = await checkEmbeddingModel(embeddingModel);
if (!embeddingOk) {
  console.error("");
  console.error("FATAL: embedding model mismatch — cannot start query layer safely.");
  console.error(`  Collection was built with: ${storedModel}`);
  console.error(`  Currently configured:      ${embeddingModel}`);
  console.error("");
  console.error("  Existing vectors are incompatible with the new model.");
  console.error("  Re-embed the collection before restarting:");
  console.error("    npx tsx src/scripts/reset-pipeline.ts --project <project_id>");
  console.error("");
  process.exit(1);
}

await app.register(authRoutes);
await app.register(webhookRoutes, { prefix: "/webhooks" });
await app.register(queryRoutes, { prefix: "/brain" });
await app.register(projectRoutes, { prefix: "/brain" });
await app.register(brainRoutes);
await app.register(ingestRoutes);
await app.register(identityRoutes);

app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

// SEC-M7: Auto-register BRAIN_API_KEY as a Bot Person on first boot so MCP
// deployments work without DEV_API_KEY. MERGE is idempotent — safe to run every
// restart. agentId from MCP_AGENT_ID env, falling back to a generic label.
if (process.env.BRAIN_API_KEY) {
  const agentId = process.env.MCP_AGENT_ID ?? "brain-api-bot";
  try {
    await ensureBotPerson(process.env.BRAIN_API_KEY, agentId);
    app.log.info({ agentId }, "Bot Person ensured for BRAIN_API_KEY");
  } catch (e) {
    app.log.warn({ err: (e as Error).message }, "Failed to register BRAIN_API_KEY as Bot Person — check Neo4j connectivity");
  }
}

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
