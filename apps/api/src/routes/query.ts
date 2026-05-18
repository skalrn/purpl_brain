import type { FastifyPluginAsync } from "fastify";
import type { QueryRequest } from "@purpl/types";
import { runQuery } from "../services/query-engine.js";
import { runTemporalQuery } from "../services/temporal-engine.js";
import { requireApiKey } from "../lib/auth-middleware.js";

export const queryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: QueryRequest }>("/query", { preHandler: requireApiKey }, async (request, reply) => {
    const { query, project_id, mode, time_range } = request.body;

    if (!query || !project_id) {
      return reply.code(400).send({ error: "query and project_id are required" } as never);
    }

    if (mode === "temporal") {
      const range = time_range ?? {
        from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        to: new Date().toISOString(),
      };

      const result = await runTemporalQuery(project_id, range, query);
      return reply.code(200).send(result);
    }

    const result = await runQuery({ query, project_id, mode: mode ?? "project" });
    return reply.code(200).send(result);
  });
};
