"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fetchDecisions, relativeTime } from "../lib/api";
import type { Decision } from "../lib/api";

// ── Source accent bar colour (left edge of each card) ────────────────────────

const SOURCE_ACCENT: Record<string, string> = {
  agent:    "bg-purple-500",
  github:   "bg-blue-500",
  slack:    "bg-yellow-400",
  meeting:  "bg-emerald-500",
  jira:     "bg-cyan-500",
  linear:   "bg-violet-500",
  document: "bg-gray-500",
};

// ── Source label (compact text, no border pill) ──────────────────────────────

const SOURCE_LABEL: Record<string, { text: string; colour: string }> = {
  agent:    { text: "Agent",   colour: "text-purple-400" },
  github:   { text: "GitHub",  colour: "text-blue-400" },
  slack:    { text: "Slack",   colour: "text-yellow-400" },
  meeting:  { text: "Meeting", colour: "text-emerald-400" },
  jira:     { text: "Jira",    colour: "text-cyan-400" },
  linear:   { text: "Linear",  colour: "text-violet-400" },
  document: { text: "Doc",     colour: "text-gray-400" },
};

// ── Confidence dot ────────────────────────────────────────────────────────────

const CONFIDENCE_DOT: Record<string, string> = {
  high:   "bg-emerald-400",
  medium: "bg-yellow-400",
  low:    "bg-red-400",
};

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "high confidence",
  medium: "medium confidence",
  low: "low confidence",
};

// ── Date group separator ──────────────────────────────────────────────────────

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";

  const diffDays = Math.floor((today.getTime() - d.getTime()) / 86_400_000);
  if (diffDays < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  if (d.getFullYear() === today.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function groupByDay(decisions: Decision[]): Array<{ label: string; items: Decision[] }> {
  const groups: { label: string; items: Decision[] }[] = [];
  let currentLabel = "";

  for (const d of decisions) {
    const label = dayLabel(d.valid_from);
    if (label !== currentLabel) {
      groups.push({ label, items: [] });
      currentLabel = label;
    }
    groups[groups.length - 1].items.push(d);
  }
  return groups;
}

// ── Decision card ─────────────────────────────────────────────────────────────

function DecisionCard({ decision, projectId }: { decision: Decision; projectId: string }) {
  const accent = SOURCE_ACCENT[decision.event_source] ?? "bg-gray-600";
  const src    = SOURCE_LABEL[decision.event_source]  ?? { text: decision.event_source, colour: "text-gray-400" };
  const dot    = CONFIDENCE_DOT[decision.confidence]  ?? CONFIDENCE_DOT.medium;
  const conf   = CONFIDENCE_LABEL[decision.confidence] ?? decision.confidence;
  const actor  = decision.operator_name
    ? `${decision.operator_name} via ${decision.agent_id}`
    : decision.agent_id;

  return (
    <Link
      href={`/p/${encodeURIComponent(projectId)}/decisions/${encodeURIComponent(decision.decision_id)}`}
      className="group flex bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 hover:bg-gray-900/80 transition-all"
    >
      {/* Coloured source accent bar */}
      <div className={`w-1 shrink-0 ${accent} opacity-70 group-hover:opacity-100 transition-opacity`} />

      <div className="flex-1 min-w-0 px-4 py-3.5 flex flex-col gap-2.5">

        {/* ── Summary (headline) ── */}
        <p className="text-sm font-medium text-gray-100 leading-snug group-hover:text-white transition-colors">
          {decision.summary}
        </p>

        {/* ── Rationale (supporting context) ── */}
        {decision.rationale && (
          <p className="text-xs text-gray-400 leading-relaxed pl-3 border-l-2 border-gray-700">
            {decision.rationale}
          </p>
        )}

        {/* ── Alternatives considered ── */}
        {decision.alternatives_considered.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-xs text-gray-600 shrink-0">considered</span>
            {decision.alternatives_considered.map((alt) => (
              <span
                key={alt}
                className="text-xs text-gray-500 border border-gray-700/60 rounded-md px-2 py-0.5 bg-gray-800/60"
              >
                {alt}
              </span>
            ))}
          </div>
        )}

        {/* ── Footer metadata ── */}
        <div className="flex items-center gap-2 pt-0.5 flex-wrap">
          {/* Source */}
          <span className={`text-xs font-medium ${src.colour}`}>{src.text}</span>

          <span className="text-gray-700">·</span>

          {/* Confidence dot + label */}
          <span className="flex items-center gap-1">
            <span className={`inline-block w-1.5 h-1.5 rounded-full ${dot} shrink-0`} />
            <span className="text-xs text-gray-500">{conf}</span>
          </span>

          <span className="text-gray-700">·</span>

          {/* Actor */}
          <span className="text-xs text-gray-600 truncate max-w-[180px]" title={actor}>
            {actor}
          </span>

          {/* Lineage badge */}
          {decision.has_lineage && (
            <span className="text-xs text-purple-600 border border-purple-900/60 rounded px-1.5 py-0.5 shrink-0">
              ↻ history
            </span>
          )}

          {/* Time — pushed to the right */}
          <span className="text-xs text-gray-600 ml-auto shrink-0">
            {relativeTime(decision.valid_from)}
          </span>
        </div>
      </div>
    </Link>
  );
}

// ── Feed ─────────────────────────────────────────────────────────────────────

export default function DecisionFeed({ projectId }: { projectId: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["decisions", projectId],
    queryFn: () => fetchDecisions(projectId, 50),
    staleTime: 30_000,
    refetchInterval: 60_000,
    retry: 1,
  });

  const decisions = data?.decisions ?? [];
  const groups = groupByDay(decisions);

  return (
    <section>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-sm font-semibold text-gray-200">Decisions</h2>
        {!isLoading && !isError && decisions.length > 0 && (
          <span className="text-xs text-gray-600">{decisions.length}</span>
        )}
      </div>

      {isLoading && (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl h-24 animate-pulse" />
          ))}
        </div>
      )}

      {isError && (
        <div className="bg-gray-900 border border-amber-900/50 rounded-xl px-4 py-4 flex items-start gap-3">
          <span className="text-amber-500 text-sm mt-0.5">⚠</span>
          <div>
            <p className="text-sm text-gray-300">Brain API unreachable</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Start the stack with <span className="font-mono">docker compose up -d</span>
            </p>
          </div>
        </div>
      )}

      {!isLoading && !isError && decisions.length === 0 && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl px-4 py-6 text-center">
          <p className="text-sm text-gray-500">No decisions logged yet.</p>
          <p className="text-xs text-gray-600 mt-1">
            Use <span className="font-mono">brain_log_decision</span> from an agent session to start building the feed.
          </p>
        </div>
      )}

      {!isLoading && !isError && groups.length > 0 && (
        <div className="flex flex-col gap-5">
          {groups.map((group) => (
            <div key={group.label}>
              {/* Day label */}
              <p className="text-xs font-medium text-gray-600 uppercase tracking-wider mb-2 px-1">
                {group.label}
              </p>
              <div className="flex flex-col gap-2">
                {group.items.map((d) => (
                  <DecisionCard key={d.decision_id} decision={d} projectId={projectId} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
