/**
 * Document ingestion routes (Phase 4 M1)
 *
 * POST /brain/ingest/document  — ingest a single document (text paste or URL)
 * POST /brain/ingest/crawl-docs — crawl docs/**\/*.md from a GitHub repo
 */
import type { FastifyPluginAsync } from "fastify";
import { v4 as uuidv4 } from "uuid";
import { redis, STREAMS, PROCESSED_SET } from "../lib/redis.js";
import { chunkText, detectDocumentType } from "../lib/document-chunker.js";
import { crawlRepoDocs } from "../lib/github-doc-crawler.js";
import { deletePointsBySourceId } from "../lib/qdrant.js";
import { requireApiKey, requireProjectMember } from "../lib/auth-middleware.js";
import type { CanonicalEvent } from "@purpl/types";

export const ingestRoutes: FastifyPluginAsync = async (fastify) => {

  // ── POST /brain/ingest/document ──────────────────────────────────────────
  // Ingest a document as plain text. Chunks it and feeds into the pipeline.
  // Supported formats for M1: plain text / markdown (.md, .txt)
  // PDF/DOCX binary support added in M3.
  fastify.post<{
    Body: {
      text: string;
      title?: string;
      path?: string;
      document_type?: "adr" | "prd" | "runbook" | "unknown";
      project_id: string;
      source_url?: string;
    };
  }>(
    "/brain/ingest/document",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      preHandler: [requireApiKey, requireProjectMember],
    },
    async (req, reply) => {
      const { text, title, path, document_type, project_id, source_url } = req.body;

      if (!text || text.trim().length < 20) {
        return reply.status(400).send({ error: "text is required (min 20 chars)" });
      }
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }

      const resolvedType = document_type ?? (path ? detectDocumentType(path) : "unknown");
      const resolvedTitle = title ?? (path ? path.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") : "Untitled Document") ?? "Untitled Document";
      const url = source_url ?? `brain://document/${uuidv4()}`;
      // Stable dedup key — never include Date.now() or the 409 check can never fire.
      // Prefer source_url (canonical per document), then file path, then title slug.
      const sourceId = source_url
        ? `doc_${project_id}_${Buffer.from(source_url).toString("base64").slice(0, 32)}`
        : path
        ? `doc_${project_id}_${path.replace(/[^a-z0-9]/gi, "_")}`
        : `doc_${project_id}_${resolvedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;

      // Re-ingest path: if this source_id already processed, treat as REPLACE.
      // Delete prior Qdrant chunks (filter on payload.source_id) and clear the
      // dedup marker so the new chunks land cleanly. Otherwise stale chunks
      // from the previous version pollute retrieval indefinitely.
      const alreadyProcessed = await redis.sismember(PROCESSED_SET, sourceId);
      if (alreadyProcessed) {
        await deletePointsBySourceId(sourceId);
        await redis.srem(PROCESSED_SET, sourceId);
      }

      const chunks = chunkText(text);
      const eventIds: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const event: CanonicalEvent = {
          event_id: `doc_${uuidv4()}`,
          source: "document",
          source_id: sourceId,
          project_id,
          actor: { type: "human", id: "ingest-api", name: resolvedTitle },
          timestamp: new Date().toISOString(),
          event_type: "document_chunk",
          raw_content: chunks[i],
          url,
          document_title: resolvedTitle,
          document_path: path,
          document_type: resolvedType,
          chunk_index: i,
          total_chunks: chunks.length,
        };

        await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
        eventIds.push(event.event_id);
      }

      await redis.sadd(PROCESSED_SET, sourceId);

      fastify.log.info(
        { project_id, title: resolvedTitle, chunks: chunks.length, type: resolvedType },
        "Document ingested"
      );

      return reply.status(202).send({
        ok: true,
        chunks_queued: chunks.length,
        event_ids: eventIds,
        document_type: resolvedType,
        message: `${chunks.length} chunk(s) queued for processing`,
      });
    }
  );

  // ── POST /brain/ingest/crawl-docs ────────────────────────────────────────
  // Crawl docs/**/*.md from a GitHub repo and ingest all found documents.
  // GitHub token must be supplied as a second Bearer token in the
  // X-Github-Token header, or pre-configured as GITHUB_TOKEN env var.
  // It must NOT be sent in the request body to avoid accidental logging.
  fastify.post<{
    Body: {
      repo: string;         // "org/repo"
      project_id: string;
      path_prefix?: string; // default: "docs"
    };
  }>(
    "/brain/ingest/crawl-docs",
    {
      // Tight limit — each call spawns a background GitHub crawl that fans out
      // into many Redis stream writes. 5/min prevents Redis flood on a hot loop.
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      preHandler: [requireApiKey, requireProjectMember],
    },
    async (req, reply) => {
      const { repo, project_id, path_prefix } = req.body;

      if (!repo || !repo.includes("/")) {
        return reply.status(400).send({ error: "repo must be in org/repo format" });
      }
      if (!project_id) {
        return reply.status(400).send({ error: "project_id is required" });
      }

      // Accept GitHub token from dedicated header or env — never from body.
      const token = (req.headers["x-github-token"] as string | undefined) ?? process.env.GITHUB_TOKEN;
      if (!token) {
        return reply.status(400).send({ error: "GitHub token required — set GITHUB_TOKEN env or send X-Github-Token header" });
      }

      // Fire-and-forget: GitHub crawl can take 10-30s which causes MCP tool
      // timeouts. Return 202 immediately and queue events in the background.
      void (async () => {
        let events: CanonicalEvent[];
        try {
          events = await crawlRepoDocs(token, repo, project_id, path_prefix ?? "docs");
        } catch (e) {
          fastify.log.error({ repo, project_id, err: (e as Error).message }, "Background crawl failed");
          return;
        }

        if (events.length === 0) {
          fastify.log.info({ repo, project_id }, "Background crawl: no .md files found");
          return;
        }

        const uniqueSourceIds = [...new Set(events.map((e) => e.source_id))];
        for (const sid of uniqueSourceIds) {
          const already = await redis.sismember(PROCESSED_SET, sid);
          if (already) {
            await deletePointsBySourceId(sid);
            await redis.srem(PROCESSED_SET, sid);
          }
        }

        for (const event of events) {
          await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
        }

        for (const sid of uniqueSourceIds) {
          await redis.sadd(PROCESSED_SET, sid);
        }

        fastify.log.info(
          { repo, project_id, files: uniqueSourceIds.length, chunks: events.length },
          "Background crawl completed"
        );
      })();

      return reply.status(202).send({
        ok: true,
        message: `Crawl started for ${repo}. Events will be available once background processing completes.`,
      });
    }
  );
};
