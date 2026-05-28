"use client";

import { useState } from "react";
import { ingestTranscript, submitSignal } from "../lib/api";

const SIGNAL_SOURCES = [
  { value: "slack",    label: "Slack" },
  { value: "github",   label: "GitHub" },
  { value: "jira",     label: "Jira / Linear" },
  { value: "meeting",  label: "Meeting" },
  { value: "document", label: "Document" },
  { value: "agent",    label: "Agent" },
];

// ── Shared field primitives ──────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium text-gray-400">{children}</label>;
}

function TextInput({
  value, onChange, placeholder, disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-500 disabled:opacity-50"
    />
  );
}

function SuccessBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 bg-green-950/30 border border-green-800/50 rounded-xl px-4 py-3">
      <span className="text-green-400 text-sm shrink-0">✓</span>
      <p className="text-sm text-gray-200">{children}</p>
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 bg-gray-900 border border-amber-900/50 rounded-xl px-4 py-3">
      <span className="text-amber-500 text-sm shrink-0">⚠</span>
      <p className="text-sm text-gray-300">{message}</p>
    </div>
  );
}

// ── Transcript form ──────────────────────────────────────────────────────────

function TranscriptForm({ projectId }: { projectId: string }) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [occurredAt, setOccurredAt] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setSuccess(null);
    setError(null);
    try {
      const res = await ingestTranscript({
        project_id: projectId,
        text: trimmed,
        title: title.trim() || undefined,
        occurred_at: occurredAt || undefined,
        source_url: sourceUrl.trim() || undefined,
      });
      setSuccess(
        `${res.chunks_queued} chunk${res.chunks_queued !== 1 ? "s" : ""} queued · detected as ${res.format}` +
        (res.speakers.length > 0 ? ` · speakers: ${res.speakers.join(", ")}` : "")
      );
      setText("");
      setTitle("");
      setOccurredAt("");
      setSourceUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Ingestion failed. Is the API running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-200 mb-1">Meeting transcript</h3>
        <p className="text-xs text-gray-500">
          Paste VTT, SRT, or plain-text transcripts. The brain auto-detects format, resolves speakers to Person nodes,
          and chunks the content for semantic search.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Title (optional)</Label>
          <TextInput
            value={title}
            onChange={setTitle}
            placeholder="e.g. Sprint planning 2026-05-25"
            disabled={loading}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Date / time (optional)</Label>
          <input
            type="datetime-local"
            value={occurredAt}
            onChange={(e) => setOccurredAt(e.target.value ? new Date(e.target.value).toISOString() : "")}
            disabled={loading}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500 disabled:opacity-50"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Source URL (optional — used for deduplication)</Label>
        <TextInput
          value={sourceUrl}
          onChange={setSourceUrl}
          placeholder="https://meet.google.com/…  or  notion.so/…"
          disabled={loading}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Transcript text *</Label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading}
          placeholder={"WEBVTT\n\n00:00:01.000 --> 00:00:05.000\nAlice: Let's go with Postgres for session storage.\n\n…or paste plain text"}
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-xs text-gray-200 resize-none focus:outline-none focus:border-purple-500 min-h-[160px] font-mono placeholder-gray-700 disabled:opacity-50"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={loading || !text.trim()}
          className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-5 py-2 text-sm font-medium transition-colors"
        >
          {loading ? "Ingesting…" : "Ingest transcript"}
        </button>
        {text && !loading && (
          <span className="text-xs text-gray-600">{text.trim().length} chars</span>
        )}
      </div>

      {success && <SuccessBanner>{success}</SuccessBanner>}
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

// ── Signal form ──────────────────────────────────────────────────────────────

function SignalForm({ projectId }: { projectId: string }) {
  const [text, setText] = useState("");
  const [source, setSource] = useState("slack");
  const [actorName, setActorName] = useState("");
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState<{ alerts: number; matched: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = text.trim();
    const actor = actorName.trim();
    if (!trimmed || !actor || loading) return;
    setLoading(true);
    setSuccess(null);
    setError(null);
    try {
      const res = await submitSignal({
        project_id: projectId,
        text: trimmed,
        source,
        actor_id: actor.toLowerCase().replace(/\s+/g, "-"),
        actor_name: actor,
        url: url.trim() || undefined,
      });
      setSuccess({ alerts: res.drift_alerts_created, matched: res.matched_decisions });
      setText("");
      setUrl("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Signal submission failed. Is the API running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-gray-200 mb-1">Manual signal</h3>
        <p className="text-xs text-gray-500">
          Submit an observation, finding, or piece of information. It will be matched against existing confirmed
          decisions — drift alerts are created for any contradictions found.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Source</Label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value)}
            disabled={loading}
            className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-gray-100 focus:outline-none focus:border-purple-500 disabled:opacity-50"
          >
            {SIGNAL_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Your name *</Label>
          <TextInput
            value={actorName}
            onChange={setActorName}
            placeholder="e.g. Alice Chen"
            disabled={loading}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Source URL (optional)</Label>
        <TextInput
          value={url}
          onChange={setUrl}
          placeholder="Link to the Slack message, PR, or document"
          disabled={loading}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Signal text *</Label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={loading}
          placeholder={"e.g. The vendor confirmed Auth0 free tier is being discontinued in Q3 — affects our auth decision.\ne.g. Benchmark shows Redis pub/sub has 2× latency vs Kafka at our message volume."}
          className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-200 resize-none focus:outline-none focus:border-purple-500 min-h-[100px] placeholder-gray-600 disabled:opacity-50"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={submit}
          disabled={loading || !text.trim() || !actorName.trim()}
          className="bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white rounded-xl px-5 py-2 text-sm font-medium transition-colors"
        >
          {loading ? "Submitting…" : "Submit signal"}
        </button>
      </div>

      {success && (
        <SuccessBanner>
          {success.matched === 0
            ? "Signal recorded. No existing decisions matched."
            : `Signal matched ${success.matched} decision${success.matched !== 1 ? "s" : ""} — ${
                success.alerts > 0
                  ? `${success.alerts} drift alert${success.alerts !== 1 ? "s" : ""} created.`
                  : "no new drift alerts (already resolved or not contradictory)."
              }`}
        </SuccessBanner>
      )}
      {error && <ErrorBanner message={error} />}
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export default function IngestPanel({ projectId }: { projectId: string }) {
  return (
    <div className="flex flex-col gap-10">
      <TranscriptForm projectId={projectId} />
      <div className="border-t border-gray-800" />
      <SignalForm projectId={projectId} />
    </div>
  );
}
