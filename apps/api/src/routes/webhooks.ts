import type { FastifyPluginAsync } from "fastify";
import { createHmac, timingSafeEqual } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { redis, STREAMS, PROCESSED_SET } from "../lib/redis.js";
import type { CanonicalEvent, EventType } from "@purpl/types";

const EVENT_TYPE_MAP: Record<string, EventType | null> = {
  "pull_request.opened": "pr_opened",
  "pull_request.closed": "pr_merged",
  "pull_request_review.submitted": "pr_review",
  "issues.opened": "issue_created",
  "issues.edited": "issue_updated",
  "issue_comment.created": "comment",
  push: "commit",
};

function verifySignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
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
  const sourceId = String(
    (sourceEntity as Record<string, unknown>).number ??
    (sourceEntity as Record<string, unknown>).id ??
    deliveryId
  );
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
  // Parse body as raw Buffer so we can verify GitHub's HMAC signature
  // against the exact bytes received — re-serializing parsed JSON breaks the sig
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body)
  );

  app.post<{ Body: Buffer }>("/github", async (request, reply) => {
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    const deliveryId = request.headers["x-github-delivery"] as string | undefined;
    const githubEvent = request.headers["x-github-event"] as string | undefined;

    if (!signature || !deliveryId || !githubEvent) {
      return reply.code(400).send({ error: "Missing required GitHub headers" });
    }

    if (!verifySignature(request.body, signature)) {
      return reply.code(401).send({ error: "Invalid signature" });
    }

    // Idempotency check
    const alreadyProcessed = await redis.sismember(PROCESSED_SET, deliveryId);
    if (alreadyProcessed) {
      return reply.code(200).send({ status: "duplicate" });
    }

    const payload = JSON.parse(request.body.toString()) as Record<string, unknown>;

    // project_id derived from repo full_name — one project per repo for Phase 1
    const repo = payload.repository as Record<string, unknown> | undefined;
    const projectId = String(repo?.full_name ?? "unknown").replace("/", "_");

    const event = extractCanonicalEvent(githubEvent, payload, deliveryId, projectId);
    if (!event) {
      return reply.code(200).send({ status: "ignored" });
    }

    await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event), "source", "webhook");

    await redis.sadd(PROCESSED_SET, deliveryId);
    await redis.expire(PROCESSED_SET, 60 * 60 * 24 * 30);

    request.log.info({ deliveryId, eventType: event.event_type, projectId }, "GitHub event enqueued");

    return reply.code(200).send({ status: "queued" });
  });

  // ── Jira webhook (M4) ──────────────────────────────────────────────────────
  // Jira sends all events to one endpoint; we discriminate by webhookEvent field.
  // Supported: jira:issue_created, jira:issue_updated, comment_created, comment_updated
  app.post<{ Body: Buffer }>("/jira", async (request, reply) => {
    // Optional HMAC verification (Jira doesn't sign by default — use secret in query param)
    const secret = process.env.JIRA_WEBHOOK_SECRET;
    if (secret) {
      const token = (request.query as Record<string, string>).token;
      if (token !== secret) {
        return reply.code(401).send({ error: "Invalid token" });
      }
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(request.body.toString()) as Record<string, unknown>;
    } catch {
      return reply.code(400).send({ error: "Invalid JSON" });
    }

    const webhookEvent = String(payload.webhookEvent ?? "");
    const issue = payload.issue as Record<string, unknown> | undefined;
    const comment = payload.comment as Record<string, unknown> | undefined;

    // Only handle issue and comment events
    if (!webhookEvent.startsWith("jira:issue") && !webhookEvent.startsWith("comment_")) {
      return reply.code(200).send({ status: "ignored" });
    }

    const issueKey = String(issue?.key ?? "unknown");
    const projectKey = issueKey.split("-")[0] ?? "unknown";
    const sourceId = `jira_${issueKey}_${webhookEvent}_${Date.now()}`;

    // Dedup
    const already = await redis.sismember(PROCESSED_SET, sourceId);
    if (already) return reply.code(200).send({ status: "duplicate" });

    // Build raw content from issue + comment
    const issueSummary = String((issue?.fields as Record<string, unknown>)?.summary ?? "");
    const issueDescription = String((issue?.fields as Record<string, unknown>)?.description ?? "");
    const commentBody = String(comment?.body ?? "");
    const rawContent = [issueSummary, issueDescription, commentBody].filter(Boolean).join("\n\n");

    if (!rawContent.trim()) {
      return reply.code(200).send({ status: "ignored" });
    }

    const actor = payload.user as Record<string, unknown> | undefined;
    const actorName = String(actor?.displayName ?? actor?.name ?? "jira");
    const actorId = String(actor?.accountId ?? actor?.name ?? "jira");

    const eventType: EventType = webhookEvent.startsWith("comment_") ? "jira_comment" : "jira_issue";
    const jiraBaseUrl = process.env.JIRA_BASE_URL ?? "https://jira.example.com";
    const url = `${jiraBaseUrl}/browse/${issueKey}`;

    const event: CanonicalEvent = {
      event_id: `jira_${uuidv4()}`,
      source: "jira",
      source_id: sourceId,
      project_id: process.env.JIRA_DEFAULT_PROJECT ?? projectKey.toLowerCase(),
      actor: { type: "human", id: actorId, name: actorName },
      timestamp: new Date().toISOString(),
      event_type: eventType,
      raw_content: rawContent,
      url,
      jira_issue_key: issueKey,
      jira_project_key: projectKey,
    };

    await redis.xadd(STREAMS.RAW, "*", "event", JSON.stringify(event));
    await redis.sadd(PROCESSED_SET, sourceId);

    request.log.info({ issueKey, eventType, projectKey }, "Jira event enqueued");
    return reply.code(200).send({ status: "queued", event_id: event.event_id });
  });
};
