"use client";

const AMBER_DAYS = 3;
const RED_DAYS = 7;

function daysSince(iso: string): number {
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

export default function BrainHealthBadge({
  lastDecisionLoggedAt,
}: {
  lastDecisionLoggedAt: string | null;
}) {
  if (!lastDecisionLoggedAt) {
    return (
      <span
        title="No agent decisions logged yet — check MCP setup"
        className="inline-flex items-center gap-1 rounded-full bg-red-900/40 border border-red-800 px-2 py-0.5 text-xs text-red-400 font-medium"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
        No decisions
      </span>
    );
  }

  const days = daysSince(lastDecisionLoggedAt);

  if (days > RED_DAYS) {
    return (
      <span
        title="No agent decisions logged this week — check MCP setup"
        className="inline-flex items-center gap-1 rounded-full bg-red-900/40 border border-red-800 px-2 py-0.5 text-xs text-red-400 font-medium"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
        Stale ({Math.floor(days)}d)
      </span>
    );
  }

  if (days > AMBER_DAYS) {
    return (
      <span
        title="No agent decisions logged in 3+ days — check MCP setup"
        className="inline-flex items-center gap-1 rounded-full bg-amber-900/40 border border-amber-800 px-2 py-0.5 text-xs text-amber-400 font-medium"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
        Quiet ({Math.floor(days)}d)
      </span>
    );
  }

  return null;
}
