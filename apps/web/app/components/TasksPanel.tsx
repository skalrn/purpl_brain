"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTasks } from "../lib/api";
import type { FollowUpTask } from "../lib/api";

function CodegenCopyButton({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <button
      onClick={copy}
      className="mt-2 self-start text-xs text-purple-400 hover:text-purple-200 border border-purple-800/50 rounded-lg px-2.5 py-1 transition-colors font-mono"
    >
      {copied ? "Copied ✓" : "Copy agent prompt"}
    </button>
  );
}

function TaskItem({ task }: { task: FollowUpTask }) {
  return (
    <div className="px-4 py-3 flex flex-col gap-1.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-200">{task.title}</p>
          {task.suggested_owner && (
            <p className="text-xs text-gray-500 mt-0.5">Suggested: {task.suggested_owner}</p>
          )}
          {task.description && (
            <p className="text-xs text-gray-600 mt-0.5 line-clamp-2">{task.description}</p>
          )}
        </div>
        {task.requires_approval && (
          <span className="shrink-0 inline-flex items-center rounded-full border border-amber-800 bg-amber-900/30 px-2 py-0.5 text-xs text-amber-400">
            Needs approval
          </span>
        )}
      </div>
      {task.codegen_prompt && <CodegenCopyButton prompt={task.codegen_prompt} />}
    </div>
  );
}

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
          <TaskItem key={task.task_id} task={task} />
        ))}
      </div>
    </section>
  );
}
