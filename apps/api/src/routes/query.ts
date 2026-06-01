import { v4 as uuidv4 } from "uuid";
import type { FastifyPluginAsync } from "fastify";
import type { QueryRequest } from "@purpl/types";
import { runQuery, runQueryStream } from "../services/query-engine.js";
import { runTemporalQuery } from "../services/temporal-engine.js";
import { analyzeImpact } from "../services/impact-engine.js";
import { parseQueryIntent } from "../lib/intent-parser.js";
import { persistPreflightCheck, writeQueryLog } from "../lib/neo4j.js";
import { requireApiKey, requireProjectMember } from "../lib/auth-middleware.js";

export const queryRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: QueryRequest & { change_description?: string; session_event_id?: string } }>(
    "/query",
    { preHandler: [requireApiKey, requireProjectMember] },
    async (request, reply) => {
      const { query, project_id, mode, time_range, change_description, session_event_id } = request.body;

      if (!project_id) {
        return reply.code(400).send({ error: "project_id is required" } as never);
      }

      // Auto-detect mode (and time_range for temporal) when caller did not
      // specify. Falls back to "project" on any classifier failure.
      let effectiveMode: typeof mode = mode;
      let effectiveTimeRange = time_range;
      if (!effectiveMode && query) {
        const parsed = await parseQueryIntent(query);
        effectiveMode = parsed.mode;
        if (!effectiveTimeRange && parsed.time_range) {
          effectiveTimeRange = parsed.time_range;
        }
      }

      if (effectiveMode === "impact") {
        const changeDesc = change_description ?? query;
        if (!changeDesc) {
          return reply.code(400).send({ error: "query or change_description is required for impact mode" } as never);
        }
        const result = await analyzeImpact(changeDesc, project_id);

        // Persist the check and link it to the agent session when session_event_id is provided.
        // Non-fatal — a failed persist does not fail the impact analysis response.
        if (session_event_id) {
          persistPreflightCheck({
            check_id: uuidv4(),
            event_id: session_event_id,
            change_description: changeDesc,
            overall_risk: result.overall_risk,
            summary: result.summary,
            affected_decision_count: result.affected_decisions.length,
            project_id,
            checked_at: new Date().toISOString(),
          }).catch((err) => app.log.warn({ err, session_event_id }, "preflight check persist failed"));
        }

        return reply.code(200).send(result);
      }

      if (!query) {
        return reply.code(400).send({ error: "query is required" } as never);
      }

      if (effectiveMode === "temporal") {
        const range = effectiveTimeRange ?? {
          from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
        };
        const result = await runTemporalQuery(project_id, range, query);
        return reply.code(200).send(result);
      }

      const result = await runQuery({ query, project_id, mode: effectiveMode ?? "project" });

      // Fire-and-forget: record that brain_query was called so getAgentSession
      // can populate brain_query_results_count on the session detail view.
      writeQueryLog({
        project_id,
        results_count: result.citations.length,
        timestamp: new Date().toISOString(),
      }).catch((err) => app.log.warn({ err }, "writeQueryLog failed"));

      return reply.code(200).send(result);
    }
  );

  // ── POST /brain/query/stream — SSE streaming for project queries ──────────
  app.post<{ Body: { query: string; project_id: string } }>(
    "/query/stream",
    { preHandler: [requireApiKey, requireProjectMember] },
    async (request, reply) => {
      const { query, project_id } = request.body;

      if (!query || !project_id) {
        return reply.code(400).send({ error: "query and project_id are required" } as never);
      }

      const requestOrigin = request.headers.origin ?? "";
      const allowedOrigins = new Set(
        (process.env.CORS_ALLOWED_ORIGINS ?? process.env.UI_BASE_URL ?? "http://localhost:3740")
          .split(",").map((o) => o.trim()).filter(Boolean)
      );
      if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
        return reply.code(403).send({ error: "Origin not allowed" });
      }

      reply.hijack();
      const origin = requestOrigin || [...allowedOrigins][0];
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Access-Control-Allow-Credentials", "true");
      reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      reply.raw.setHeader("Cache-Control", "no-cache");
      reply.raw.setHeader("Connection", "keep-alive");
      reply.raw.setHeader("X-Accel-Buffering", "no");
      reply.raw.flushHeaders();

      const write = (data: object) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        // Detect intent so a temporal/impact question on the stream endpoint
        // still gets the right engine (degraded to a single non-streaming
        // "done" frame for those modes — they don't produce token streams).
        const parsed = await parseQueryIntent(query);

        if (parsed.mode === "temporal") {
          const range = parsed.time_range ?? {
            from: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
            to: new Date().toISOString(),
          };
          const result = await runTemporalQuery(project_id, range, query);
          write({ type: "temporal", ...result });
        } else if (parsed.mode === "impact") {
          const result = await analyzeImpact(query, project_id);
          write({ type: "impact", ...result });
        } else {
          for await (const event of runQueryStream({ query, project_id, mode: "project" })) {
            write(event);
          }
        }
      } catch (e) {
        write({ type: "error", message: String(e) });
      } finally {
        reply.raw.end();
      }
    }
  );
};
