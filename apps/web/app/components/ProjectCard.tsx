"use client";

import Link from "next/link";
import type { Project } from "../lib/api";
import { relativeTime } from "../lib/api";
import DriftBadge from "./DriftBadge";
import BrainHealthBadge from "./BrainHealthBadge";

export default function ProjectCard({ project }: { project: Project }) {
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
  } = project;

  const hasOvernight = sessions_since > 0 || pending_drift_count > 0;

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

      {/* Last session line */}
      {last_session_agent_id && (
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
              {decision_count > 0 && (
                <span className="ml-1">· {decision_count} decision{decision_count !== 1 ? "s" : ""}</span>
              )}
            </p>
          )}
        </div>
      )}

      {/* Overnight delta */}
      {hasOvernight && (
        <p className="text-xs text-gray-400">
          ↑ {sessions_since} session{sessions_since !== 1 ? "s" : ""} · {decisions_since} decision{decisions_since !== 1 ? "s" : ""} overnight
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
