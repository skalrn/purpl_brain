/**
 * Brain routes — Phase 2 + Phase 3
 *
 * GET  /brain/drift-alerts?project_id=  — list pending drift alerts
 * POST /brain/drift-alerts/:id/resolve  — resolve a drift alert
 * POST /brain/ingest/transcript         — paste-in meeting transcript (M3)
 * POST /brain/agent-log                 — agent writes decisions back into the brain (M2/Phase 3)
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

  // ── POST /brain/agent-log (Phase 3 M2) ──────────────────────────────────
  // Receives structured decision logs from AI agent sessions and feeds them
  // through the standard ingestion pipeline so they are queryable alongside
  // human-generated signals.
  // TODO: add API key auth before production deployment (open for beta)
  fastify.post<{
    Body: {
      schema_version: string;
      session_id: string;
      agent_id: string;
      project_id: string;
      task_id?: string;
      codebase?: string;
      timestamp_start: string;
      timestamp_end: string;
      decisions: Array<{
        id: string;
        description: string;
        rationale: string;
        alternatives_considered?: string[];
        confidence?: "high" | "medium" | "low";
      }>;
      work_completed: string;
      unresolved?: string[];
      next_steps?: string[];
      files_modified?: string[];
    };
  }>(
    "/brain/agent-log",
    async (req, reply) => {
      const log = req.body;

      if (!log.project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }
      if (!log.session_id) {
        return reply.status(400).send({ error: "session_id is required" });
      }
      if (!Array.isArray(log.decisions) || log.decisions.length === 0) {
        return reply.status(400).send({ error: "decisions array is required and must be non-empty" });
      }

      const eventId = `agent_${uuidv4()}`;
      const sourceId = `agent_session_${log.session_id}`;

      const already = await redis.sismember(PROCESSED_SET, sourceId);
      if (already) {
        return reply.status(409).send({ error: "Session already logged", session_id: log.session_id });
      }

      // Flatten decisions into raw_content so the extraction pipeline can process them
      const decisionText = log.decisions
        .map((d) => {
          const alts = d.alternatives_considered?.length
            ? ` (alternatives considered: ${d.alternatives_considered.join(", ")})`
            : "";
          return `Decision: ${d.description}. Rationale: ${d.rationale}${alts}.`;
        })
        .join("\n\n");

      const rawContent = [
        `Agent session: ${log.agent_id} on ${log.project_id}`,
        `Work completed: ${log.work_completed}`,
        "",
        decisionText,
        log.unresolved?.length ? `\nUnresolved: ${log.unresolved.join("; ")}` : "",
        log.next_steps?.length ? `\nNext steps: ${log.next_steps.join("; ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      const event: CanonicalEvent = {
        event_id: eventId,
        source: "agent",
        source_id: sourceId,
        project_id: log.project_id,
        actor: { type: "agent", id: log.agent_id, name: log.agent_id },
        timestamp: log.timestamp_end ?? new Date().toISOString(),
        event_type: "agent_session",
        raw_content: rawContent,
        url: `brain://agent/${eventId}`,
      };

      await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
      await redis.sadd(PROCESSED_SET, sourceId);

      fastify.log.info(
        { session_id: log.session_id, decisions: log.decisions.length, project_id: log.project_id },
        "Agent log ingested"
      );

      return {
        ok: true,
        event_id: eventId,
        decisions_logged: log.decisions.length,
        message: "Agent log queued for processing",
      };
    }
  );
};
