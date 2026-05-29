"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DriftAlert } from "../lib/api";
import { resolveDriftAlert, relativeTime } from "../lib/api";

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

export default function DriftAlertRow({
  alert,
  projectId,
}: {
  alert: DriftAlert;
  projectId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const queryClient = useQueryClient();

  const { mutate, isPending } = useMutation({
    mutationFn: (resolution: "keep" | "under_review" | "reopen") =>
      resolveDriftAlert(alert.alert_id, resolution),
    onSuccess: (_, resolution) => {
      toast.success(`Alert ${resolution === "keep" ? "kept" : resolution === "reopen" ? "reopened" : "marked under review"}`);
      queryClient.invalidateQueries({ queryKey: ["drift-alerts", projectId] });
    },
    onError: () => toast.error("Failed to resolve alert"),
  });

  return (
    <div className="py-3 border-b border-gray-800 last:border-0">
      {/* Collapsed summary row — click to expand */}
      <button
        className="w-full text-left flex items-start gap-2 group"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 line-clamp-2">
            {alert.reason ?? alert.content}
          </p>
          <p className="text-xs text-gray-500 mt-1 flex items-center gap-1.5 flex-wrap">
            <SourceBadge source={alert.source} />
            <span className="text-gray-400">{alert.actor}</span>
            <span>·</span>
            <span>{relativeTime(alert.timestamp)}</span>
            <span>·</span>
            <span className="text-gray-600">
              challenges: {alert.decision_summary.slice(0, 60)}{alert.decision_summary.length > 60 ? "…" : ""}
            </span>
          </p>
        </div>
        <span className="text-gray-600 text-xs mt-0.5 shrink-0 group-hover:text-gray-400 transition-colors">
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {/* Expanded: side-by-side comparison card */}
      {expanded && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          {/* Left — challenged decision */}
          <div className="rounded-xl border border-gray-700 bg-gray-900/60 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">Decision</span>
              <span className="text-xs text-gray-600">(challenged)</span>
            </div>
            <p className="text-sm text-gray-100 leading-relaxed">
              {alert.decision_summary}
            </p>
            <Link
              href={`/p/${projectId}/decisions/${alert.decision_id}`}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors mt-auto"
              onClick={(e) => e.stopPropagation()}
            >
              View decision →
            </Link>
          </div>

          {/* Right — challenging signal */}
          <div className="rounded-xl border border-red-900/60 bg-red-950/20 p-3 flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-red-400 uppercase tracking-wide">Signal</span>
              <span className="text-xs text-gray-600">(challenging)</span>
            </div>
            {alert.reason && (
              <p className="text-sm font-medium text-red-200 leading-relaxed">
                {alert.reason}
              </p>
            )}
            <p className="text-xs text-gray-400 leading-relaxed">
              {alert.content.slice(0, 300)}{alert.content.length > 300 ? "…" : ""}
            </p>
          </div>
        </div>
      )}

      {/* Action buttons — always visible */}
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={() => mutate("keep")}
          disabled={isPending}
          className="px-2.5 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40 transition-colors"
        >
          Keep
        </button>
        <button
          onClick={() => mutate("under_review")}
          disabled={isPending}
          className="px-2.5 py-1 rounded-lg text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-40 transition-colors"
        >
          Under review
        </button>
        <button
          onClick={() => mutate("reopen")}
          disabled={isPending}
          className="px-2.5 py-1 rounded-lg text-xs bg-red-900/40 hover:bg-red-900/60 text-red-400 disabled:opacity-40 transition-colors border border-red-900"
        >
          Reopen
        </button>
      </div>
    </div>
  );
}
