"use client";

import { use, useState, useRef, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import Changelog from "../../components/Changelog";
import DriftInbox from "../../components/DriftInbox";
import SessionList from "../../components/SessionList";
import BrainHealthBadge from "../../components/BrainHealthBadge";
import DriftGraph from "../../components/DriftGraph";
import TasksPanel from "../../components/TasksPanel";
import DecisionFeed from "../../components/DecisionFeed";
import ImpactAnalyzer from "../../components/ImpactAnalyzer";
import IngestPanel from "../../components/IngestPanel";
import { fetchProjects } from "../../lib/api";
import OnboardingLoop from "../../components/OnboardingLoop";

type Tab = "decisions" | "drift" | "sessions" | "tasks" | "impact" | "ingest";

const TABS: { key: Tab; label: string }[] = [
  { key: "decisions", label: "Decisions" },
  { key: "drift", label: "Drift" },
  { key: "sessions", label: "Sessions" },
  { key: "tasks", label: "Tasks" },
  { key: "impact", label: "Impact" },
  { key: "ingest", label: "Ingest" },
];

export default function ProjectBrainView({
  params,
}: {
  params: Promise<{ project_id: string }>;
}) {
  const { project_id } = use(params);
  const projectId = decodeURIComponent(project_id);

  const [activeTab, setActiveTab] = useState<Tab>("decisions");
  const userSelectedTab = useRef(false);

  const { data: projectsData, isSuccess: projectsLoaded } = useQuery({
    queryKey: ["projects"],
    queryFn: () => fetchProjects(),
    staleTime: 30_000,
    retry: 1,
  });

  const project = projectsData?.projects.find((p) => p.project_id === projectId);
  const pendingDrift = project?.pending_drift_count ?? 0;
  const pendingTasks = project?.pending_tasks_count ?? 0;

  useEffect(() => {
    if (!userSelectedTab.current && pendingDrift > 0) {
      setActiveTab("drift");
    }
  }, [pendingDrift]);

  function selectTab(tab: Tab) {
    userSelectedTab.current = true;
    setActiveTab(tab);
  }

  return (
    <div className="flex flex-col min-h-full">
      {/* Sticky breadcrumb + stat bar + tab bar */}
      <div className="sticky top-0 z-10 bg-gray-950 border-b border-gray-800 px-6 pt-5 pb-0">
        <div className="flex items-center gap-2 text-sm mb-3">
          <Link href="/" className="text-gray-500 hover:text-gray-300 transition-colors">
            Projects
          </Link>
          <span className="text-gray-700">/</span>
          <span className="font-mono text-gray-300">{projectId}</span>
          <BrainHealthBadge lastDecisionLoggedAt={project?.last_decision_logged_at ?? null} />
          {project && (
            <span className="ml-auto text-xs text-gray-600">
              <span className="text-gray-400">{project.decision_count}</span> decisions
              {pendingDrift > 0 && (
                <span className="text-red-400 ml-3">
                  <span className="font-medium">{pendingDrift}</span> drift pending
                </span>
              )}
              {pendingTasks > 0 && (
                <span className="ml-3">
                  <span className="text-gray-400">{pendingTasks}</span> tasks open
                </span>
              )}
            </span>
          )}
        </div>


        {/* Tab bar */}
        <div className="flex items-center">
          {TABS.map(({ key, label }) => {
            const badge = key === "drift" ? pendingDrift : key === "tasks" ? pendingTasks : 0;
            const isDrift = key === "drift" && pendingDrift > 0;
            return (
              <button
                key={key}
                onClick={() => selectTab(key)}
                className={`px-4 py-2.5 text-sm font-medium transition-colors flex items-center gap-1.5 border-b-2 -mb-px ${
                  activeTab === key
                    ? "text-white border-purple-500"
                    : "text-gray-500 border-transparent hover:text-gray-300"
                }`}
              >
                {label}
                {badge > 0 && (
                  <span
                    className={`text-xs rounded-full px-1.5 py-0.5 font-mono leading-none ${
                      isDrift
                        ? "bg-red-900/50 text-red-400"
                        : "bg-gray-800 text-gray-400"
                    }`}
                  >
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Onboarding loop — shown instead of tab content when brain is cold */}
      {projectsLoaded && (project?.decision_count ?? 0) === 0 && (
        <div className="px-6">
          <OnboardingLoop projectId={projectId} />
        </div>
      )}

      {/* Tab content */}
      {(!projectsLoaded || (project?.decision_count ?? 0) > 0) && (
      <div className="px-6 py-6 flex flex-col gap-6">
        {activeTab === "decisions" && (
          <>
            {pendingDrift > 0 && (
              <div className="border border-red-900/40 rounded-xl bg-red-950/10 px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-semibold text-red-400 uppercase tracking-wide">
                    {pendingDrift} drift alert{pendingDrift !== 1 ? "s" : ""} pending
                  </span>
                  <button
                    onClick={() => selectTab("drift")}
                    className="text-xs text-red-400 hover:text-red-300 transition-colors"
                  >
                    Triage all →
                  </button>
                </div>
                <DriftInbox projectId={projectId} compact />
              </div>
            )}
            <DecisionFeed projectId={projectId} />
            <ChangelogSection projectId={projectId} />
          </>
        )}
        {activeTab === "drift" && (
          <>
            <DriftInbox projectId={projectId} />
            <DriftGraph projectId={projectId} />
          </>
        )}
        {activeTab === "sessions" && <SessionList projectId={projectId} />}
        {activeTab === "tasks" && <TasksPanel projectId={projectId} />}
        {activeTab === "impact" && <ImpactAnalyzer projectId={projectId} />}
        {activeTab === "ingest" && <IngestPanel projectId={projectId} />}
      </div>
      )}
    </div>
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
