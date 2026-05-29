"use client";

import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { logSeedDecision, fetchDecisions, apiBrainQuery } from "../lib/api";

type Step = "log" | "waiting" | "ask" | "done";

export default function OnboardingLoop({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>("log");
  const [description, setDescription] = useState("");
  const [rationale, setRationale] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);
  const [question, setQuestion] = useState("");
  const [querying, setQuerying] = useState(false);
  const [answer, setAnswer] = useState<{ text: string; citations: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll until the decision appears in the feed (pipeline processed)
  useEffect(() => {
    if (step !== "waiting") return;

    timerRef.current = setInterval(() => setWaitSeconds((s) => s + 1), 1000);

    pollRef.current = setInterval(async () => {
      try {
        const data = await fetchDecisions(projectId, 1);
        if (data.decisions.length > 0) {
          clearInterval(pollRef.current!);
          clearInterval(timerRef.current!);
          setStep("ask");
          setQuestion(`Why did we decide: ${description.slice(0, 60)}?`);
        }
      } catch {
        // silent — keep polling
      }
    }, 4000);

    return () => {
      clearInterval(pollRef.current!);
      clearInterval(timerRef.current!);
    };
  }, [step, projectId, description]);

  async function handleLog(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || !rationale.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await logSeedDecision(projectId, description.trim(), rationale.trim());
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      setStep("waiting");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAsk(e: React.FormEvent) {
    e.preventDefault();
    if (!question.trim()) return;
    setQuerying(true);
    try {
      const res = await apiBrainQuery(question.trim(), projectId);
      setAnswer({ text: res.answer, citations: res.citations.length });
      setStep("done");
      await queryClient.invalidateQueries({ queryKey: ["decisions", projectId] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setQuerying(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto mt-8 flex flex-col gap-6">
      <div>
        <p className="text-sm font-medium text-gray-200">Your brain is ready.</p>
        <p className="text-xs text-gray-500 mt-1">
          Complete these three steps to see how it works — takes about 2 minutes.
        </p>
      </div>

      {/* Step 1 — Log */}
      <StepCard
        number={1}
        title="Log your first decision"
        status={step === "log" ? "active" : "done"}
      >
        {step === "log" ? (
          <form onSubmit={handleLog} className="flex flex-col gap-3 mt-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">What was decided?</label>
              <input
                className="rounded bg-gray-900 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-600"
                placeholder="e.g. Use Postgres for the primary datastore"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={submitting}
                autoFocus
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-gray-400">Why?</label>
              <input
                className="rounded bg-gray-900 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-600"
                placeholder="e.g. Team has existing expertise; strong JSON support"
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                disabled={submitting}
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting || !description.trim() || !rationale.trim()}
              className="self-start text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              {submitting ? "Logging…" : "Log decision →"}
            </button>
          </form>
        ) : (
          <p className="text-xs text-gray-400 mt-1 line-clamp-1">{description}</p>
        )}
      </StepCard>

      {/* Step 2 — Wait for pipeline */}
      <StepCard
        number={2}
        title="Brain is processing"
        status={step === "waiting" ? "active" : step === "log" ? "locked" : "done"}
      >
        {step === "waiting" && (
          <div className="mt-2 flex items-center gap-3">
            <div className="flex gap-1">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1.5 h-1.5 rounded-full bg-purple-500 animate-bounce"
                  style={{ animationDelay: `${i * 0.15}s` }}
                />
              ))}
            </div>
            <p className="text-xs text-gray-500">
              Extracting and indexing your decision… {waitSeconds > 0 ? `(${waitSeconds}s)` : ""}
            </p>
          </div>
        )}
        {(step === "ask" || step === "done") && (
          <p className="text-xs text-gray-400 mt-1">Decision indexed and queryable.</p>
        )}
      </StepCard>

      {/* Step 3 — Ask */}
      <StepCard
        number={3}
        title="Ask the brain about it"
        status={step === "ask" ? "active" : step === "done" ? "done" : "locked"}
      >
        {step === "ask" && (
          <form onSubmit={handleAsk} className="flex flex-col gap-3 mt-3">
            <input
              className="rounded bg-gray-900 border border-gray-700 px-3 py-1.5 text-sm text-gray-100 placeholder-gray-600 focus:outline-none focus:border-purple-600"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              disabled={querying}
              autoFocus
            />
            <button
              type="submit"
              disabled={querying || !question.trim()}
              className="self-start text-xs px-3 py-1.5 rounded bg-purple-700 hover:bg-purple-600 disabled:opacity-40 disabled:cursor-not-allowed text-white transition-colors"
            >
              {querying ? "Asking…" : "Ask →"}
            </button>
          </form>
        )}
        {step === "done" && answer && (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-sm text-gray-100 leading-relaxed">{answer.text}</p>
            {answer.citations > 0 && (
              <p className="text-xs text-purple-400">
                ↳ {answer.citations} citation{answer.citations !== 1 ? "s" : ""} from your logged decision
              </p>
            )}
            <p className="text-xs text-gray-500 mt-2">
              That's the brain. Now keep using Claude Code — every decision your agent logs will
              appear in the feed and be queryable like this.
            </p>
          </div>
        )}
      </StepCard>
    </div>
  );
}

function StepCard({
  number,
  title,
  status,
  children,
}: {
  number: number;
  title: string;
  status: "active" | "done" | "locked";
  children?: React.ReactNode;
}) {
  const borderColor =
    status === "active" ? "border-purple-700" :
    status === "done"   ? "border-green-900" :
                          "border-gray-800";
  const numColor =
    status === "active" ? "bg-purple-700 text-white" :
    status === "done"   ? "bg-green-900 text-green-400" :
                          "bg-gray-800 text-gray-600";
  const titleColor =
    status === "locked" ? "text-gray-600" : "text-gray-200";

  return (
    <div className={`rounded-xl border ${borderColor} bg-gray-900/60 px-4 py-3`}>
      <div className="flex items-center gap-3">
        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${numColor}`}>
          {status === "done" ? "✓" : number}
        </span>
        <span className={`text-sm font-medium ${titleColor}`}>{title}</span>
        {status === "locked" && (
          <span className="text-xs text-gray-700 ml-auto">locked</span>
        )}
      </div>
      {children}
    </div>
  );
}
