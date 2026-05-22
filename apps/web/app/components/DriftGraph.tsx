"use client";

import { useState, useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactFlow, {
  type Node,
  type Edge,
  Background,
  Controls,
  MiniMap,
} from "reactflow";
import dagre from "@dagrejs/dagre";
import "reactflow/dist/style.css";
import { fetchDriftAlerts } from "../lib/api";

const NODE_W = 200;
const NODE_H = 60;

function layoutGraph(nodes: Node[], edges: Edge[]): { nodes: Node[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: "TB", ranksep: 60, nodesep: 40 });

  nodes.forEach((n) => g.setNode(n.id, { width: NODE_W, height: NODE_H }));
  edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);

  return {
    nodes: nodes.map((n) => {
      const pos = g.node(n.id);
      return { ...n, position: { x: pos.x - NODE_W / 2, y: pos.y - NODE_H / 2 } };
    }),
    edges,
  };
}

function buildGraph(
  alerts: Array<{
    alert_id: string;
    decision_id: string;
    decision_summary: string;
    content: string;
    project_id: string;
  }>
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const seenDecisions = new Set<string>();

  alerts.forEach((a) => {
    if (!seenDecisions.has(a.decision_id)) {
      seenDecisions.add(a.decision_id);
      nodes.push({
        id: a.decision_id,
        data: { label: a.decision_summary.slice(0, 60) + (a.decision_summary.length > 60 ? "…" : "") },
        position: { x: 0, y: 0 },
        style: { background: "#1e1b4b", border: "1.5px solid #818cf8", borderRadius: 8, color: "#e0e7ff", fontSize: 11 },
      });
    }

    nodes.push({
      id: `alert_${a.alert_id}`,
      data: { label: a.content.slice(0, 50) + (a.content.length > 50 ? "…" : "") },
      position: { x: 0, y: 0 },
      style: { background: "#450a0a", border: "1.5px solid #ef4444", borderRadius: 8, color: "#fca5a5", fontSize: 11 },
    });

    edges.push({
      id: `e_${a.alert_id}`,
      source: `alert_${a.alert_id}`,
      target: a.decision_id,
      label: "challenges",
      style: { stroke: "#ef4444" },
      labelStyle: { fill: "#ef4444", fontSize: 10 },
    });
  });

  return layoutGraph(nodes, edges);
}

export default function DriftGraph({ projectId }: { projectId: string }) {
  const [expanded, setExpanded] = useState(false);

  const { data } = useQuery({
    queryKey: ["drift-alerts", projectId],
    queryFn: () => fetchDriftAlerts(projectId),
    staleTime: 15_000,
  });

  const alerts = data?.alerts ?? [];

  const { nodes, edges } = useMemo(() => buildGraph(alerts), [alerts]);

  const onNodesChange = useCallback(() => {}, []);
  const onEdgesChange = useCallback(() => {}, []);

  if (alerts.length === 0) return null;

  return (
    <section>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-sm text-gray-400 hover:text-gray-200 transition-colors mb-3"
      >
        <span>{expanded ? "▾" : "▸"}</span>
        {expanded ? "Hide" : "Show"} conflict graph
      </button>

      {expanded && (
        <div className="h-80 rounded-xl border border-gray-800 overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#374151" gap={16} />
            <Controls />
            <MiniMap
              nodeColor={(n) =>
                n.style?.border?.toString().includes("818cf8") ? "#818cf8" : "#ef4444"
              }
              style={{ background: "#111827" }}
            />
          </ReactFlow>
        </div>
      )}
    </section>
  );
}
