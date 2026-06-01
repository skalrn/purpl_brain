"use client";

const STEPS = [
  {
    n: "1",
    title: "Start the brain",
    code: "docker compose up -d",
    note: "Spins up Neo4j, Qdrant, Redis, and the API",
  },
  {
    n: "2",
    title: "Connect your agent",
    code: `{
  "purpl-brain": {
    "command": "node",
    "args": ["/path/to/purpl_brain/apps/mcp/dist/index.js"],
    "env": {
      "BRAIN_API_URL": "http://localhost:3741",
      "BRAIN_API_KEY": "your-api-key",
      "BRAIN_AGENT_ID": "claude-code",
      "BRAIN_OPERATOR_NAME": "Your Name"
    }
  }
}`,
    note: "Add to ~/.claude/settings.json → mcpServers",
    multiline: true,
  },
  {
    n: "3",
    title: "Log a decision from your agent session",
    code: "brain_log_decision(...)",
    note: "The brain starts tracking from here — decisions appear immediately",
  },
];

export default function EmptyBrainState() {
  return (
    <div className="flex flex-col items-center py-16 px-4 gap-8 max-w-xl mx-auto">
      <div className="text-center">
        <div className="w-14 h-14 rounded-2xl bg-purple-900/30 border border-purple-800/40 flex items-center justify-center text-2xl mx-auto mb-4">
          🧠
        </div>
        <p className="text-gray-200 font-semibold text-base">No projects yet</p>
        <p className="text-gray-500 text-sm mt-1">
          Connect an agent and log a decision to get started.
        </p>
      </div>

      <div className="w-full flex flex-col gap-4">
        {STEPS.map((step) => (
          <div key={step.n} className="flex gap-4">
            <div className="shrink-0 w-6 h-6 rounded-full bg-purple-900/40 border border-purple-800/50 flex items-center justify-center text-xs text-purple-400 font-medium mt-0.5">
              {step.n}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-gray-300 font-medium mb-1.5">{step.title}</p>
              <code
                className={`block text-xs text-gray-400 bg-gray-900 border border-gray-800 rounded-lg px-3 py-2 ${
                  step.multiline ? "whitespace-pre overflow-x-auto" : ""
                }`}
              >
                {step.code}
              </code>
              <p className="text-xs text-gray-600 mt-1">{step.note}</p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-gray-600 text-center">
        Agents can also write directly via the REST API at <span className="font-mono">POST /brain/agent-log</span>
      </p>
    </div>
  );
}
