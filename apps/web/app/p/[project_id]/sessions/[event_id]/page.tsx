"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import AgentTypeBadge from "../../../../components/AgentTypeBadge";
import OperatorTag from "../../../../components/OperatorTag";
import RiskBadge from "../../../../components/RiskBadge";
import WriteBackQualityBadge from "../../../../components/WriteBackQualityBadge";
import { fetchAgentSession, relativeTime } from "../../../../lib/api";

export default function SessionDetailView({
  params,
}: {
  params: Promise<{ project_id: string; event_id: string }>;
}) {
  const { project_id, event_id } = use(params);
  const projectId = decodeURIComponent(project_id);
  const eventId = decodeURIComponent(event_id);

  const { data: session, isLoading } = useQuery({
    queryKey: ["agent-session", eventId],
    queryFn: () => fetchAgentSession(eventId),
    staleTime: 5 * 60_000,
  });

  const decisionsWithAlts = session?.decisions.filter(
    (d) => d.alternatives_considered && d.alternatives_considered.length > 0
  ).length ?? 0;

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
        <span className="font-mono text-gray-600 truncate">{eventId.slice(0, 16)}…</span>
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <div className="animate-pulse text-gray-500">Loading session…</div>
        </div>
      )}

      {!isLoading && !session && (
        <div className="flex-1 flex items-center justify-center text-gray-500">
          Session not found.
        </div>
      )}

      {session && (
        <div className="flex-1 px-6 py-6 max-w-4xl mx-auto w-full flex flex-col gap-8">
          {/* Metadata bar */}
          <div className="flex items-center gap-3 flex-wrap text-sm border-b border-gray-800 pb-4">
            <AgentTypeBadge type={session.agent_type} />
            {session.operator_name ? (
              <span>
                <span className="font-medium text-gray-100">{session.operator_name}</span>
                <span className="text-gray-500"> via </span>
                <span className="font-mono text-xs text-gray-400">{session.agent_id}</span>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <OperatorTag />
                <span className="font-mono text-xs text-gray-400">{session.agent_id}</span>
              </span>
            )}
            <span className="text-gray-600">·</span>
            <span className="font-mono text-xs text-gray-500">{session.project_id}</span>
            <span className="text-gray-600">·</span>
            <span className="text-xs text-gray-500">{relativeTime(session.timestamp)}</span>
            {session.decisions.length > 0 && (
              <>
                <span className="text-gray-600">·</span>
                <WriteBackQualityBadge
                  decisionCount={session.decisions.length}
                  decisionsWithAlternatives={decisionsWithAlts}
                  inline
                />
              </>
            )}
          </div>

          {/* Inherited context */}
          <InheritedContext
            resultsCount={session.brain_query_results_count}
            distinctSessions={session.brain_query_distinct_sessions_count}
          />

          {/* Decisions */}
          <section>
            <h2 className="text-sm font-semibold text-gray-200 mb-3">
              Decisions ({session.decisions.length})
            </h2>
            {session.decisions.length === 0 ? (
              <p className="text-sm text-gray-500">No decisions recorded for this session.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {session.decisions.map((d) => {
                  const incomplete =
                    !d.rationale ||
                    !d.alternatives_considered ||
                    d.alternatives_considered.length === 0;
                  return (
                    <div
                      key={d.decision_id}
                      className={`bg-gray-900 rounded-xl p-4 flex flex-col gap-2 border ${
                        incomplete ? "border-amber-800/60" : "border-gray-800"
                      }`}
                    >
                      <div className="flex items-start gap-2">
                        <p className="flex-1 text-sm text-gray-100">{d.summary}</p>
                        <div className="flex items-center gap-2 shrink-0">
                          {incomplete && (
                            <span className="text-xs text-amber-500 border border-amber-800 rounded-full px-2 py-0.5">
                              incomplete
                            </span>
                          )}
                          <span className="text-xs text-gray-500 font-mono capitalize border border-gray-700 rounded-full px-2 py-0.5">
                            {d.confidence}
                          </span>
                        </div>
                      </div>
                      {d.rationale && (
                        <p className="text-xs text-gray-400">
                          <span className="text-gray-600">Rationale: </span>
                          {d.rationale}
                        </p>
                      )}
                      {d.alternatives_considered && d.alternatives_considered.length > 0 && (
                        <p className="text-xs text-gray-400">
                          <span className="text-gray-600">Alternatives: </span>
                          {d.alternatives_considered.join(", ")}
                        </p>
                      )}
                      <p className="text-xs font-mono text-gray-700 select-all">{d.decision_id}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* Preflight checks */}
          {session.preflight_checks.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-gray-200 mb-3">
                Preflight Checks ({session.preflight_checks.length})
              </h2>
              <div className="flex flex-col gap-3">
                {session.preflight_checks.map((c) => (
                  <div key={c.check_id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <RiskBadge risk={c.overall_risk} />
                      <p className="text-sm text-gray-200 flex-1">{c.change_description}</p>
                    </div>
                    <p className="text-xs text-gray-400">{c.summary}</p>
                    <p className="text-xs text-gray-600">
                      {c.affected_decision_count} decision{c.affected_decision_count !== 1 ? "s" : ""} may be affected
                      {" · "}
                      {relativeTime(c.checked_at)}
                    </p>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Raw log */}
          <RawLog content={session.raw_content} />
        </div>
      )}
    </div>
  );
}

function InheritedContext({
  resultsCount,
  distinctSessions,
}: {
  resultsCount: number | null | undefined;
  distinctSessions: number | null | undefined;
}) {
  if (resultsCount === undefined || resultsCount === null) {
    return (
      <p className="text-xs text-gray-600 italic">
        This session did not query the brain at start.
      </p>
    );
  }
  if (resultsCount === 0) {
    return (
      <p className="text-xs text-gray-500 italic">
        This session queried the brain at start. No prior decisions found.
      </p>
    );
  }
  return (
    <p className="text-xs text-gray-400 italic">
      This session queried the brain at start. Found{" "}
      <span className="text-purple-400 font-medium">{resultsCount} prior decision{resultsCount !== 1 ? "s" : ""}</span>
      {distinctSessions ? ` from ${distinctSessions} session${distinctSessions !== 1 ? "s" : ""}` : ""}.
    </p>
  );
}

function RawLog({ content }: { content: string }) {
  const [open, setOpen] = useState(false);

  if (!content) return null;

  return (
    <section>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 text-xs text-gray-500 hover:text-gray-300 transition-colors mb-2"
      >
        <span>{open ? "▾" : "▸"}</span>
        Raw log
      </button>
      {open && (
        <pre className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-400 overflow-auto max-h-96 whitespace-pre-wrap">
          {content}
        </pre>
      )}
    </section>
  );
}

