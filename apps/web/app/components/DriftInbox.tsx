"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchDriftAlerts } from "../lib/api";
import DriftBadge from "./DriftBadge";
import DriftAlertRow from "./DriftAlertRow";

export default function DriftInbox({ projectId }: { projectId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["drift-alerts", projectId],
    queryFn: () => fetchDriftAlerts(projectId),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const alerts = data?.alerts ?? [];

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-gray-200">Drift</h2>
        <DriftBadge count={alerts.length} />
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl px-4">
        {isLoading && (
          <div className="py-4 animate-pulse text-sm text-gray-600">Loading…</div>
        )}

        {!isLoading && alerts.length === 0 && (
          <div className="py-4 text-sm text-green-400">
            No pending drift. Brain is consistent.
          </div>
        )}

        {alerts.slice(0, 50).map((alert) => (
          <DriftAlertRow key={alert.alert_id} alert={alert} projectId={projectId} />
        ))}
      </div>
    </section>
  );
}
