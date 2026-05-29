"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  fetchDecisionDetail,
  resolveDriftAlert,
  relativeTime,
  type DecisionDriftAlert,
  type DecisionFollowUpTask,
  type LineageNode,
} from "../../../../lib/api";

// ── Codegen prompt copy box ───────────────────────────────────────────────────

function CodegenPromptBox({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="border border-purple-800/50 bg-purple-950/20 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 border-b border-purple-800/30">
        <span className="text-xs font-medium text-purple-400">Agent prompt</span>
        <button
          onClick={copy}
          className="text-xs text-purple-400 hover:text-purple-200 transition-colors font-mono"
        >
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      <pre className="px-4 py-3 text-xs text-gray-300 whitespace-pre-wrap leading-relaxed overflow-auto max-h-48">
        {prompt}
      </pre>
    </div>
  );
}

// ── Source badge ────────────────────────────────────────────────────────────

const SOURCE_LABELS: Record<string, { label: string; colour: string }> = {
  agent:    { label: "Agent",    colour: "text-purple-400 border-purple-800 bg-purple-950/40" },
  github:   { label: "GitHub",   colour: "text-blue-400 border-blue-800 bg-blue-950/40" },
  slack:    { label: "Slack",    colour: "text-yellow-400 border-yellow-800 bg-yellow-950/40" },
  meeting:  { label: "Meeting",  colour: "text-green-400 border-green-800 bg-green-950/40" },
  jira:     { label: "Jira",     colour: "text-cyan-400 border-cyan-800 bg-cyan-950/40" },
  document: { label: "Doc",      colour: "text-gray-400 border-gray-700 bg-gray-800/40" },
};

function SourceBadge({ source }: { source: string }) {
  const s = SOURCE_LABELS[source] ?? { label: source, colour: "text-gray-400 border-gray-700 bg-gray-800/40" };
  return (
    <span className={`text-xs font-mono border rounded-full px-2 py-0.5 ${s.colour}`}>
      {s.label}
    </span>
  );
}

// ── Confidence badge ─────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: string }) {
  const colours: Record<string, string> = {
    high:   "text-green-400 border-green-800",
    medium: "text-yellow-400 border-yellow-800",
    low:    "text-red-400 border-red-800",
  };
  return (
    <span className={`text-xs font-mono capitalize border rounded-full px-2 py-0.5 ${colours[confidence] ?? colours.medium}`}>
      {confidence} confidence
    </span>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    confirmed:    "text-green-400 border-green-800",
    under_review: "text-amber-400 border-amber-800",
    changed:      "text-red-400 border-red-800",
  };
  const label = status === "under_review" ? "under review" : status;
  return (
    <span className={`text-xs font-mono capitalize border rounded-full px-2 py-0.5 ${map[status] ?? map.confirmed}`}>
      {label}
    </span>
  );
}

// ── Alert row variants ───────────────────────────────────────────────────────

function useAlertMutation(alertId: string, decisionId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (resolution: "keep" | "under_review" | "reopen" | "escalate") =>
      resolveDriftAlert(alertId, resolution),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["decision-detail", decisionId] });
      queryClient.invalidateQueries({ queryKey: ["drift-alerts", projectId] });
    },
    onError: () => toast.error("Failed to update alert"),
  });
}

function ConflictAlertRow({
  alert, decisionId, projectId,
}: { alert: DecisionDriftAlert; decisionId: string; projectId: string }) {
  const { mutate, isPending } = useAlertMutation(alert.alert_id, decisionId, projectId);
  return (
    <div className="flex flex-col gap-2 p-4 rounded-xl border bg-red-950/20 border-red-900/50">
      <div className="flex items-center gap-2">
        <SourceBadge source={alert.source} />
        <span className="text-xs text-gray-500">{relativeTime(alert.timestamp)}</span>
        <span className="text-xs text-gray-600 ml-auto">via {alert.actor}</span>
      </div>
      <p className="text-sm text-gray-200">{alert.reason ?? alert.content}</p>
      {alert.reason && alert.content !== alert.reason && (
        <p className="text-xs text-gray-500 line-clamp-2">{alert.content}</p>
      )}
      <div className="flex items-center gap-2 mt-1">
        <button onClick={() => { mutate("keep"); toast.success("Decision kept"); }}
          disabled={isPending}
          className="px-2.5 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40 transition-colors">
          Keep decision
        </button>
        <button onClick={() => { mutate("under_review"); toast.success("Marked under review"); }}
          disabled={isPending}
          className="px-2.5 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40 transition-colors">
          Under review
        </button>
        <button onClick={() => { mutate("reopen"); toast.success("Decision marked changed"); }}
          disabled={isPending}
          className="px-2.5 py-1 rounded-lg text-xs bg-red-900/40 hover:bg-red-900/60 text-red-400 disabled:opacity-40 transition-colors border border-red-900">
          Mark changed
        </button>
      </div>
    </div>
  );
}

