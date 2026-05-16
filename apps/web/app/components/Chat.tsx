"use client";

import { useState, useRef, useEffect } from "react";
import CitationCard from "./CitationCard";
import Changelog from "./Changelog";

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
  // project query
  content?: string;
  citations?: Citation[];
  citation_warning?: boolean;
  // temporal query
  changelog?: string;
  decisions_found?: number;
  events_found?: number;
  // shared
  latency_ms?: number;
  mode?: "project" | "temporal";
}

interface TimeRange {
  from: string;
  to: string;
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

const TEMPORAL_PATTERNS: Array<{ re: RegExp; rangeFn: () => TimeRange }> = [
  {
    re: /last\s+(\d+)\s+days?/i,
    rangeFn: () => {
      const match = /last\s+(\d+)\s+days?/i.exec(""); // placeholder, handled below
      void match;
      return { from: "", to: "" };
    },
  },
];

function detectTemporal(query: string): { isTemporal: boolean; range: TimeRange } {
  const now = new Date();
  const to = now.toISOString();

  const lastNDays = /last\s+(\d+)\s+days?/i.exec(query);
  if (lastNDays) {
    const days = parseInt(lastNDays[1]);
    return { isTemporal: true, range: { from: new Date(Date.now() - days * 86400000).toISOString(), to } };
  }

  if (/last\s+week|past\s+week/i.test(query)) {
    return { isTemporal: true, range: { from: new Date(Date.now() - 7 * 86400000).toISOString(), to } };
  }

  if (/this\s+week/i.test(query)) {
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    monday.setHours(0, 0, 0, 0);
    return { isTemporal: true, range: { from: monday.toISOString(), to } };
  }

  if (/yesterday/i.test(query)) {
    const start = new Date(now);
    start.setDate(now.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(now);
    end.setHours(0, 0, 0, 0);
    return { isTemporal: true, range: { from: start.toISOString(), to: end.toISOString() } };
  }

  if (/what.*(changed|happened|updated|new|recent)/i.test(query)) {
    return { isTemporal: true, range: { from: new Date(Date.now() - 7 * 86400000).toISOString(), to } };
  }

  // Suppress unused variable warning from the placeholder above
  void TEMPORAL_PATTERNS;

  return { isTemporal: false, range: { from: "", to } };
}

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

    const { isTemporal, range } = detectTemporal(query);

    try {
      const body = isTemporal
        ? { query, project_id: projectId.trim(), mode: "temporal", time_range: range }
        : { query, project_id: projectId.trim(), mode: "project" };

      const res = await fetch(`${API_URL}/brain/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();

      if (isTemporal) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            mode: "temporal",
            changelog: data.changelog,
            decisions_found: data.decisions_found,
            events_found: data.events_found,
            latency_ms: data.latency_ms,
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            mode: "project",
            content: data.answer,
            citations: data.citations,
            citation_warning: data.citation_warning,
            latency_ms: data.latency_ms,
          },
        ]);
      }
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
            <p>Ask anything about your repo — decisions, changes, context.</p>
            <p className="mt-2 text-gray-600">Try: "what changed last 7 days" or "what decisions were made?"</p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex flex-col gap-2 ${msg.role === "user" ? "items-end" : "items-start"}`}>
            {msg.role === "user" && (
              <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed bg-purple-600 text-white">
                {msg.content}
              </div>
            )}

            {msg.role === "assistant" && msg.mode === "temporal" && (
              <Changelog
                changelog={msg.changelog ?? ""}
                decisionsFound={msg.decisions_found ?? 0}
                eventsFound={msg.events_found ?? 0}
              />
            )}

            {msg.role === "assistant" && msg.mode !== "temporal" && (
              <>
                <div className="max-w-[85%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap leading-relaxed bg-gray-800 text-gray-100">
                  {msg.content}
                </div>
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
              </>
            )}

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
          placeholder="Ask about your repo… or 'what changed last 7 days?'"
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
