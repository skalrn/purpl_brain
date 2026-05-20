import type { FastifyPluginAsync } from "fastify";
import type { Project } from "@purpl/types";
import { listProjects, listProjectsForActor } from "../lib/neo4j.js";
import { requireApiKey } from "../lib/auth-middleware.js";

export const projectRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /projects ──────────────────────────────────────────────────────────
  // List projects the caller is a member of, with health stats.
  // For dev_bypass (no actor), falls back to the unscoped list — local dev only.
  // Authenticated callers always see only their own projects.
  app.get<{ Querystring: { since?: string } }>(
    "/projects",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { since } = req.query;
      if (since && isNaN(Date.parse(since))) {
        return reply.status(400).send({ error: "since must be a valid ISO 8601 timestamp" });
      }
      try {
        const personId = req.actor?.person_id;
        const projects = personId
          ? await listProjectsForActor(personId, since)
          : await listProjects(since); // dev_bypass path only
        return { projects, total: projects.length, since: since ?? null };
      } catch (e) {
        app.log.error(e);
        return reply.status(500).send({ error: "Failed to list projects" });
      }
    }
  );

  // POST /projects — project registration (Phase 3 M5, not yet implemented)
  app.post<{ Body: Omit<Project, "project_id" | "created_at"> }>("/projects", async (_request, reply) => {
    return reply.code(501).send({ error: "Project registration not yet implemented" });
  });
};
