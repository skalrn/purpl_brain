import type { FastifyPluginAsync } from "fastify";
import type { Project } from "@purpl/types";

// Placeholder — implemented in Milestone 5 (chat UI setup flow)
export const projectRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: Omit<Project, "project_id" | "created_at"> }>("/projects", async (request, reply) => {
    return reply.code(501).send({ error: "Project registration not yet implemented" });
  });
};
