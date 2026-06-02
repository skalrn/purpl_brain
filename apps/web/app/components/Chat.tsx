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
  streaming?: boolean;
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

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3741";

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

export default function Chat({ projectId: propProjectId }: { projectId?: string } = {}) {
  const [inputProjectId, setInputProjectId] = useState("");
  const projectId = propProjectId ?? inputProjectId;
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [apiKey, setApiKey] = useState(process.env.NEXT_PUBLIC_API_KEY ?? "");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${API_URL}/auth/me`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.api_key) setApiKey(d.api_key); })
      .catch(() => {});
  }, []);

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
      if (isTemporal) {
        const res = await fetch(`${API_URL}/brain/query`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": apiKey },
          body: JSON.stringify({ query, project_id: projectId.trim(), mode: "temporal", time_range: range }),
        });
        const data = await res.json();
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
        return;
      }

      // Project mode — streaming
      const res = await fetch(`${API_URL}/brain/query/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query, project_id: projectId.trim() }),
      });

      if (!res.ok || !res.body) {
        throw new Error(`API error ${res.status}`);
      }

      // Add a placeholder message that we'll update token by token
      setMessages((prev) => [...prev, { role: "assistant", mode: "project", content: "", streaming: true }]);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: { type: string; text?: string; answer?: string; citations?: Citation[]; citation_warning?: boolean; latency_ms?: number; message?: string };
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue;
          }

          if (event.type === "delta" && event.text) {
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                msgs[msgs.length - 1] = { ...last, content: (last.content ?? "") + event.text };
              }
              return msgs;
            });
          } else if (event.type === "done") {
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                msgs[msgs.length - 1] = {
                  ...last,
                  content: event.answer ?? last.content,
                  citations: event.citations,
                  citation_warning: event.citation_warning,
                  latency_ms: event.latency_ms,
                  streaming: false,
                };
              }
              return msgs;
            });
          } else if (event.type === "error") {
            setMessages((prev) => {
              const msgs = [...prev];
              const last = msgs[msgs.length - 1];
              if (last?.role === "assistant") {
                msgs[msgs.length - 1] = { ...last, content: `Error: ${event.message ?? "unknown"}`, streaming: false };
              }
              return msgs;
            });
          }
        }
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

  const noProject = !propProjectId && !inputProjectId.trim();

  return (
    <div className="flex flex-col flex-1 max-w-3xl w-full mx-auto px-4 py-6 gap-4">
      {/* Message thread */}
      <div className="flex-1 flex flex-col gap-6 overflow-y-auto">
        {messages.length === 0 && (
          <div className="text-center text-gray-500 text-sm mt-16">
            {noProject ? (
              <>
                <p className="text-gray-400 font-medium">Select a project to query its brain.</p>
                <p className="text-gray-600 text-xs mt-2">
                  Choose a project from the left sidebar, then ask anything about the decisions made there.
                </p>
              </>
            ) : (
              <>
                <p>Ask about decisions your team or AI agents have made.</p>
                <div className="mt-3 flex flex-col gap-1 text-gray-600">
                  <p>&ldquo;What JWT library are we using and why?&rdquo;</p>
                  <p>&ldquo;What did the agent decide about caching last week?&rdquo;</p>
                  <p>&ldquo;What changed in the last 7 days?&rdquo;</p>
                </div>
                <p className="mt-4 text-gray-700 text-xs">
                  Also searches GitHub PRs, Jira tickets, Slack, and meeting transcripts if connected.
                </p>
              </>
            )}
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
                  {msg.streaming && (
                    <span className="inline-block w-0.5 h-4 bg-purple-400 ml-0.5 animate-pulse align-middle" />
                  )}
                </div>
                {!msg.streaming && msg.citations && msg.citations.length > 0 && (
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

        {loading && !messages.some((m) => m.streaming) && (
          <div className="flex items-start">
            <div className="bg-gray-800 rounded-2xl px-4 py-3 text-sm text-gray-400 animate-pulse">
              Thinking…
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex flex-col gap-2">
        {!propProjectId && (
          <input
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-xs text-gray-300 focus:outline-none focus:border-purple-500 placeholder-gray-600"
            placeholder="Project ID (e.g. my_org_auth_service)"
            value={inputProjectId}
            onChange={(e) => setInputProjectId(e.target.value)}
          />
        )}
        <div className="flex gap-2 items-end">
          <textarea
            className="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 resize-none focus:outline-none focus:border-purple-500 min-h-[48px] max-h-[160px] disabled:opacity-50"
            placeholder={noProject ? "Select a project first…" : "Ask about a decision, library choice, or 'what changed last 7 days?'"}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading || noProject}
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
    </div>
  );
}
