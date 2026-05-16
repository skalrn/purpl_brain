"use client";

import { useState, useRef, useEffect } from "react";
import CitationCard from "./CitationCard";

interface Citation {
  chunk_id: string;
  source: string;
  source_url: string;
  actor: { type: string; id: string; name: string };
  timestamp: string;
  quoted_text: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  citations?: Citation[];
  citation_warning?: boolean;
  latency_ms?: number;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export default function Chat() {
  const [projectId, setProjectId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function sendQuery() {
    const query = input.trim();
    if (!query || !projectId.trim() || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: query }]);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/brain/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, project_id: projectId.trim(), mode: "project" }),
      });

      const data = await res.json();

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.answer,
          citations: data.citations,
          citation_warning: data.citation_warning,
          latency_ms: data.latency_ms,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Failed to reach the brain API. Is it running?" },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendQuery();
    }
  }

  return (
    <div className="flex flex-col flex-1 max-w-3xl w-full mx-auto px-4 py-6 gap-4">
      {/* Project ID input */}
      <div className="flex gap-2 items-center">
        <label className="text-sm text-gray-400 whitespace-nowrap">Project ID:</label>
        <input
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-purple-500"
          placeholder="e.g. skalrn_purplbox"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
        />
      </div>

      {/* Message thread */}
      <div className="flex-1 flex flex-col gap-6 overflow-y-auto">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 text-sm mt-16">
            Ask anything about your repo — decisions, changes, context.
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col gap-2 ${msg.role === "user" ? "items-end" : "items-start"}`}>
            {/* Bubble */}
            <div
              className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed ${
                msg.role === "user"
                  ? "bg-purple-600 text-white"
                  : "bg-gray-800 text-gray-100"
              }`}
            >
              {msg.content}
            </div>

            {/* Citations */}
            {msg.citations && msg.citations.length > 0 && (
              <div className="flex flex-col gap-2 w-full max-w-[85%]">
                {msg.citation_warning && (
                  <p className="text-xs text-yellow-400">⚠ Citation warning: some references may not be fully grounded.</p>
                )}
                {msg.citations.map((c, ci) => (
                  <CitationCard key={ci} citation={c} index={ci + 1} />
                ))}
              </div>
            )}

            {/* Latency */}
            {msg.role === "assistant" && msg.latency_ms !== undefined && (
              <p className="text-xs text-gray-600">{(msg.latency_ms / 1000).toFixed(1)}s</p>
            )}
          </div>
        ))}

        {loading && (
          <div className="flex items-start">
            <div className="bg-gray-800 rounded-2xl px-4 py-3 text-sm text-gray-400 animate-pulse">
              Thinking…
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2 items-end">
        <textarea
          className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 resize-none focus:outline-none focus:border-purple-500 min-h-[48px] max-h-[160px]"
          placeholder="Ask about your repo…"
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <button
          onClick={sendQuery}
          disabled={loading || !input.trim() || !projectId.trim()}
          className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-4 py-3 text-sm font-medium transition-colors"
        >
          Ask
        </button>
      </div>
    </div>
  );
}
