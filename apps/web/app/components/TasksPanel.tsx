"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchTasks } from "../lib/api";

export default function TasksPanel({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["tasks", projectId],
    queryFn: () => fetchTasks(projectId, "open"),
    staleTime: 60_000,
  });

  const tasks = data?.tasks ?? [];
  if (!isLoading && tasks.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-200 mb-3">Follow-up Tasks</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-xl divide-y divide-gray-800">
        {isLoading && (
          <div className="px-4 py-3 text-sm text-gray-600 animate-pulse">Loading…</div>
        )}
        {tasks.map((task) => (
          <div key={task.task_id} className="px-4 py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-200">{task.title}</p>
              {task.suggested_owner && (
                <p className="text-xs text-gray-500 mt-0.5">Suggested: {task.suggested_owner}</p>
              )}
            </div>
            {task.requires_approval && (
              <span className="shrink-0 inline-flex items-center rounded-full border border-amber-800 bg-amber-900/30 px-2 py-0.5 text-xs text-amber-400">
                Requires approval
              </span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
