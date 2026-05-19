/**
 * Brain routes — Phase 2 + Phase 3
 *
 * GET  /brain/drift-alerts?project_id=  — list pending drift alerts
 * POST /brain/drift-alerts/:id/resolve  — resolve a drift alert
 * POST /brain/ingest/transcript         — paste-in meeting transcript (M3)
 * POST /brain/agent-log                 — agent writes decisions back into the brain (M2/Phase 3)
 * GET  /brain/seats                     — count active seats for billing (M5)
 */
import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { redis, STREAMS, PROCESSED_SET } from "../lib/redis.js";
import { getDriftAlerts, resolveDriftAlert, countActiveSeats, resolvePersonByName, createFollowUpTaskFromAlert, getFollowUpTasks } from "../lib/neo4j.js";
import { detectAndParse, flattenToText } from "../lib/transcript-parser.js";
import { chunkText } from "../lib/document-chunker.js";
import { deletePointsBySourceId } from "../lib/qdrant.js";
import { requireApiKey, requireProjectMember } from "../lib/auth-middleware.js";
import { processSignal } from "../services/signal-engine.js";
import type { CanonicalEvent, DriftResolution, EventSource, ExtractionResult, Decision } from "@purpl/types";

export const brainRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /brain/drift-alerts ─────────────────────────────────────────────
  fastify.get<{ Querystring: { project_id?: string } }>(
    "/brain/drift-alerts",
    { preHandler: [requireApiKey, requireProjectMember] },
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
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { id } = req.params;
      const { resolution } = req.body;

      if (!["keep", "under_review", "reopen"].includes(resolution)) {
        return reply.status(400).send({ error: "resolution must be keep | under_review | reopen" });
      }

      try {
        await resolveDriftAlert(id, resolution as "keep" | "under_review" | "reopen", new Date().toISOString());

        // "reopen" means the decision is no longer valid — create a follow-up task
        // so the team has an actionable item to resolve the contradiction.
        if (resolution === "reopen") {
          const task = await createFollowUpTaskFromAlert(id);
          return {
            ok: true,
            alert_id: id,
            resolution,
            follow_up_task: task ?? undefined,
            message: task
              ? `Decision marked changed. Follow-up task created: "${task.title}" (${task.task_id})`
              : "Decision marked changed. No linked decision found for task creation.",
          };
        }

        return { ok: true, alert_id: id, resolution };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to resolve drift alert" });
      }
    }
  );

  // ── POST /brain/ingest/transcript (Phase 4 M2) ──────────────────────────
  // Accepts VTT, SRT, or plain-text transcripts. Auto-detects format.
  // Chunks long transcripts, resolves speaker names to Person nodes.
  fastify.post<{
    Body: {
      text: string;
      title?: string;
      occurred_at?: string;
      project_id: string;
      source_url?: string;
    };
  }>(
    "/brain/ingest/transcript",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { text, title, occurred_at, project_id, source_url } = req.body;

      if (!text || text.trim().length < 20) {
        return reply.status(400).send({ error: "text is required (min 20 chars)" });
      }
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }

      const baseDate = occurred_at ?? new Date().toISOString();
      // Stable dedup key: prefer caller-supplied source_url, fall back to title+project slug
      const sourceId = source_url
        ? `meeting_${project_id}_${Buffer.from(source_url).toString("base64").slice(0, 32)}`
        : `meeting_${project_id}_${(title ?? "transcript").toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

      // Re-ingest path: REPLACE rather than 409. Delete prior Qdrant chunks
      // before enqueueing so the new transcript content fully supersedes the
      // old one in retrieval.
      const already = await redis.sismember(PROCESSED_SET, sourceId);
      if (already) {
        await deletePointsBySourceId(sourceId);
        await redis.srem(PROCESSED_SET, sourceId);
      }

      // Parse VTT/SRT/plain and extract speakers
      const parsed = detectAndParse(text, baseDate);
      const flatText = flattenToText(parsed.segments);
      const chunks = chunkText(flatText);

      // Best-effort speaker resolution (non-fatal)
      const resolvedSpeakers: string[] = [];
      for (const name of parsed.speakers) {
        const person = await resolvePersonByName(name).catch(() => null);
        resolvedSpeakers.push(person?.name ?? name);
      }

      const url = source_url ?? `brain://meeting/${sourceId}`;
      const eventIds: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunkSpeaker = (() => {
          // Try to identify dominant speaker for this chunk
          const match = chunks[i].match(/^([A-Z][^:\n]{1,40}):/m);
          return match ? match[1].trim() : null;
        })();

        const event: CanonicalEvent = {
          event_id: `meeting_${uuidv4()}`,
          source: "meeting",
          source_id: sourceId,
          project_id,
          actor: {
            type: "human",
            id: chunkSpeaker ?? "meeting",
            name: chunkSpeaker ?? (title ?? "Meeting Transcript"),
          },
          timestamp: baseDate,
          event_type: "meeting_transcript",
          raw_content: chunks[i],
          url,
          meeting_title: title,
          meeting_participants: resolvedSpeakers,
          chunk_index: i,
          total_chunks: chunks.length,
        };

        await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
        eventIds.push(event.event_id);
      }

      await redis.sadd(PROCESSED_SET, sourceId);

      fastify.log.info(
        { project_id, title, chunks: chunks.length, format: parsed.format, speakers: parsed.speakers },
        "Transcript ingested"
      );

      return {
        ok: true,
        chunks_queued: chunks.length,
        event_ids: eventIds,
        format: parsed.format,
        speakers: parsed.speakers,
        message: `${chunks.length} chunk(s) queued for processing`,
      };
    }
  );

  // ── POST /brain/agent-log (Phase 3 M2) ──────────────────────────────────
  // Receives structured decision logs from AI agent sessions and feeds them
  // through the standard ingestion pipeline so they are queryable alongside
  // human-generated signals.
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
    { preHandler: requireApiKey },
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

      // Build raw_content summary for Event node + Qdrant text
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

      // Map structured agent decisions directly to Decision[] — bypass LLM extractor.
      // The extractor is designed for raw human text; agent logs are already structured.
      // Publishing to events:extracted ensures has_decisions=true in Qdrant and proper
      // Decision nodes in Neo4j, which is required for drift detection Stage A.
      const decisions: Decision[] = log.decisions.map((d) => ({
        quoted_text: `Decision: ${d.description}. Rationale: ${d.rationale ?? ""}`,
        summary: d.description,
        rationale: d.rationale ?? null,
        alternatives_considered: d.alternatives_considered ?? [],
        confidence: d.confidence ?? "medium",
      }));

      const extractionResult: ExtractionResult = {
        event_id: eventId,
        project_id: log.project_id,
        source_id: sourceId,
        source_url: `brain://agent/${eventId}`,
        raw_content: rawContent,
        actor: { type: "agent", id: log.agent_id, name: log.agent_id },
        timestamp: log.timestamp_end ?? new Date().toISOString(),
        decisions,
        ticket_refs: [],
        person_mentions: [],
        concept_tags: [],
        decision_candidate: true,
      };

      await redis.xadd(STREAMS.EXTRACTED, "*", "result", JSON.stringify(extractionResult));
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

  // ── GET /brain/tasks ─────────────────────────────────────────────────────
  // Lists follow-up tasks created from drift alert resolutions.
  // An agent can call brain_query("what open tasks are waiting?") and get
  // these back with codegen_prompt attached for immediate execution.
  fastify.get<{ Querystring: { project_id: string; status?: string } }>(
    "/brain/tasks",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { project_id, status } = req.query;
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }
      try {
        const tasks = await getFollowUpTasks(project_id, status);
        return { tasks, total: tasks.length };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to fetch tasks" });
      }
    }
  );

  // ── POST /brain/signals ──────────────────────────────────────────────────
  // Ingest an observation or new piece of information. The signal is matched
  // against existing confirmed decisions; a DriftAlert is created for each match
  // so reviewers can decide whether the decision still stands.
  fastify.post<{
    Body: {
      text: string;
      project_id: string;
      source: string;
      actor_id: string;
      actor_name: string;
      url?: string;
      occurred_at?: string;
    };
  }>(
    "/brain/signals",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { text, project_id, source, actor_id, actor_name, url, occurred_at } = req.body;

      if (!text || text.trim().length < 10) {
        return reply.status(400).send({ error: "text is required (min 10 chars)" });
      }
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }
      if (!source || !actor_id || !actor_name) {
        return reply.status(400).send({ error: "source, actor_id, and actor_name are required" });
      }

      try {
        const result = await processSignal({
          text,
          project_id,
          source: source as EventSource,
          actor_id,
          actor_name,
          url,
          occurred_at,
        });
        return result;
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Signal processing failed" });
      }
    }
  );

  // ── GET /brain/seats (M5) ────────────────────────────────────────────────
  fastify.get("/brain/seats", { preHandler: requireApiKey }, async (_req, reply) => {
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const seats = await countActiveSeats(since);
      return { seats, since };
    } catch (e) {
      fastify.log.error(e);
      return reply.status(500).send({ error: "Failed to count seats" });
    }
  });
};
