"use client";

import { Code2, Database, Radio, Bot } from "lucide-react";

const CONFIG = {
  coding: { icon: Code2, label: "Coding", color: "text-purple-400" },
  infra:  { icon: Database, label: "Infra", color: "text-amber-400" },
  other:  { icon: Bot, label: "Other", color: "text-gray-400" },
} as const;

export default function AgentTypeBadge({
  type,
}: {
  type: "coding" | "infra" | "other";
}) {
  const { icon: Icon, label, color } = CONFIG[type] ?? CONFIG.other;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-medium ${color}`}>
      <Icon size={13} />
      {label}
    </span>
  );
}
