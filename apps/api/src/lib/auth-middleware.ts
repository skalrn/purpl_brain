import type { FastifyRequest, FastifyReply } from "fastify";
import { getPersonByApiKey } from "./neo4j.js";

/**
 * Fastify preHandler that validates X-API-Key (or Bearer token) against
 * the Person.api_key field in Neo4j. Returns 401 if missing or invalid.
 *
 * Apply to any route that writes to the brain:
 *   fastify.post("/route", { preHandler: requireApiKey }, handler)
 */
// DEV_API_KEY bypasses Neo4j lookup — set in .env for local dev only
const DEV_API_KEY = process.env.DEV_API_KEY;

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.headers["x-api-key"] ??
    (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "");

  if (!raw) {
    return reply.status(401).send({ error: "API key required — set X-API-Key header" });
  }

  if (DEV_API_KEY && raw === DEV_API_KEY) return;

  const person = await getPersonByApiKey(raw as string);
  if (!person) {
    return reply.status(401).send({ error: "Invalid API key" });
  }
}
