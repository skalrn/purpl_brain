"use client";

interface Props {
  decisionCount: number;
  decisionsWithAlternatives: number;
  inline?: boolean;
}

function computeQuality(
  decisionCount: number,
  decisionsWithAlternatives: number
): "green" | "amber" | null {
  if (decisionCount === 0) return null;
  // green: all decisions include alternatives (richest sessions)
  if (decisionsWithAlternatives === decisionCount) return "green";
  // amber: NO decisions include alternatives (completely bare — worth noting)
  if (decisionsWithAlternatives === 0) return "amber";
  // middle ground (some have alternatives): no badge — not actionable
  return null;
}

const DOT_COLORS = {
  green: "bg-green-500",
  amber: "bg-amber-500",
};

const LABEL_COLORS = {
  green: "text-green-400",
  amber: "text-amber-400",
};

export default function WriteBackQualityBadge({ decisionCount, decisionsWithAlternatives, inline }: Props) {
  const quality = computeQuality(decisionCount, decisionsWithAlternatives);
  if (!quality) return null;

  const hintText =
    quality === "green"
      ? "All decisions include alternatives considered"
      : "No decisions include alternatives considered";

  if (inline) {
    return (
      <span className={`text-xs ${LABEL_COLORS[quality]}`}>
        Quality: {hintText}
      </span>
    );
  }

  return (
    <span
      title={hintText}
      className="inline-flex items-center"
    >
      <span className={`w-2 h-2 rounded-full ${DOT_COLORS[quality]} inline-block`} />
    </span>
  );
}
