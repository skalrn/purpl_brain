import "dotenv/config";
import { validateEnv } from "./lib/config.js";
validateEnv();
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import { webhookRoutes } from "./routes/webhooks.js";
import { queryRoutes } from "./routes/query.js";
import { projectRoutes } from "./routes/projects.js";
import { brainRoutes } from "./routes/brain.js";
import { authRoutes } from "./routes/auth.js";
import { ingestRoutes } from "./routes/ingest.js";

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: process.env.UI_BASE_URL ?? "http://localhost:3000",
  credentials: true,
});
await app.register(fastifyCookie);
await app.register(fastifySession, {
  secret: process.env.SESSION_SECRET ?? "purpl-brain-dev-secret-change-in-production",
  cookie: {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

await app.register(authRoutes);
await app.register(webhookRoutes, { prefix: "/webhooks" });
await app.register(queryRoutes, { prefix: "/brain" });
await app.register(projectRoutes, { prefix: "/brain" });
await app.register(brainRoutes);
await app.register(ingestRoutes);

app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
