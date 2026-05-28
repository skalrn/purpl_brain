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
import { getDriftAlerts, getDriftAlertsForActor, getAlertProjectId, getSessionProjectId, resolveDriftAlert, countActiveSeats, countActiveSeatsForActor, resolvePersonByName, createFollowUpTaskFromAlert, getFollowUpTasks, listAgentSessions, getAgentSession, countRecentDecisions, listDecisions, getDecisionDetail, getCorpusStats } from "../lib/neo4j.js";
import { detectAndParse, flattenToText } from "../lib/transcript-parser.js";
import { chunkText } from "../lib/document-chunker.js";
import { deletePointsBySourceId } from "../lib/qdrant.js";
import { requireApiKey, requireProjectMember, assertProjectMember } from "../lib/auth-middleware.js";
import { processSignal } from "../services/signal-engine.js";
import type { CanonicalEvent, DriftResolution, EventSource, ExtractionResult, Decision } from "@purpl/types";

export const brainRoutes: FastifyPluginAsync = async (fastify) => {

  // ── GET /brain/drift-alerts ─────────────────────────────────────────────
  // project_id is optional. When omitted, returns pending alerts scoped to
  // the actor's own projects only (multi-project dashboard, Profile B).
  // requireProjectMember handles the project_id case; actor-scoped query
  // handles the no-project_id case — neither leaks cross-tenant data.
  fastify.get<{ Querystring: { project_id?: string } }>(
    "/brain/drift-alerts",
    { preHandler: [requireApiKey, requireProjectMember] },
    async (req, reply) => {
      const projectId = req.query.project_id || undefined;
      try {
        let alerts;
        if (projectId) {
          alerts = await getDriftAlerts(projectId);
        } else {
          const personId = req.actor?.person_id;
          if (!personId) {
            // DEV_API_KEY path — no actor, fall back to unscoped (local dev only)
            alerts = await getDriftAlerts(undefined);
          } else {
            alerts = await getDriftAlertsForActor(personId);
          }
        }
        return { alerts, project_id: projectId ?? null };
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

      // project_id is not in the URL so requireProjectMember cannot check it —
      // look it up and verify membership. Returns 404 for both not-found and
      // not-authorized to avoid disclosing resource existence to non-members.
      const alertProjectId = await getAlertProjectId(id);
      if (!await assertProjectMember(req, reply, alertProjectId, "Alert")) return;

      if (!["keep", "under_review", "reopen", "escalate"].includes(resolution)) {
        return reply.status(400).send({ error: "resolution must be keep | under_review | reopen | escalate" });
      }

      try {
        await resolveDriftAlert(id, resolution as "keep" | "under_review" | "reopen" | "escalate", new Date().toISOString());

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
    { preHandler: [requireApiKey, requireProjectMember] },
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

      reply.code(202);
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
      operator?: { id: string; name: string };
    };
  }>(
    "/brain/agent-log",
    { preHandler: [requireApiKey, requireProjectMember] },
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

      // Content quality gate — reject low-signal entries so agents are forced to retry
      // with substantive content. A brain full of noise is as useless as an empty one.
      const MIN_DESCRIPTION_CHARS = 20;
      const MIN_RATIONALE_CHARS = 15;
      const MIN_WORK_COMPLETED_CHARS = 10;

      const qualityErrors: Array<{ field: string; decision_id?: string; reason: string }> = [];

      if (!log.work_completed || log.work_completed.trim().length < MIN_WORK_COMPLETED_CHARS) {
        qualityErrors.push({
          field: "work_completed",
          reason: `must be at least ${MIN_WORK_COMPLETED_CHARS} characters — describe what was built or changed`,
        });
      }

      for (const d of log.decisions) {
        if (!d.description || d.description.trim().length < MIN_DESCRIPTION_CHARS) {
          qualityErrors.push({
            field: "decisions[].description",
            decision_id: d.id,
            reason: `must be at least ${MIN_DESCRIPTION_CHARS} characters — be specific about what was decided`,
          });
        }
        if (!d.rationale || d.rationale.trim().length < MIN_RATIONALE_CHARS) {
          qualityErrors.push({
            field: "decisions[].rationale",
            decision_id: d.id,
            reason: `must be at least ${MIN_RATIONALE_CHARS} characters — explain why this choice was made`,
          });
        }
      }

      if (qualityErrors.length > 0) {
        return reply.status(422).send({
          error: "Decision log rejected: content quality too low",
          hint: "Retry with fuller descriptions and rationale. The brain filters noise to stay useful.",
          violations: qualityErrors,
        });
      }

      // Soft-signal warnings — accepted but flagged so agents can improve future logs.
      const qualityWarnings: Array<{ field: string; decision_id?: string; hint: string }> = [];

      for (const d of log.decisions) {
        if (!d.alternatives_considered || d.alternatives_considered.length === 0) {
          qualityWarnings.push({
            field: "decisions[].alternatives_considered",
            decision_id: d.id,
            hint: "Adding alternatives_considered improves brain quality — what else was evaluated?",
          });
        }
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
        log.operator ? `Operator: ${log.operator.name} (${log.operator.id})` : "",
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
        operator: log.operator ? { type: "human", id: log.operator.id, name: log.operator.name } : undefined,
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

      reply.code(202);
      return {
        ok: true,
        event_id: eventId,
        decisions_logged: log.decisions.length,
        message: "Agent log queued for processing",
        ...(qualityWarnings.length > 0 && { warnings: qualityWarnings }),
      };
    }
  );

  // ── GET /brain/tasks ─────────────────────────────────────────────────────
  // Lists follow-up tasks created from drift alert resolutions.
  // All tasks require human approval before execution — requires_approval is
  // always true. Agents should surface these to humans, not auto-execute.
  fastify.get<{ Querystring: { project_id: string; status?: string } }>(
    "/brain/tasks",
    { preHandler: [requireApiKey, requireProjectMember] },
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
    { preHandler: [requireApiKey, requireProjectMember] },
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
  // Scoped to projects the actor is a member of — never returns global count.
  // dev_bypass falls back to the unscoped count (local dev only).
  fastify.get("/brain/seats", { preHandler: requireApiKey }, async (req, reply) => {
    try {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const personId = req.actor?.person_id;
      const seats = personId
        ? await countActiveSeatsForActor(personId, since)
        : await countActiveSeats(since); // dev_bypass path only
      return { seats, since };
    } catch (e) {
      fastify.log.error(e);
      return reply.status(500).send({ error: "Failed to count seats" });
    }
  });

  // ── GET /brain/agent-sessions ────────────────────────────────────────────
  // List all agent sessions for a project, newest first.
  // Each row corresponds to one POST /brain/agent-log call.
  fastify.get<{ Querystring: { project_id: string } }>(
    "/brain/agent-sessions",
    { preHandler: [requireApiKey, requireProjectMember] },
    async (req, reply) => {
      const { project_id } = req.query;
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }
      try {
        const sessions = await listAgentSessions(project_id);
        return { sessions, total: sessions.length, project_id };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to fetch agent sessions" });
      }
    }
  );

  // ── GET /brain/agent-sessions/:event_id ──────────────────────────────────
  // Full detail for one agent session — decisions, rationale, work summary.
  // The event_id is the value returned by POST /brain/agent-log.
  // Use this for pre-merge audits: "what did the agent decide in this session?"
  fastify.get<{ Params: { event_id: string } }>(
    "/brain/agent-sessions/:event_id",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { event_id } = req.params;
      try {
        // project_id is not in the URL, so requireProjectMember cannot check it.
        // Look it up and verify membership — returns 404 for both not-found and
        // not-authorized to avoid disclosing session existence to non-members.
        const sessionProjectId = await getSessionProjectId(event_id);
        if (!await assertProjectMember(req, reply, sessionProjectId, "Agent session")) return;

        const session = await getAgentSession(event_id);
        if (!session) {
          return reply.status(404).send({ error: "Agent session not found", event_id });
        }
        return session;
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to fetch agent session" });
      }
    }
  );

  // ── GET /brain/decisions/recent ──────────────────────────────────────────
  // Lightweight count of decisions logged since a given ISO timestamp.
  // Used by the Claude Code stop hook to check write-back compliance without
  // requiring direct Neo4j access.
  fastify.get<{ Querystring: { project_id: string; since: string } }>(
    "/brain/decisions/recent",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { project_id, since } = req.query;
      if (!project_id || !since) {
        return reply.status(400).send({ error: "project_id and since are required" });
      }
      try {
        const count = await countRecentDecisions(project_id, since);
        return { count, project_id, since };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to count recent decisions" });
      }
    }
  );

  // ── GET /brain/decisions ─────────────────────────────────────────────────
  // Flat list of decisions for a project, reverse-chronological.
  // Used by the decision feed in the project view (UI-5).
  fastify.get<{ Querystring: { project_id: string; limit?: string } }>(
    "/brain/decisions",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { project_id, limit } = req.query;
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }
      try {
        const decisions = await listDecisions(project_id, limit ? parseInt(limit, 10) : 50);
        return { decisions, project_id, total: decisions.length };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to list decisions" });
      }
    }
  );

  // ── GET /brain/decisions/:id ──────────────────────────────────────────────
  // Full decision detail: rationale, source event, drift alerts, follow-up tasks.
  fastify.get<{ Params: { id: string } }>(
    "/brain/decisions/:id",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { id } = req.params;
      try {
        const decision = await getDecisionDetail(id);
        if (!decision) {
          return reply.status(404).send({ error: "Decision not found" });
        }
        return decision;
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to fetch decision detail" });
      }
    }
  );

  // ── GET /brain/corpus-stats ───────────────────────────────────────────────
  // Extraction yield report for a project: how many events yielded decisions
  // vs how many yielded nothing. Useful for diagnosing thin corpora before
  // running evals or relying on brain_query for orchestration context.
  fastify.get<{ Querystring: { project_id: string } }>(
    "/brain/corpus-stats",
    { preHandler: requireApiKey },
    async (req, reply) => {
      const { project_id } = req.query;
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }
      try {
        const [neo4jStats, qdrantCount] = await Promise.all([
          getCorpusStats(project_id),
          fetch(
            `${process.env.QDRANT_URL ?? "http://localhost:6333"}/collections/${process.env.QDRANT_COLLECTION ?? "brain_chunks"}/points/count`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ filter: { must: [{ key: "project_id", match: { value: project_id } }] } }),
            }
          )
            .then(r => r.json())
            .then((r: { result?: { count: number } }) => r.result?.count ?? 0)
            .catch(() => 0),
        ]);

        return {
          ...neo4jStats,
          qdrant_chunks: qdrantCount,
          corpus_quality: corpusQualityLabel(neo4jStats.yield_rate, neo4jStats.total_events, qdrantCount),
        };
      } catch (e) {
        fastify.log.error(e);
        return reply.status(500).send({ error: "Failed to fetch corpus stats" });
      }
    }
  );
};

function corpusQualityLabel(yieldRate: number, totalEvents: number, chunks: number): string {
  if (totalEvents === 0) return "empty — ingest events first";
  if (chunks === 0)      return "ingested but not yet indexed — pipeline still processing";
  if (yieldRate < 0.20)  return "thin — most events yielded no decisions; seed decision-rich content";
  if (yieldRate < 0.40)  return "moderate — consider seeding more decision-rich PRs or discussions";
  return "healthy";
}
