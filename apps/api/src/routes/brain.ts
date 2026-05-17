/**
 * Brain routes — Phase 2 additions
 *
 * GET  /brain/drift-alerts?project_id=  — list pending drift alerts
 * POST /brain/drift-alerts/:id/resolve  — resolve a drift alert
 * POST /brain/ingest/transcript         — paste-in meeting transcript (M3)
 */
import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { redis, STREAMS, PROCESSED_SET } from "../lib/redis.js";
import { getDriftAlerts, resolveDriftAlert } from "../lib/neo4j.js";
import type { CanonicalEvent, DriftResolution } from "@purpl/types";

export const brainRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /brain/drift-alerts ─────────────────────────────────────────────
  fastify.get<{ Querystring: { project_id?: string } }>(
    "/brain/drift-alerts",
    async (req, reply) => {
      const projectId = req.query.project_id ?? "default";
      try {
        const alerts = await getDriftAlerts(projectId);
        return { alerts };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to fetch drift alerts" });
      }
    }
  );

  // ── POST /brain/drift-alerts/:id/resolve ────────────────────────────────
  fastify.post<{
    Params: { id: string };
    Body: { resolution: DriftResolution };
  }>(
    "/brain/drift-alerts/:id/resolve",
    async (req, reply) => {
      const { id } = req.params;
      const { resolution } = req.body;

      if (!["keep", "under_review", "reopen"].includes(resolution)) {
        return reply.status(400).send({ error: "resolution must be keep | under_review | reopen" });
      }

      try {
        await resolveDriftAlert(id, resolution as "keep" | "under_review" | "reopen", new Date().toISOString());
        return { ok: true, alert_id: id, resolution };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to resolve drift alert" });
      }
    }
  );

  // ── POST /brain/ingest/transcript (M3) ──────────────────────────────────
  fastify.post<{
    Body: {
      text: string;
      title?: string;
      participants?: string[];
      occurred_at?: string;
      project_id: string;
    };
  }>(
    "/brain/ingest/transcript",
    async (req, reply) => {
      const { text, title, participants, occurred_at, project_id } = req.body;

      if (!text || text.trim().length < 20) {
        return reply.status(400).send({ error: "text is required (min 20 chars)" });
      }
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }

      const eventId = `meeting_${uuidv4()}`;
      const sourceId = `meeting_${uuidv4()}`;
      const timestamp = occurred_at ?? new Date().toISOString();

      const event: CanonicalEvent = {
        event_id: eventId,
        source: "meeting",
        source_id: sourceId,
        project_id,
        actor: { type: "human", id: "transcript", name: "Meeting Transcript" },
        timestamp,
        event_type: "meeting_transcript",
        raw_content: text,
        url: `brain://meeting/${eventId}`,
        meeting_title: title,
        meeting_participants: participants,
      };

      const already = await redis.sismember(PROCESSED_SET, sourceId);
      if (already) {
        return reply.status(409).send({ error: "Duplicate transcript" });
      }

      await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
      await redis.sadd(PROCESSED_SET, sourceId);

      return {
        ok: true,
        event_id: eventId,
        message: "Transcript queued for processing",
      };
    }
  );
};
