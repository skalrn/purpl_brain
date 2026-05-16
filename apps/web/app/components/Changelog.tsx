"use client";

export default function Changelog({
  changelog,
  decisionsFound,
  eventsFound,
}: {
  changelog: string;
  decisionsFound: number;
  eventsFound: number;
}) {
  return (
    <div className="w-full bg-gray-900 border border-gray-700 rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-gray-700 bg-gray-800">
        <span className="text-purple-400 text-xs font-semibold uppercase tracking-wider">Changelog</span>
        <span className="text-gray-500 text-xs">{decisionsFound} decision{decisionsFound !== 1 ? "s" : ""}</span>
        <span className="text-gray-500 text-xs">{eventsFound} event{eventsFound !== 1 ? "s" : ""}</span>
      </div>

      {/* Content */}
      <div className="px-4 py-3 text-sm text-gray-200 leading-relaxed whitespace-pre-wrap font-mono">
        {changelog}
      </div>
    </div>
  );
}
