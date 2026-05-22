"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAgentSessions } from "../lib/api";
import SessionRow from "./SessionRow";

type Filter = "all" | "coding" | "infra" | "other";

export default function SessionList({ projectId }: { projectId: string }) {
  const [typeFilter, setTypeFilter] = useState<Filter>("all");
  const [operatorFilter, setOperatorFilter] = useState<string>("all");

  const { data, isLoading } = useQuery({
    queryKey: ["agent-sessions", projectId],
    queryFn: () => fetchAgentSessions(projectId),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const sessions = data?.sessions ?? [];

  const operators = Array.from(
    new Set(sessions.map((s) => s.operator_name).filter(Boolean) as string[])
  );

  const filtered = sessions.filter((s) => {
    if (typeFilter !== "all" && s.agent_type !== typeFilter) return false;
    if (operatorFilter !== "all" && s.operator_name !== operatorFilter) return false;
    return true;
  });

  const FILTERS: Filter[] = ["all", "coding", "infra", "other"];

  return (
    <section>
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <h2 className="text-sm font-semibold text-gray-200">Sessions</h2>
        <div className="flex items-center gap-1 ml-2">
          {FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={`px-2.5 py-0.5 rounded-full text-xs capitalize transition-colors ${
                typeFilter === f
                  ? "bg-purple-600 text-white"
                  : "bg-gray-800 text-gray-400 hover:text-gray-200"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        {operators.length > 0 && (
          <select
            value={operatorFilter}
            onChange={(e) => setOperatorFilter(e.target.value)}
            className="ml-auto text-xs bg-gray-800 border border-gray-700 rounded-lg px-2 py-1 text-gray-300 focus:outline-none focus:border-purple-500"
          >
            <option value="all">All operators</option>
            {operators.map((op) => (
              <option key={op} value={op}>
                {op}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4">
        {isLoading && (
          <div className="py-4 animate-pulse text-sm text-gray-600">Loading…</div>
        )}
        {!isLoading && filtered.length === 0 && (
          <div className="py-4 text-sm text-gray-500">No sessions found.</div>
        )}
        {filtered.map((s) => (
          <SessionRow key={s.event_id} session={s} projectId={projectId} />
        ))}
      </div>
    </section>
  );
}
