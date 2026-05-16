"use client";

import { useState } from "react";

interface Citation {
  chunk_id: string;
  source: string;
  source_url: string;
  actor: { type: string; id: string; name: string };
  timestamp: string;
  quoted_text: string;
}

export default function CitationCard({ citation, index }: { citation: Citation; index: number }) {
  const [expanded, setExpanded] = useState(false);

  const date = new Date(citation.timestamp).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-xl overflow-hidden text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-gray-800 transition-colors"
      >
        <span className="text-purple-400 font-mono font-semibold">[{index}]</span>
        <span className="text-gray-300 truncate flex-1">{citation.source_url}</span>
        <span className="text-gray-500 whitespace-nowrap">{date}</span>
        <span className="text-gray-500">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 flex flex-col gap-2 border-t border-gray-700 pt-2">
          <p className="text-gray-400">
            <span className="text-gray-500">Author:</span> {citation.actor.name}
          </p>
          <p className="text-gray-300 italic leading-relaxed">"{citation.quoted_text}"</p>
          <a
            href={citation.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-purple-400 hover:text-purple-300 underline"
          >
            Open source →
          </a>
        </div>
      )}
    </div>
  );
}
