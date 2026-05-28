"use client";

import { useState } from "react";
import { analyzeImpact, type ImpactResponse, type ImpactDecision, type ImpactTask } from "../lib/api";

const RISK_STYLES: Record<string, { pill: string; bar: string }> = {
  critical: { pill: "text-red-400 border-red-800 bg-red-950/30",    bar: "bg-red-600" },
  high:     { pill: "text-orange-400 border-orange-800 bg-orange-950/30", bar: "bg-orange-500" },
  medium:   { pill: "text-yellow-400 border-yellow-800 bg-yellow-950/30", bar: "bg-yellow-500" },
  low:      { pill: "text-green-400 border-green-800 bg-green-950/30",  bar: "bg-green-600" },
};

function RiskPill({ risk }: { risk: string }) {
  const s = RISK_STYLES[risk] ?? RISK_STYLES.low;
  return (
    <span className={`text-xs font-mono capitalize border rounded-full px-2.5 py-0.5 ${s.pill}`}>
      {risk} risk
    </span>
  );
}

function TicketRow({ ticket }: { ticket: ImpactTask }) {
  const s = RISK_STYLES[ticket.risk_tier] ?? RISK_STYLES.low;
  return (
    <div className="flex items-start gap-3 py-2">
      <span className={`mt-0.5 shrink-0 text-xs font-mono border rounded-full px-2 py-0.5 ${s.pill}`}>
        {ticket.risk_tier}
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {ticket.jira_url ? (
            <a
              href={ticket.jira_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-mono text-blue-400 hover:text-blue-300 transition-colors"
            >
              {ticket.ticket_ref} ↗
            </a>
          ) : (
            <span className="text-xs font-mono text-gray-400">{ticket.ticket_ref}</span>
          )}
          {ticket.jira_summary && (
            <span className="text-xs text-gray-400 truncate">{ticket.jira_summary}</span>
          )}
          {ticket.jira_assignee && (
            <span className="text-xs text-gray-600">→ {ticket.jira_assignee}</span>
          )}
        </div>
        <p className="text-xs text-gray-500 mt-0.5">{ticket.reason}</p>
      </div>
    </div>
  );
}

function DecisionImpactCard({ decision }: { decision: ImpactDecision }) {
  const [open, setOpen] = useState(false);
  const hasTickets = decision.affected_tickets.length > 0;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full px-4 py-3 flex items-start gap-3 text-left hover:bg-gray-800/50 transition-colors"
      >
        <span className="mt-0.5 text-gray-600 text-xs shrink-0">{open ? "▾" : "▸"}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-100">{decision.summary}</p>
          {decision.rationale && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{decision.rationale}</p>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-2">
          {hasTickets && (
            <span className="text-xs text-gray-500 font-mono">
              {decision.affected_tickets.length} ticket{decision.affected_tickets.length !== 1 ? "s" : ""}
            </span>
          )}
          <span className={`text-xs font-mono border rounded-full px-2 py-0.5 ${
            decision.status === "confirmed" ? "text-green-400 border-green-900" : "text-gray-400 border-gray-700"
          }`}>
            {decision.status}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-gray-800 px-4 pb-3">
          {hasTickets ? (
            <div className="divide-y divide-gray-800/60">
              {decision.affected_tickets.map((t) => (
                <TicketRow key={t.ticket_ref} ticket={t} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-600 py-3">No linked tickets found for this decision.</p>
          )}
        </div>
      )}
    </div>
  );
}

function ResultView({ result }: { result: ImpactResponse }) {
  const s = RISK_STYLES[result.overall_risk] ?? RISK_STYLES.low;
  return (
    <div className="flex flex-col gap-6">
      {/* Overall risk banner */}
      <div className={`flex items-start gap-4 p-4 rounded-xl border ${s.pill}`}>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <RiskPill risk={result.overall_risk} />
            <span className="text-xs text-gray-500">{(result.latency_ms / 1000).toFixed(1)}s</span>
          </div>
          <p className="text-sm text-gray-200">{result.summary}</p>
        </div>
      </div>

      {/* Affected decisions */}
      {result.affected_decisions.length === 0 ? (
        <p className="text-sm text-green-400">No existing decisions are affected by this change.</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-gray-500 font-medium">
            {result.affected_decisions.length} decision{result.affected_decisions.length !== 1 ? "s" : ""} affected
            — click to expand tickets
          </p>
          {result.affected_decisions.map((d) => (
            <DecisionImpactCard key={d.decision_id} decision={d} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function ImpactAnalyzer({ projectId }: { projectId: string }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImpactResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAnalysis() {
    const desc = input.trim();
    if (!desc || loading) return;
    setLoading(true);
    setResult(null);
    setError(null);
    try {
      const res = await analyzeImpact(projectId, desc);
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed. Is the API running?");
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      runAnalysis();
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Input */}
      <div className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-gray-200 mb-1">Impact Analyzer</h2>
          <p className="text-xs text-gray-500">
            Describe a change you&apos;re considering. The brain will traverse the graph and return every
            existing decision and ticket that may be affected, with a risk tier for each.
          </p>
        </div>
        <textarea
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-100 resize-none focus:outline-none focus:border-purple-500 min-h-[96px] placeholder-gray-600 disabled:opacity-50"
          placeholder={`e.g. "Migrate session storage from Redis to PostgreSQL"\ne.g. "Switch authentication library from Passport.js to Auth.js"\ne.g. "Replace REST with GraphQL for the public API"`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={loading}
        />
        <div className="flex items-center gap-3">
          <button
            onClick={runAnalysis}
            disabled={loading || !input.trim()}
            className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-5 py-2 text-sm font-medium transition-colors"
          >
            {loading ? "Analyzing…" : "Analyze impact"}
          </button>
          <span className="text-xs text-gray-600">⌘ + Enter</span>
          {result && !loading && (
            <button
              onClick={() => { setResult(null); setInput(""); }}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors ml-auto"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl p-4 h-16 animate-pulse" />
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="bg-gray-900 border border-amber-900/50 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-amber-500 text-sm">⚠</span>
          <p className="text-sm text-gray-300">{error}</p>
        </div>
      )}

      {/* Result */}
      {result && !loading && <ResultView result={result} />}
    </div>
  );
}
