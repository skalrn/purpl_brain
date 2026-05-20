import type { FastifyRequest, FastifyReply } from "fastify";
import type { PersonRecord } from "./neo4j.js";
import { getPersonByApiKey, checkPersonInProject } from "./neo4j.js";

declare module "fastify" {
  interface FastifyRequest {
    actor?: PersonRecord;
    dev_bypass?: boolean; // true only on the DEV_API_KEY path — explicit signal, not inferred from actor==null
  }
}

// DEV_API_KEY bypasses Neo4j lookup — set in .env for local dev only.
// Guarded by NODE_ENV === "development" (deny-by-default) so an unset or
// unexpected NODE_ENV never silently disables access controls.
const DEV_API_KEY = process.env.DEV_API_KEY;

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const raw = req.headers["x-api-key"] ??
    (req.headers["authorization"] as string | undefined)?.replace(/^Bearer\s+/i, "");

  if (!raw) {
    return reply.status(401).send({ error: "API key required — set X-API-Key header" });
  }

  if (DEV_API_KEY && raw === DEV_API_KEY && process.env.NODE_ENV === "development") {
    req.dev_bypass = true;
    return;
  }

  const person = await getPersonByApiKey(raw as string);
  if (!person) {
    return reply.status(401).send({ error: "Invalid API key" });
  }
  req.actor = person;
}

export async function requireProjectMember(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (req.dev_bypass) return; // local dev only — project checks skipped

  const person_id = req.actor?.person_id;
  if (!person_id) return; // should not happen outside dev_bypass, but safe fallback

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

/**
 * In-handler membership check for routes where project_id is not in the URL
 * (e.g. /brain/drift-alerts/:id/resolve, /brain/agent-sessions/:event_id).
 * Returns true if the check passes or is bypassed (dev mode, no actor).
 * Returns false and sends a 404 response if the check fails — callers must
 * return immediately when this returns false.
 *
 * We return 404 (not 403) when the project doesn't match so that the existence
 * of the resource is not disclosed to unauthorised callers.
 */
export async function assertProjectMember(
  req: FastifyRequest,
  reply: FastifyReply,
  projectId: string | null,
  resourceLabel: string = "Resource",
): Promise<boolean> {
  if (req.dev_bypass) return true;

  const person_id = req.actor?.person_id;
  if (!person_id) return true; // safe fallback — should not reach here outside dev

  if (!projectId) {
    await reply.status(404).send({ error: `${resourceLabel} not found` });
    return false;
  }

  const isMember = await checkPersonInProject(person_id, projectId);
  if (!isMember) {
    // Return 404, not 403 — do not disclose that the resource exists
    await reply.status(404).send({ error: `${resourceLabel} not found` });
    return false;
  }

  return true;
}
