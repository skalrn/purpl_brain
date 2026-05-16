import type { FastifyPluginAsync } from "fastify";
import type { QueryRequest, QueryResponse } from "@purpl/types";

// Placeholder — implemented in Milestone 4
export const queryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: QueryRequest }>("/query", async (request, reply) => {
    return reply.code(501).send({ error: "Query layer not yet implemented" });
  });
};
