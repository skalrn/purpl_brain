import type { FastifyRequest, FastifyReply } from "fastify";
import type { PersonRecord } from "./neo4j.js";
import { getPersonByApiKey, checkPersonInProject } from "./neo4j.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: PersonRecord;
  }
}

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
  req.actor = person;
}

export async function requireProjectMember(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const person_id = req.actor?.person_id;
  if (!person_id) return; // DEV_API_KEY path — skip project check

  const project_id =
    (req.body as Record<string, unknown> | undefined)?.project_id as string | undefined ??
    (req.query as Record<string, unknown> | undefined)?.project_id as string | undefined ??
    (req.params as Record<string, unknown> | undefined)?.project_id as string | undefined;

  if (!project_id) return; // no project scope in request — let handler validate

  const isMember = await checkPersonInProject(person_id, project_id);
  if (!isMember) {
    return reply.status(403).send({ error: "Access denied to project" });
  }
}
