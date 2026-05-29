"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fetchDecisionChain, relativeTime, type ChainNode } from "../lib/api";

// Build a flat chronological event list from the chain
type TimelineEvent =
  | { kind: "created";     node: ChainNode; is_current: boolean }
  | { kind: "drift";       alert: ChainNode["drift_alerts"][0]; decision_id: string }
  | { kind: "superseded";  older: ChainNode; newer: ChainNode };

function buildEvents(chain: ChainNode[], currentId: string): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];

    events.push({ kind: "created", node, is_current: node.decision_id === currentId });

    // Drift alerts on this node, sorted by timestamp
    const alerts = [...node.drift_alerts].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    for (const alert of alerts) {
      events.push({ kind: "drift", alert, decision_id: node.decision_id });
    }

    // Superseded transition to next node
    if (i < chain.length - 1) {
      events.push({ kind: "superseded", older: node, newer: chain[i + 1] });
    }
  }

  return events;
}

const RESOLUTION_LABEL: Record<string, { label: string; colour: string }> = {
  pending:      { label: "Pending",      colour: "text-red-400" },
  keep:         { label: "Kept",         colour: "text-green-400" },
  under_review: { label: "Under review", colour: "text-yellow-400" },
  superseded:   { label: "Superseded",   colour: "text-gray-500" },
};

export default function DecisionTimeline({
  decisionId,
  projectId,
}: {
  decisionId: string;
  projectId: string;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["decision-chain", decisionId],
    queryFn: () => fetchDecisionChain(decisionId),
    staleTime: 60_000,
  });

  const chain = data?.chain ?? [];

  if (isLoading) {
    return <div className="animate-pulse text-xs text-gray-600 py-2">Loading history…</div>;
  }

  if (chain.length <= 1 && chain[0]?.drift_alerts.length === 0) return null;

  const events = buildEvents(chain, decisionId);

  return (
    <div className="flex flex-col gap-0">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">
        Decision history
      </p>

      <div className="relative">
        {/* Vertical connector line */}
        <div className="absolute left-[7px] top-2 bottom-2 w-px bg-gray-800" />

        <div className="flex flex-col gap-0">
          {events.map((event, i) => (
            <div key={i} className="flex gap-4 pb-5 relative">
              {/* Icon */}
              <div className="shrink-0 mt-0.5">
                {event.kind === "created" && (
                  <div className={`w-3.5 h-3.5 rounded-full border-2 ${
                    event.is_current
                      ? "bg-purple-600 border-purple-500"
                      : event.node.status === "confirmed"
                      ? "bg-gray-700 border-gray-600"
                      : "bg-gray-800 border-gray-700"
                  }`} />
                )}
                {event.kind === "drift" && (
                  <div className={`w-3.5 h-3.5 rounded-sm border ${
                    event.alert.resolution === "pending"
                      ? "bg-red-900/60 border-red-700"
                      : "bg-gray-800 border-gray-700"
                  }`} />
                )}
                {event.kind === "superseded" && (
                  <div className="w-3.5 h-3.5 flex items-center justify-center">
                    <span className="text-gray-500 text-xs">→</span>
                  </div>
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0 -mt-0.5">
                {event.kind === "created" && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium ${
                        event.is_current ? "text-purple-300" : "text-gray-400"
                      }`}>
                        {event.is_current ? "Current" : "Earlier version"}
                      </span>
                      <span className="text-xs text-gray-600">
                        {relativeTime(event.node.valid_from)}
                      </span>
                    </div>
                    {event.node.decision_id !== decisionId ? (
                      <Link
                        href={`/p/${projectId}/decisions/${event.node.decision_id}`}
                        className="text-sm text-gray-300 hover:text-purple-300 transition-colors leading-snug"
                      >
                        {event.node.summary}
                      </Link>
                    ) : (
                      <p className="text-sm text-gray-100 leading-snug font-medium">
                        {event.node.summary}
                      </p>
                    )}
                    {event.node.rationale && !event.is_current && (
                      <p className="text-xs text-gray-500 leading-relaxed line-clamp-2">
                        {event.node.rationale}
                      </p>
                    )}
                  </div>
                )}

                {event.kind === "drift" && (
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-red-400">Drift detected</span>
                      <span className="text-xs text-gray-600">
                        {relativeTime(event.alert.timestamp)}
                      </span>
                      <span className={`text-xs ml-auto ${RESOLUTION_LABEL[event.alert.resolution]?.colour ?? "text-gray-500"}`}>
                        {RESOLUTION_LABEL[event.alert.resolution]?.label ?? event.alert.resolution}
                      </span>
                    </div>
                    <p className="text-xs text-gray-400 leading-relaxed">
                      {event.alert.reason ?? event.alert.content.slice(0, 120)}
                    </p>
                    {event.alert.resolution_reason && (
                      <p className="text-xs text-gray-600 italic">
                        "{event.alert.resolution_reason}"
                      </p>
                    )}
                  </div>
                )}

                {event.kind === "superseded" && (
                  <div className="flex items-center gap-2 py-1">
                    <span className="text-xs text-gray-600">Superseded by newer decision</span>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
