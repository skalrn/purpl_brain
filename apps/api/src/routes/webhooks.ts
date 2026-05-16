import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { redis, STREAMS, PROCESSED_SET } from "../lib/redis.js";
import type { CanonicalEvent, EventType } from "@purpl/types";
import { v4 as uuidv4 } from "uuid";

const EVENT_TYPE_MAP: Record<string, EventType | null> = {
  "pull_request.opened": "pr_opened",
  "pull_request.closed": "pr_merged", // resolved per merged flag below
  "pull_request_review.submitted": "pr_review",
  "issues.opened": "issue_created",
  "issues.edited": "issue_updated",
  "issue_comment.created": "comment",
  push: "commit",
};

function verifySignature(body: string, signature: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

function resolveEventType(githubEvent: string, payload: Record<string, unknown>): EventType | null {
  if (githubEvent === "pull_request" && payload.action === "closed") {
    return payload.pull_request && (payload.pull_request as Record<string, unknown>).merged
      ? "pr_merged"
      : "pr_closed";
  }
  const key = `${githubEvent}.${payload.action as string}`;
  return EVENT_TYPE_MAP[key] ?? EVENT_TYPE_MAP[githubEvent] ?? null;
}

function extractCanonicalEvent(
  githubEvent: string,
  payload: Record<string, unknown>,
  deliveryId: string,
  projectId: string
): CanonicalEvent | null {
  const eventType = resolveEventType(githubEvent, payload);
  if (!eventType) return null;

  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const sender = payload.sender as Record<string, unknown>;
  const repo = payload.repository as Record<string, unknown>;

  const sourceEntity = pr ?? issue ?? payload;
  const sourceId = String((sourceEntity as Record<string, unknown>).number ?? (sourceEntity as Record<string, unknown>).id ?? deliveryId);
  const rawContent = [
    (sourceEntity as Record<string, unknown>).title,
    (sourceEntity as Record<string, unknown>).body,
  ]
    .filter(Boolean)
    .join("\n\n");

  const htmlUrl = String(
    (sourceEntity as Record<string, unknown>).html_url ??
    (repo as Record<string, unknown>).html_url ??
    ""
  );

  return {
    event_id: deliveryId,
    source: "github",
    source_id: sourceId,
    project_id: projectId,
    actor: {
      type: "human",
      id: String(sender.login),
      name: String(sender.login),
    },
    timestamp: new Date().toISOString(),
    event_type: eventType,
    raw_content: rawContent,
    url: htmlUrl,
  };
}

export const webhookRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: string }>(
    "/github",
    { config: { rawBody: true } },
    async (request, reply) => {
      const signature = request.headers["x-hub-signature-256"] as string | undefined;
      const deliveryId = request.headers["x-github-delivery"] as string | undefined;
      const githubEvent = request.headers["x-github-event"] as string | undefined;

      if (!signature || !deliveryId || !githubEvent) {
        return reply.code(400).send({ error: "Missing required GitHub headers" });
      }

      const rawBody = JSON.stringify(request.body);
      if (!verifySignature(rawBody, signature)) {
        return reply.code(401).send({ error: "Invalid signature" });
      }

      // Idempotency check
      const alreadyProcessed = await redis.sismember(PROCESSED_SET, deliveryId);
      if (alreadyProcessed) {
        return reply.code(200).send({ status: "duplicate" });
      }

      const payload = request.body as unknown as Record<string, unknown>;

      // project_id: derived from repo full_name — one project per repo for Phase 1
      const repo = payload.repository as Record<string, unknown> | undefined;
      const projectId = String(repo?.full_name ?? "unknown").replace("/", "_");

      const event = extractCanonicalEvent(githubEvent, payload, deliveryId, projectId);
      if (!event) {
        // Unrecognised event type — ack and ignore
        return reply.code(200).send({ status: "ignored" });
      }

      // Enqueue to raw stream
      await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event), "source", "webhook");

      // Mark processed (30-day TTL)
      await redis.sadd(PROCESSED_SET, deliveryId);
      await redis.expire(PROCESSED_SET, 60 * 60 * 24 * 30);

      request.log.info({ deliveryId, eventType: event.event_type, projectId }, "GitHub event enqueued");

      return reply.code(200).send({ status: "queued" });
    }
  );
};