function ConfirmationAlertRow({
  alert, decisionId, projectId,
}: { alert: DecisionDriftAlert; decisionId: string; projectId: string }) {
  const { mutate, isPending } = useAlertMutation(alert.alert_id, decisionId, projectId);
  return (
    <div className="flex flex-col gap-2 p-4 rounded-xl border bg-green-950/20 border-green-900/40">
      <div className="flex items-center gap-2">
        <span className="text-xs text-green-500">✓</span>
        <SourceBadge source={alert.source} />
        <span className="text-xs text-gray-500">{relativeTime(alert.timestamp)}</span>
        <span className="text-xs text-gray-600 ml-auto">via {alert.actor}</span>
      </div>
      <p className="text-sm text-gray-300">{alert.reason ?? alert.content}</p>
      <button
        onClick={() => { mutate("escalate"); toast.success("Escalated to conflict — needs review"); }}
        disabled={isPending}
        className="self-start px-2.5 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 disabled:opacity-40 transition-colors border border-gray-700"
      >
        Escalate to conflict
      </button>
    </div>
  );
}

function ResolvedAlertRow({ alert }: { alert: DecisionDriftAlert }) {
  const label: Record<string, string> = { keep: "kept", under_review: "under review", changed: "changed" };
  return (
    <div className="flex flex-col gap-1.5 p-4 rounded-xl border bg-gray-900/40 border-gray-800/60">
      <div className="flex items-center gap-2">
        <SourceBadge source={alert.source} />
        <span className="text-xs text-gray-600">{relativeTime(alert.timestamp)}</span>
        <span className="text-xs text-gray-600 font-mono ml-auto">{label[alert.resolution] ?? alert.resolution}</span>
      </div>
      <p className="text-xs text-gray-500 line-clamp-2">{alert.reason ?? alert.content}</p>
    </div>
  );
}

// ── Follow-up task row ────────────────────────────────────────────────────────

