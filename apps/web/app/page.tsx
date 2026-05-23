"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import UserMenu from "./components/UserMenu";
import ProjectGrid from "./components/ProjectGrid";
import { fetchProjects, fetchDriftAlerts } from "./lib/api";

const WINDOW_OPTIONS = [
  { label: "Today", getValue: () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); } },
  { label: "24h", getValue: () => new Date(Date.now() - 86_400_000).toISOString() },
  { label: "48h", getValue: () => new Date(Date.now() - 2 * 86_400_000).toISOString() },
  { label: "7d", getValue: () => new Date(Date.now() - 7 * 86_400_000).toISOString() },
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
    <main className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold tracking-tight shrink-0">
          purpl<span className="text-purple-400">_brain</span>
        </h1>

        <div className="flex items-center gap-3 ml-auto">
          {totalDrift > 0 && (
            <Link
              href="#"
              className="text-xs text-red-400 hover:text-red-300 font-medium transition-colors"
            >
              All pending drift ({totalDrift})
            </Link>
          )}
          <UserMenu />
        </div>
      </header>

      <div className="flex-1 px-6 py-6 max-w-7xl mx-auto w-full">
        {/* Controls */}
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
          <ProjectGrid projects={projectsData?.projects ?? []} />
        )}
      </div>
    </main>
  );
}
