"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DriftAlert } from "../lib/api";
import { resolveDriftAlert, relativeTime } from "../lib/api";

export default function DriftAlertRow({
  alert,
  projectId,
}: {
  alert: DriftAlert;
  projectId: string;
}) {
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
    <div className="flex flex-col gap-2 py-3 border-b border-gray-800 last:border-0">
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200 line-clamp-2">
            {alert.reason ?? alert.content}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            <span className="text-gray-400">{alert.actor}</span>
            {" · "}
            {relativeTime(alert.timestamp)}
            {" · "}
            <span className="text-gray-600">challenges: {alert.decision_summary.slice(0, 60)}{alert.decision_summary.length > 60 ? "…" : ""}</span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
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
