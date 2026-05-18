import type { FastifyPluginAsync } from "fastify";
import type { QueryRequest } from "@purpl/types";
import { runQuery, runQueryStream } from "../services/query-engine.js";
import { runTemporalQuery } from "../services/temporal-engine.js";
import { analyzeImpact } from "../services/impact-engine.js";
import { requireApiKey } from "../lib/auth-middleware.js";

export const queryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: QueryRequest & { change_description?: string } }>(
    "/query",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { query, project_id, mode, time_range, change_description } = request.body;

      if (!project_id) {
        return reply.code(400).send({ error: "project_id is required" } as never);
      }

      if (mode === "impact") {
        const changeDesc = change_description ?? query;
        if (!changeDesc) {
          return reply.code(400).send({ error: "query or change_description is required for impact mode" } as never);
        }
        const result = await analyzeImpact(changeDesc, project_id);
        return reply.code(200).send(result);
      }

      if (!query) {
        return reply.code(400).send({ error: "query is required" } as never);
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
    }
  );

  // ── POST /brain/query/stream — SSE streaming for project queries ──────────
  app.post<{ Body: { query: string; project_id: string } }>(
    "/query/stream",
    { preHandler: requireApiKey },
    async (request, reply) => {
      const { query, project_id } = request.body;

      if (!query || !project_id) {
        return reply.code(400).send({ error: "query and project_id are required" } as never);
      }

      reply.hijack();
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      const write = (data: object) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        for await (const event of runQueryStream({ query, project_id, mode: "project" })) {
          write(event);
        }
      } catch (e) {
        write({ type: "error", message: String(e) });
      } finally {
        reply.raw.end();
      }
    }
  );
};
