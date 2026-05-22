"use client";

const COLORS: Record<string, string> = {
  low:      "bg-green-900/40 text-green-400 border-green-800",
  medium:   "bg-amber-900/40 text-amber-400 border-amber-800",
  high:     "bg-orange-900/40 text-orange-400 border-orange-800",
  critical: "bg-red-900/40 text-red-400 border-red-800",
};

export default function RiskBadge({ risk }: { risk: string }) {
  const cls = COLORS[risk.toLowerCase()] ?? COLORS.medium;
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold capitalize ${cls}`}>
      {risk}
    </span>
  );
}
