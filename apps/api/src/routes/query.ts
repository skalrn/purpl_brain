import type { FastifyPluginAsync } from "fastify";
import type { QueryRequest, QueryResponse } from "@purpl/types";
import { runQuery } from "../services/query-engine.js";

export const queryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: QueryRequest; Reply: QueryResponse }>(
    "/query",
    async (request, reply) => {
      const { query, project_id, mode } = request.body;

      if (!query || !project_id) {
        return reply.code(400).send({ error: "query and project_id are required" } as never);
      }

      const result = await runQuery({ query, project_id, mode: mode ?? "project" });
      return reply.code(200).send(result);
    }
  );
};
