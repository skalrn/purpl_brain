"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { fetchProjects, fetchDriftAlerts } from "../lib/api";
import DriftBadge from "./DriftBadge";

export default function LeftSidebar({
  open,
  currentProjectId,
}: {
  open: boolean;
  currentProjectId: string | null;
}) {
  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const { data: driftData } = useQuery({
    queryKey: ["drift-alerts-all"],
    queryFn: () => fetchDriftAlerts(),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const projects = projectsData?.projects ?? [];

  const driftByProject = (projectId: string) => {
    return driftData?.alerts?.filter((a) => a.project_id === projectId).length ?? 0;
  };

  if (!open) return null;

  return (
    <aside className="hidden lg:flex w-56 shrink-0 border-r border-gray-800 flex-col overflow-y-auto">
      <div className="px-3 py-4 flex flex-col gap-1">
        <p className="text-xs text-gray-600 uppercase tracking-wider font-medium px-2 mb-2">
          Projects
        </p>
        {projects.length === 0 && (
          <p className="text-xs text-gray-600 px-2 py-1">No projects yet.</p>
        )}
        {projects.map((p) => {
          const driftCount = driftByProject(p.project_id);
          const isActive = p.project_id === currentProjectId;
          return (
            <Link
              key={p.project_id}
              href={`/p/${encodeURIComponent(p.project_id)}`}
              className={`flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors ${
                isActive
                  ? "bg-purple-600/20 text-purple-300"
                  : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/60"
              }`}
            >
              <span className="truncate font-mono text-xs">{p.project_id}</span>
              <DriftBadge count={driftCount} />
            </Link>
          );
        })}
      </div>
    </aside>
  );
}
