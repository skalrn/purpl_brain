"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { logSeedDecision } from "../lib/api";

interface Props {
  projectId: string;
}

export default function SeedBrainBanner({ projectId }: Props) {
  const queryClient = useQueryClient();
  const [description, setDescription] = useState("");
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !rationale.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await logSeedDecision(projectId, description.trim(), rationale.trim());
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-lg border border-purple-800/60 bg-purple-950/30 px-5 py-4 flex flex-col gap-4">
      <div>
        <p className="text-sm font-medium text-purple-200">Brain is empty</p>
        <p className="text-xs text-gray-400 mt-0.5">
          Log one decision to seed the brain. Agent sessions will have context to build on from the start.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">What was decided?</label>
          <input
            className="rounded bg-gray-900 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-600"
            placeholder="e.g. Use Postgres for the primary datastore"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-400">Why?</label>
          <input
            className="rounded bg-gray-900 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-600"
            placeholder="e.g. Team has existing expertise; strong JSON support for our data model"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            disabled={submitting}
          />
        </div>
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={submitting || !description.trim() || !rationale.trim()}
            className="text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
          >
            {submitting ? "Logging..." : "Log seed decision"}
          </button>
          <span className="text-xs text-gray-600">
            or use{" "}
            <code className="text-gray-500">brain_log_decision</code> from an agent session
          </span>
        </div>
      </form>
    </div>
  );
}