function TaskRow({ task }: { task: DecisionFollowUpTask }) {
  const statusColour =
    task.status === "open" ? "text-amber-400" :
    task.status === "done" ? "text-green-400" : "text-gray-400";

  return (
    <div className="flex flex-col gap-2 p-4 bg-gray-900 border border-gray-800 rounded-xl">
      <div className="flex items-center gap-2">
        <span className={`text-xs font-mono ${statusColour}`}>{task.status}</span>
        <span className="text-xs text-gray-600">{relativeTime(task.created_at)}</span>
        {task.suggested_owner && (
          <span className="text-xs text-gray-500 ml-auto">→ {task.suggested_owner}</span>
        )}
      </div>
      <p className="text-sm text-gray-200">{task.title}</p>
      {task.description && (
        <p className="text-xs text-gray-500">{task.description}</p>
      )}
      {task.codegen_prompt && (
        <CodegenPromptBox prompt={task.codegen_prompt} />
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function DecisionDetailPage({
  params,
}: {
  params: Promise<{ project_id: string; decision_id: string }>;
}) {
  const { project_id, decision_id } = use(params);
  const projectId = decodeURIComponent(project_id);
  const decisionId = decodeURIComponent(decision_id);

  const { data: decision, isLoading, isError } = useQuery({
    queryKey: ["decision-detail", decisionId],
    queryFn: () => fetchDecisionDetail(decisionId),
    staleTime: 30_000,
  });

  const conflictAlerts = decision?.drift_alerts.filter((a) => a.resolution === "pending") ?? [];
  const confirmAlerts  = decision?.drift_alerts.filter((a) => a.resolution === "confirms") ?? [];
  const resolvedAlerts = decision?.drift_alerts.filter(
    (a) => a.resolution !== "pending" && a.resolution !== "confirms"
  ) ?? [];

  return (
    <div className="flex flex-col min-h-full">
      {/* Breadcrumb */}
      <div className="border-b border-gray-800 px-6 py-3 flex items-center gap-2 text-sm shrink-0">
        <Link href="/" className="text-gray-500 hover:text-gray-300 transition-colors">Projects</Link>
        <span className="text-gray-700">/</span>
        <Link href={`/p/${project_id}`} className="font-mono text-gray-400 hover:text-gray-200 transition-colors">
          {projectId}
        </Link>
        <span className="text-gray-700">/</span>
        <span className="text-gray-600">decisions</span>
        <span className="text-gray-700">/</span>
        <span className="font-mono text-gray-600 truncate">{decisionId.slice(0, 16)}…</span>
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-pulse text-gray-500">Loading decision…</div>
        </div>
      )}

      {isError && (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          Failed to load decision. Check that the API is running.
        </div>
      )}

      {!isLoading && !isError && !decision && (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          Decision not found.
        </div>
      )}

      {decision && (
        <div className="flex-1 px-6 py-6 max-w-3xl mx-auto w-full flex flex-col gap-8">

          {/* Lineage timeline */}
          {(decision.supersedes || decision.superseded_by) && (
            <LineageTimeline
              current={{ decision_id: decision.decision_id, summary: decision.summary, valid_from: decision.valid_from }}
              supersedes={decision.supersedes}
              supersededBy={decision.superseded_by}
              projectId={decision.project_id}
            />
          )}

          {/* Decision header */}
          <section className="flex flex-col gap-4">
            <div className="flex items-center gap-2 flex-wrap">
              <SourceBadge source={decision.event_source} />
              <ConfidenceBadge confidence={decision.confidence} />
              <StatusBadge status={decision.status} />
              <span className="text-xs text-gray-600 ml-auto">{relativeTime(decision.valid_from)}</span>
            </div>

            <h1 className="text-lg font-semibold text-gray-100 leading-snug">
              {decision.summary}
            </h1>

            {decision.rationale && (
              <div className="border-l-2 border-purple-800 pl-4">
                <p className="text-xs text-gray-500 mb-1">Why</p>
                <p className="text-sm text-gray-300">{decision.rationale}</p>
              </div>
            )}

            {decision.alternatives_considered.length > 0 && (
              <div>
                <p className="text-xs text-gray-500 mb-1">Alternatives considered</p>
                <div className="flex flex-wrap gap-2">
                  {decision.alternatives_considered.map((alt) => (
                    <span
                      key={alt}
                      className="text-xs text-gray-400 border border-gray-700 rounded-full px-2.5 py-0.5 bg-gray-900"
                    >
                      {alt}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {decision.codegen_prompt && (
              <CodegenPromptBox prompt={decision.codegen_prompt} />
            )}
          </section>

          {/* Source */}
          <section className="border-t border-gray-800 pt-6">
            <p className="text-xs text-gray-500 mb-3">Source</p>
            <div className="flex items-center gap-2 flex-wrap text-sm">
              {decision.operator_name ? (
                <span>
                  <span className="font-medium text-gray-200">{decision.operator_name}</span>
                  <span className="text-gray-500"> via </span>
                  <span className="font-mono text-xs text-gray-400">{decision.agent_id}</span>
                </span>
              ) : (
                <span className="font-mono text-xs text-gray-400">{decision.agent_id}</span>
              )}
              <span className="text-gray-700">·</span>
              <Link
                href={`/p/${project_id}/sessions/${encodeURIComponent(decision.event_id)}`}
                className="text-xs font-mono text-gray-500 hover:text-purple-400 transition-colors"
              >
                view session →
              </Link>
              {decision.event_url?.startsWith("http") && (
                <>
                  <span className="text-gray-700">·</span>
                  <a
                    href={decision.event_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-gray-500 hover:text-blue-400 transition-colors"
                  >
                    source ↗
                  </a>
                </>
              )}
            </div>
          </section>

          {/* Conflicts — pending, require action */}
          {conflictAlerts.length > 0 && (
            <section className="border-t border-gray-800 pt-6">
              <div className="flex items-center gap-2 mb-3">
                <p className="text-xs font-semibold text-gray-300">Conflicts</p>
                <span className="text-xs text-red-400 border border-red-900 rounded-full px-2 py-0.5">
                  {conflictAlerts.length} pending
                </span>
              </div>
              <div className="flex flex-col gap-3">
                {conflictAlerts.map((a) => (
                  <ConflictAlertRow key={a.alert_id} alert={a} decisionId={decisionId} projectId={projectId} />
                ))}
              </div>
            </section>
          )}

          {/* Confirmations — LLM agrees, user can escalate if disagrees */}
          {confirmAlerts.length > 0 && (
            <section className="border-t border-gray-800 pt-6">
              <div className="flex items-center gap-2 mb-3">
                <p className="text-xs font-semibold text-gray-300">Confirmations</p>
                <span className="text-xs text-green-500 border border-green-900 rounded-full px-2 py-0.5">
                  {confirmAlerts.length} by LLM
                </span>
              </div>
              <p className="text-xs text-gray-600 mb-3">
                The system found signals consistent with this decision. If you disagree, escalate to flag as a conflict.
              </p>
              <div className="flex flex-col gap-3">
                {confirmAlerts.map((a) => (
                  <ConfirmationAlertRow key={a.alert_id} alert={a} decisionId={decisionId} projectId={projectId} />
                ))}
              </div>
            </section>
          )}

          {/* Resolved alerts */}
          {resolvedAlerts.length > 0 && (
            <section className="border-t border-gray-800 pt-6">
              <p className="text-xs font-semibold text-gray-500 mb-3">Resolved ({resolvedAlerts.length})</p>
              <div className="flex flex-col gap-2">
                {resolvedAlerts.map((a) => (
                  <ResolvedAlertRow key={a.alert_id} alert={a} />
                ))}
              </div>
            </section>
          )}

          {/* Follow-up tasks */}
          {decision.follow_up_tasks.length > 0 && (
            <section className="border-t border-gray-800 pt-6">
              <p className="text-xs font-semibold text-gray-300 mb-3">
                Follow-up tasks ({decision.follow_up_tasks.length})
              </p>
              <div className="flex flex-col gap-3">
                {decision.follow_up_tasks.map((t) => (
                  <TaskRow key={t.task_id} task={t} />
                ))}
              </div>
            </section>
          )}

          {/* Nothing at all */}
          {decision.drift_alerts.length === 0 && (
            <section className="border-t border-gray-800 pt-6">
              <p className="text-xs text-gray-600">No signals detected for this decision yet.</p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function LineageTimeline({
  current,
  supersedes,
  supersededBy,
  projectId,
}: {
  current: LineageNode;
  supersedes: LineageNode | null;
  supersededBy: LineageNode | null;
  projectId: string;
}) {
  const nodes = [
    supersedes ? { ...supersedes, kind: "older" as const } : null,
    { ...current, kind: "current" as const },
    supersededBy ? { ...supersededBy, kind: "newer" as const } : null,
  ].filter(Boolean) as Array<LineageNode & { kind: "older" | "current" | "newer" }>;

  return (
    <div className="border border-gray-800 rounded-xl px-4 py-3 bg-gray-900/40">
      <p className="text-xs text-gray-500 mb-3 font-medium uppercase tracking-wide">Decision lineage</p>
      <div className="flex items-start gap-0">
        {nodes.map((node, i) => (
          <div key={node.decision_id} className="flex items-start">
            {i > 0 && (
              <div className="flex items-center mt-2.5 mx-1">
                <div className="w-6 h-px bg-gray-700" />
                <span className="text-gray-600 text-xs">→</span>
                <div className="w-1 h-px bg-gray-700" />
              </div>
            )}
            <div className={`flex flex-col gap-1 max-w-48 ${node.kind === "current" ? "" : "opacity-60"}`}>
              <div className={`w-2 h-2 rounded-full mx-auto ${
                node.kind === "current" ? "bg-purple-500" :
                node.kind === "older"   ? "bg-gray-600" : "bg-gray-500"
              }`} />
              {node.kind === "current" ? (
                <p className="text-xs text-gray-200 text-center line-clamp-2">{node.summary}</p>
              ) : (
                <Link
                  href={`/p/${projectId}/decisions/${node.decision_id}`}
                  className="text-xs text-gray-400 hover:text-purple-300 text-center line-clamp-2 transition-colors"
                >
                  {node.summary}
                </Link>
              )}
              <p className="text-xs text-gray-700 text-center">{relativeTime(node.valid_from)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
