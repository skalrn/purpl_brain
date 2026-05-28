"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ProjectGrid from "./components/ProjectGrid";
import { fetchProjects, fetchDriftAlerts } from "./lib/api";

const WINDOW_OPTIONS = [
  { label: "Today",    sublabel: "since midnight",    getValue: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); } },
  { label: "24h",     sublabel: "in the last 24h",   getValue: () => new Date(Date.now() - 86_400_000).toISOString() },
  { label: "48h",     sublabel: "in the last 48h",   getValue: () => new Date(Date.now() - 2 * 86_400_000).toISOString() },
  { label: "7d",      sublabel: "in the last 7 days", getValue: () => new Date(Date.now() - 7 * 86_400_000).toISOString() },
];

export default function ProjectsOverview() {
  const [windowIdx, setWindowIdx] = useState(0);
  const since = WINDOW_OPTIONS[windowIdx].getValue();

  const { data: projectsData, isLoading } = useQuery({
    queryKey: ["projects", since],
    queryFn: () => fetchProjects(since),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: allDriftData } = useQuery({
    queryKey: ["drift-alerts-all"],
    queryFn: () => fetchDriftAlerts(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const totalDrift = allDriftData?.alerts?.length ?? 0;

  return (
    <div className="px-6 py-6 max-w-7xl mx-auto w-full">
      {totalDrift > 0 && (
        <p className="text-xs text-red-400 font-medium mb-4">
          {totalDrift} pending drift alert{totalDrift !== 1 ? "s" : ""} across all projects
        </p>
      )}

      <div className="flex items-center gap-2 mb-6">
        <span className="text-xs text-gray-500">Show activity since:</span>
        {WINDOW_OPTIONS.map((opt, i) => (
          <button
            key={opt.label}
            onClick={() => setWindowIdx(i)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              i === windowIdx
                ? "bg-purple-600 text-white"
                : "bg-gray-800 text-gray-400 hover:text-gray-200"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-2xl p-5 h-40 animate-pulse" />
          ))}
        </div>
      ) : (
        <ProjectGrid projects={projectsData?.projects ?? []} windowLabel={WINDOW_OPTIONS[windowIdx].sublabel} />
      )}
    </div>
  );
}
