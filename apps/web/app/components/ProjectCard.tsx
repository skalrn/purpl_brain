"use client";

import Link from "next/link";
import type { Project } from "../lib/api";
import { relativeTime } from "../lib/api";
import DriftBadge from "./DriftBadge";
import BrainHealthBadge from "./BrainHealthBadge";

const SOURCE_LABELS: Record<string, { label: string; colour: string }> = {
  agent:    { label: "Agent",   colour: "text-purple-400 border-purple-800/60" },
  github:   { label: "GitHub",  colour: "text-blue-400 border-blue-800/60" },
  slack:    { label: "Slack",   colour: "text-yellow-400 border-yellow-800/60" },
  meeting:  { label: "Meeting", colour: "text-green-400 border-green-800/60" },
  jira:     { label: "Jira",    colour: "text-cyan-400 border-cyan-800/60" },
  document: { label: "Docs",    colour: "text-gray-400 border-gray-700/60" },
};

export default function ProjectCard({ project, windowLabel }: { project: Project; windowLabel: string }) {
  const {
    project_id,
    pending_drift_count,
    sessions_since,
    decisions_since,
    pending_tasks_count,
    last_event_at,
    last_decision_logged_at,
    last_session_agent_id,
    last_session_operator_name,
    last_session_work_summary,
    decision_count,
    active_sources = [],
  } = project;

  const hasDelta = sessions_since > 0 || decisions_since > 0;
  const isCold = decision_count === 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-5 flex flex-col gap-3 hover:border-gray-700 transition-colors">
      {/* Header row */}
      <div className="flex items-center gap-2 flex-wrap">
        <Link
          href={`/p/${encodeURIComponent(project_id)}`}
          className="font-semibold text-gray-100 hover:text-purple-300 transition-colors text-sm truncate flex-1"
        >
          {project_id}
        </Link>
        <BrainHealthBadge lastDecisionLoggedAt={last_decision_logged_at} />
        {pending_drift_count > 0 && (
          <Link href={`/p/${encodeURIComponent(project_id)}#drift`}>
            <DriftBadge count={pending_drift_count} />
          </Link>
        )}
      </div>

      {/* Cold brain state */}
      {isCold && (
        <p className="text-xs text-gray-600 italic">
          Brain is empty — <Link href={`/p/${encodeURIComponent(project_id)}`} className="text-purple-500 hover:text-purple-400">log the first decision →</Link>
        </p>
      )}

      {/* Last session line */}
      {!isCold && last_session_agent_id && (
        <div className="text-xs text-gray-400 space-y-0.5">
          <p>
            Last session:{" "}
            {last_session_operator_name ? (
              <>
                <span className="text-gray-200 font-medium">{last_session_operator_name}</span>
                <span className="text-gray-500"> via </span>
                <span className="font-mono text-gray-400">{last_session_agent_id}</span>
              </>
            ) : (
              <span className="font-mono text-gray-400">{last_session_agent_id}</span>
            )}
          </p>
          {last_session_work_summary && (
            <p className="text-gray-500 truncate">
              &ldquo;{last_session_work_summary}&rdquo;
            </p>
          )}
        </div>
      )}

      {/* Brain health — total decisions + active sources */}
      {!isCold && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">
            <span className="text-gray-300 font-medium">{decision_count}</span> decision{decision_count !== 1 ? "s" : ""}
          </span>
          {active_sources.length > 0 && (
            <>
              <span className="text-gray-700">·</span>
              <div className="flex items-center gap-1 flex-wrap">
                {active_sources.map((src) => {
                  const s = SOURCE_LABELS[src] ?? { label: src, colour: "text-gray-400 border-gray-700/60" };
                  return (
                    <span key={src} className={`text-xs border rounded px-1.5 py-0.5 font-mono ${s.colour}`}>
                      {s.label}
                    </span>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* Activity delta for selected window */}
      {hasDelta && (
        <p className="text-xs text-gray-400">
          ↑ <span className="text-gray-200">{sessions_since}</span> session{sessions_since !== 1 ? "s" : ""}
          {" · "}
          <span className="text-gray-200">{decisions_since}</span> decision{decisions_since !== 1 ? "s" : ""}
          <span className="text-gray-600"> — {windowLabel}</span>
        </p>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between text-xs text-gray-600 mt-auto pt-1">
        <span>
          {pending_tasks_count > 0 && (
            <span className="text-gray-500">{pending_tasks_count} task{pending_tasks_count !== 1 ? "s" : ""} pending</span>
          )}
        </span>
        {last_event_at && <span>{relativeTime(last_event_at)}</span>}
      </div>
    </div>
  );
}
