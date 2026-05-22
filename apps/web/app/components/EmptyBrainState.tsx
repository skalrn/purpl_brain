"use client";

export default function EmptyBrainState() {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center gap-4">
      <div className="w-16 h-16 rounded-full bg-gray-800 border border-gray-700 flex items-center justify-center text-2xl">
        🧠
      </div>
      <div>
        <p className="text-gray-300 font-medium">No projects in the brain yet.</p>
        <p className="text-gray-500 text-sm mt-1">
          Run a seed or log an agent session to get started.
        </p>
      </div>
      <code className="text-xs text-gray-600 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2">
        brain_log_decision(...)
      </code>
    </div>
  );
}
