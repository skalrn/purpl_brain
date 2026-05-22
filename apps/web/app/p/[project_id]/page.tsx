"use client";

import { use } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import UserMenu from "../../components/UserMenu";
import Chat from "../../components/Chat";
import Changelog from "../../components/Changelog";
import DriftInbox from "../../components/DriftInbox";
import SessionList from "../../components/SessionList";
import DriftBadge from "../../components/DriftBadge";
import BrainHealthBadge from "../../components/BrainHealthBadge";
import DriftGraph from "../../components/DriftGraph";
import TasksPanel from "../../components/TasksPanel";
import { fetchProjects, fetchDriftAlerts } from "../../lib/api";
import SeedBrainBanner from "../../components/SeedBrainBanner";

export default function ProjectBrainView({
  params,
}: {
  params: Promise<{ project_id: string }>;
}) {
  const { project_id } = use(params);
  const projectId = decodeURIComponent(project_id);

  const { data: projectsData } = useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(),
    staleTime: 30_000,
  });

  const { data: driftData } = useQuery({
    queryKey: ["drift-alerts", projectId],
    queryFn: () => fetchDriftAlerts(projectId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const project = projectsData?.projects.find((p) => p.project_id === projectId);
  const pendingDriftCount = driftData?.alerts?.length ?? 0;

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center gap-4">
        <Link href="/" className="text-lg font-semibold tracking-tight shrink-0">
          purpl<span className="text-purple-400">_brain</span>
        </Link>
        <span className="text-gray-600">/</span>
        <h1 className="text-sm font-mono text-gray-300 truncate flex-1">{projectId}</h1>
        <div className="flex items-center gap-2 ml-auto">
          <BrainHealthBadge lastDecisionLoggedAt={project?.last_decision_logged_at ?? null} />
          <DriftBadge count={pendingDriftCount} />
          <UserMenu />
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row gap-0 overflow-hidden">
        {/* Left column — main panels */}
        <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-6">
          {(project?.decision_count ?? 0) === 0 && (
            <SeedBrainBanner projectId={projectId} />
          )}
          <div id="drift">
            <DriftInbox projectId={projectId} />
          </div>
          <SessionList projectId={projectId} />
          <ChangelogSection projectId={projectId} />
          <DriftGraph projectId={projectId} />
          <TasksPanel projectId={projectId} />
        </div>

        {/* Right column — chat */}
        <div className="lg:w-[380px] shrink-0 border-t lg:border-t-0 lg:border-l border-gray-800 flex flex-col">
          <Chat />
        </div>
      </div>
    </main>
  );
}

function ChangelogSection({ projectId }: { projectId: string }) {
  const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

  const { data, isLoading } = useQuery({
    queryKey: ["changelog", projectId],
    queryFn: async () => {
      const API_KEY = process.env.NEXT_PUBLIC_API_KEY ?? "";
      const res = await fetch(`${API_URL}/brain/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": API_KEY },
        credentials: "include",
        body: JSON.stringify({
          query: "What changed recently?",
          project_id: projectId,
          mode: "temporal",
          time_range: {
            from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
            to: new Date().toISOString(),
          },
        }),
      });
      if (!res.ok) return null;
      return res.json() as Promise<{ changelog: string; decisions_found: number; events_found: number }>;
    },
    staleTime: 60_000,
  });

  if (isLoading) return null;
  if (!data?.changelog) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-200 mb-3">Changelog</h2>
      <Changelog
        changelog={data.changelog}
        decisionsFound={data.decisions_found}
        eventsFound={data.events_found}
      />
    </section>
  );
}
