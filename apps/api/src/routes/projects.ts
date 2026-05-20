import type { FastifyPluginAsync } from "fastify";
import type { Project } from "@purpl/types";
import { listProjects } from "../lib/neo4j.js";
import { requireApiKey } from "../lib/auth-middleware.js";

export const projectRoutes: FastifyPluginAsync = async (app) => {
  // ── GET /projects ──────────────────────────────────────────────────────────
  // List all projects that have at least one ingested event, with health stats.
  // Used by the multi-project dashboard so Profile B users can see the state of
  // all their concurrent projects at a glance without specifying a project_id.
  app.get("/projects", { preHandler: requireApiKey }, async (_req, reply) => {
    try {
      const projects = await listProjects();
      return { projects, total: projects.length };
    } catch (e) {
      app.log.error(e);
      return reply.status(500).send({ error: "Failed to list projects" });
    }
  });

  // POST /projects — project registration (Phase 3 M5, not yet implemented)
  app.post<{ Body: Omit<Project, "project_id" | "created_at"> }>("/projects", async (_request, reply) => {
    return reply.code(501).send({ error: "Project registration not yet implemented" });
  });
};
