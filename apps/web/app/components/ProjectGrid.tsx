"use client";

import type { Project } from "../lib/api";
import ProjectCard from "./ProjectCard";
import EmptyBrainState from "./EmptyBrainState";

export default function ProjectGrid({ projects, windowLabel }: { projects: Project[]; windowLabel: string }) {
  if (projects.length === 0) return <EmptyBrainState />;

  const sorted = [...projects].sort(
    (a, b) =>
      b.sessions_since + b.pending_drift_count - (a.sessions_since + a.pending_drift_count)
  );

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
      {sorted.map((p) => (
        <ProjectCard key={p.project_id} project={p} windowLabel={windowLabel} />
      ))}
    </div>
  );
}
