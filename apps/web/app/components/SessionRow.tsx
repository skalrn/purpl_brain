"use client";

import Link from "next/link";
import type { AgentSession } from "../lib/api";
import { relativeTime } from "../lib/api";
import AgentTypeBadge from "./AgentTypeBadge";
import OperatorTag from "./OperatorTag";
import WriteBackQualityBadge from "./WriteBackQualityBadge";

export default function SessionRow({
  session,
  projectId,
}: {
  session: AgentSession;
  projectId: string;
}) {
  return (
    <Link
      href={`/p/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(session.event_id)}`}
      className="flex items-center gap-3 py-3 border-b border-gray-800 last:border-0 hover:bg-gray-800/40 -mx-4 px-4 transition-colors rounded"
    >
      {/* Agent type icon */}
      <div className="shrink-0 w-14">
        <AgentTypeBadge type={session.agent_type} />
      </div>

      {/* Operator + agent */}
      <div className="flex-1 min-w-0">
        {session.operator_name ? (
          <p className="text-sm truncate">
            <span className="font-medium text-gray-100">{session.operator_name}</span>
            <span className="text-gray-500"> via </span>
            <span className="font-mono text-xs text-gray-400">{session.agent_id}</span>
          </p>
        ) : (
          <p className="text-sm truncate flex items-center gap-2">
            <OperatorTag />
            <span className="font-mono text-xs text-gray-400">{session.agent_id}</span>
          </p>
        )}
        {session.work_summary && (
          <p className="text-xs text-gray-500 truncate mt-0.5">{session.work_summary}</p>
        )}
      </div>

      {/* Right: quality dot + count + time */}
      <div className="flex items-center gap-2 shrink-0 text-xs text-gray-500">
        <WriteBackQualityBadge
          decisionCount={session.decision_count}
          decisionsWithAlternatives={session.decisions_with_alternatives}
        />
        <span>{session.decision_count}d</span>
        <span>{relativeTime(session.timestamp)}</span>
      </div>
    </Link>
  );
}
