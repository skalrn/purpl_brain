import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { webhookRoutes } from "./routes/webhooks.js";
import { queryRoutes } from "./routes/query.js";
import { projectRoutes } from "./routes/projects.js";
import { brainRoutes } from "./routes/brain.js";

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });

await app.register(webhookRoutes, { prefix: "/webhooks" });
await app.register(queryRoutes, { prefix: "/brain" });
await app.register(projectRoutes, { prefix: "/brain" });
await app.register(brainRoutes);

app.get("/health", async () => ({ status: "ok", ts: new Date().toISOString() }));

const port = Number(process.env.PORT ?? 3001);
await app.listen({ port, host: "0.0.0.0" });
