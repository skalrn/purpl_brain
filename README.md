# purpl-brain

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-blue)](https://modelcontextprotocol.io)
[![Works with Claude Code](https://img.shields.io/badge/Claude_Code-Compatible-blueviolet)](https://claude.ai/code)
[![Docker](https://img.shields.io/badge/Docker-Required-2496ED?logo=docker&logoColor=white)](https://docker.com)

**A decision memory designed to catch contradictions before your agents ship them.**

**Stack:** TypeScript · Node.js · Neo4j · Qdrant · Redis Streams · Docker · MCP  
**Scope:** REST API · 4 async workers · MCP server · Next.js web UI · 5 ingestion connectors — solo-built

**→ [Jump to Quick Start](#quick-start)** if you want to try it first.

purpl-brain is a shared decision memory for codebases worked on by multiple independent coding agents (refactor agents, feature agents, dependency upgraders) across separate sessions.

Four operations: agents log decisions as they make them, query past decisions across any agent or session, check the impact of a proposed change against what was previously decided, and signal when a finding contradicts an existing decision. Decisions logged by agents carry rationale, attribution, and confidence, retrievable by any other agent via MCP or REST.

When an incoming signal contradicts a prior decision, the brain writes a drift alert and can deliver it via webhook in real time. Agents see it on the next query or impact check.

It also ingests human-generated knowledge (GitHub PRs, repo documentation, meeting transcripts) so queries draw on more than what agents logged. GitHub and Slack ingestion is implemented; decision extraction yield from conversational threads is lower than from structured sources like ADRs.

---

## The problem

When multiple agents work on the same codebase across separate sessions, decisions made mid-session don't carry across to the next agent. A refactor agent makes a solid architectural call. A dependency upgrader reverses it a week later, having never seen it.

That is the validated use case: agent-vs-agent decision contradiction across sessions. In the scripted scenarios, the guardrail works consistently for agent-generated decisions today.

The longer-term target is agent-vs-team contradictions: decisions your team made in Slack threads, PR comments, and design reviews that agents can't see. That layer is partially implemented; decision extraction yield from conversational prose is low. It is the open engineering work, not the day-one use case.

The contradiction problem is worse than the rediscovery problem. Rediscovery wastes time. A contradiction that makes it into code can break a system, fail an audit, or invalidate work a parallel agent just completed.

---

## The guardrail

`brain_analyze_impact` is the primary use case.

Before an agent makes a significant architectural change, it calls the brain with a plain-English description of what it's about to do. The brain checks the decision graph for contradictions, downstream dependencies, and open drift alerts, and returns a risk assessment with citations.

```
Agent: "Replace the Redis cache with an in-memory LRU — removes the write-through pattern"
Brain: risk=high · 3 decisions affected · 1 open drift alert
       · cache-001: Redis caching adopted 3 weeks ago, TTL 60s write-through [agent session]
       · cache-003: ioredis chosen over node-redis for cluster support [agent session]
       · refactor-001: @acme/cache package extraction in progress — merging now makes this dead work [RefactorAgent]
```

The agent reads this before writing a line of code. It either adjusts the approach, escalates, or logs a superseding decision with rationale. The contradiction doesn't ship.

This works because the graph has structural links (SUPERSEDES edges, CHALLENGES relationships) that survive across sessions and agents without any of that history being passed in the current context window. RAG retrieves by similarity; the graph retrieves by structure. The two failure modes are different.

### What the eval showed

A four-agent scenario (caching architecture migration, Slack signal, GitHub PR contradicting the ADR, parallel agents mid-flight) tested the guardrail end-to-end:

- `brain_analyze_impact` surfaced the ioredis and cache key decisions before RefactorAgent acted ✓
- Slack and GitHub signals triggered a confirmed DriftAlert linking to two affected decisions in the graph ✓
- SecurityAuditAgent found the alert mid-task and logged a pivot decision before completing the audit ✓
- PRReviewAgent blocked a PR using cross-agent context — it saw RefactorAgent's in-progress package extraction without that context being passed in ✓
- DependencyUpgradeAgent acted in the drift zone without re-querying — correctly flagged as non-compliant ✓

**58/58 checks passed.** End-to-end, 225 seconds, four agents, one contradiction scenario. Scripted test cases with seeded decisions — verifies the mechanism works under controlled conditions, not against real team decision histories.

---

## How it works on day one

The guardrail works immediately, without seeding historical context.

**Step 1 — Agents log decisions as they make them.**

```
brain_log_decision({
  session_id: "sess_refactor_001",
  project_id: "acme-payments",
  decisions: [{
    id: "cache-001",
    description: "Adopt Redis as the primary caching layer — TTL 60s, write-through",
    rationale: "Redis is already in the stack for job queues. Write-through ensures cache consistency with Postgres.",
    alternatives_considered: ["Memcached", "in-process LRU only"],
    confidence: "high"
  }]
})
```

**Step 2 — The next agent calls `brain_analyze_impact` before acting.**

Any agent in any session, hours or weeks later, checks the brain before a significant change. The structural graph link means the brain finds the contradiction even if no similarity search would have co-retrieved both decisions.

**Step 3 — Drift alerts fire when signals contradict existing decisions.**

When a Slack message, GitHub PR, or agent signal contradicts a prior decision, the drift detector surfaces a confirmed alert. Agents query it at session start. The alert is visible in the web UI. A webhook delivers it to Slack or a coordinator agent in real time.

That is the full loop. It runs on agent write-back alone. No ADR seeding, no GitHub connector, no Slack listener required to start. Those layers make the guardrail stronger. They are not prerequisites.

---

## Where this goes: the complete decision graph

The guardrail on day one covers agent-vs-agent contradictions. The long-term target is agent-vs-everything contradictions, including decisions your team made before the agents were involved.

Most architectural decisions don't live in ADRs. They live in a Slack thread that ended without a summary, a PR review comment that was resolved without a follow-up, a design review meeting nobody wrote up because it felt like an implementation detail. Those decisions still determine how the codebase behaves. And they are invisible to agents.

The full product feeds all of those surfaces into the same graph:

| Source | Status | What it adds |
|--------|--------|-------------|
| Agent write-back (`brain_log_decision`) | **Working** | Agent decisions, immediate, structured |
| ADRs and local docs | **Working** | Formal decision history, seedable on onboarding |
| GitHub PRs and issues | **Partial** — signal ingestion works; decision extraction yield is low on conversational PRs | Human trail, PR-level attribution |
| Slack messages | **Partial** — real-time listener works; thread replies and downstream decision extraction have known gaps | Where informal decisions actually happen |
| Meeting transcripts | **Working** — REST ingest endpoint | Design reviews, verbal decisions |

The value proposition when the graph is complete: a new agent session loads three weeks of Slack architecture debates, six ADRs, and twelve agent sessions (cited, attributed, searchable) and the guardrail covers all of it. Not just what the agents decided.

---

## Real numbers

Measured against the builder's own eval suite, not independently verified. All scenarios are synthetic: decisions are seeded programmatically, contradictions are planted, and agent sessions are simulated. These evals verify that the mechanism works correctly under controlled conditions. They do not measure performance against real team decision histories.

In a production setting, these evals are preconditions for rollout, not proof of production readiness. The next step would be live monitoring on drift alert volume and false positive rate against real team decision histories.

### Guardrail scenario ([`eval:multi-agent`](apps/api/src/scripts/eval/eval-multi-agent.ts))

Four agents, one caching architecture migration, one Slack signal, one GitHub PR contradiction, one non-compliant agent. Full end-to-end scenario with pipeline propagation and drift detection.

**58/58 checks passed.** 225 seconds total.

Key assertions: impact analysis found affected decisions before agent acted; drift alert fired and linked to two graph nodes; SecurityAuditAgent pivoted mid-task on alert discovery; PRReviewAgent blocked PR using cross-agent context; non-compliant agent correctly detected.

### Cross-session recall ([`eval:cross-session`](apps/api/src/scripts/eval/eval-cross-session.ts))

Five decisions logged by three different agents (claude-code, cursor, windsurf) over a simulated three-week window. Fresh session, no prior context, no history passed in.

**5/5 queries recalled correctly (100%).** Target: ≥80%. p50 latency 3.8s, p95 6.9s.

### Agentic value-add ([`eval:agent-value`](apps/api/src/scripts/eval/eval-agent-value.ts))

A/B comparison: same model, same 3 tasks, same LLM judge. The only difference is ~400 tokens of brain context injected before dispatch.

| Metric | Cold start | Brain-assisted | Delta |
|---|---|---|---|
| Decision alignment rate | 17% (1/6) | **100% (6/6)** | +5 decisions |
| Contradiction rate | 67% (4/6) | **0% (0/6)** | −4 contradictions |

Without context the agent picked the wrong validation library, wrong rate limiting layer, wrong error format, and wrong auth approach on 4 of 6 relevant decisions. With brain context, all 6 were correct. Caveat: several seeded decisions (JWT auth, Zod validation, RFC 7807 error format) are established best practices the model may already lean toward; the delta may partially reflect model priors, not brain context alone.

### Pipeline and retrieval

| Eval | Result | What it measures |
|---|---|---|
| Pipeline correctness | **33/33 PASS** | Full pipeline: ingestion → extraction → graph integrity → query → drift detection |
| MCP tool correctness | **8/8 PASS** | All 4 MCP tools verified against REST API equivalents |
| Drift detection recall | **≥80%** | Known contradictions caught; target precision ≥70% (<30% false positive rate on noise) |
| Citation faithfulness | **0 fabricated** | Every cited source_url and quoted_text verified against source documents |
| Query latency p50 / p95 | **13.6s / 27.8s** | Ollama local; ~2s on cloud API |

---

## How it works

```
Signal sources: agent sessions · ADRs · GitHub PRs · Slack · meeting transcripts
  │
  ▼  normalizer (rule-based schema normalisation — no LLM)
  ▼  extractor (LLM: extract decisions, people, tickets, linked PR threads)
  │
  ├──▶  brain-writer ──▶  Neo4j (graph) + Qdrant (vectors)
  └──▶  drift-detector ──▶  DriftAlert nodes + webhook notification

Agent session (brain_log_decision)
  └──▶  bypass extractor ──▶  directly into the brain (no pipeline delay)

brain_analyze_impact
  └──▶  embed → Qdrant ANN search → Neo4j graph expand → risk assessment with citations

brain_query
  └──▶  embed → Qdrant ANN search → Neo4j graph expand → LLM answer with citations
```

**Why two databases:** Qdrant finds semantically related chunks. Neo4j expands from those entry points through structural links (SUPERSEDES edges, CHALLENGES relationships, EXTRACTED_FROM provenance). Qdrant retrieves by similarity. Neo4j retrieves by structure. The guardrail needs both: similarity to find candidates, structure to trace contradictions across sessions that similarity search would never co-retrieve.

---

## The four MCP tools

Add purpl-brain to Claude Code. Four tools become available in every session:

| Tool | When to call |
|------|-------------|
| `brain_query` | **Session start — every session.** Recall prior decisions, open drift alerts, and what prior agents already figured out. |
| `brain_analyze_impact` | **Before a significant change.** Check which prior decisions your change affects. This is the guardrail — call it before writing the code, not after. |
| `brain_log_decision` | **When a decision is made — mid-session, not just at close.** Log what you decided, what you rejected, and why. The rationale is what makes the next session's impact analysis useful. |
| `brain_log_signal` | When you find something unexpected — report a finding that may contradict an existing decision. |

Four tools, not fifty-three. Intentional. A smaller, opinionated surface is much easier to adopt and govern. The discipline is the product. Decisions logged explicitly are precise, attributed, and queryable. Decisions captured automatically from session history are noise.

**CLAUDE.md instructions are aspirational. Hooks are deterministic.** Under context pressure (long sessions, compaction events), agents make judgment calls about what counts as significant, and those calls degrade with less context. The Stop hook in `.claude/hooks/` solves this at the boundary: it checks for decisions logged in the last two hours and blocks the session from closing if none are found. The agent reads the message, calls `brain_log_decision`, and the hook clears.

---

## Quick start

Two paths: **pre-built images** (fastest, no Node.js required, MCP included) or **build from source** (connect to your own project).

---

### Option A — Pre-built images (no Node.js required)

**Prerequisites:** Docker Desktop, [Ollama](https://ollama.ai) with `llama3.1:8b` and `nomic-embed-text:v1.5` pulled

#### Try the demo (2 minutes, zero config)

```bash
curl -O https://raw.githubusercontent.com/skalrn/purpl_brain/main/docker-compose.demo.yml

# Ollama (default, ~14s queries):
docker compose -f docker-compose.demo.yml up

# Anthropic (~2s queries) — alternative to the line above:
ANTHROPIC_API_KEY=sk-ant-... LLM_PROVIDER=anthropic docker compose -f docker-compose.demo.yml up
```

No `.env`, no seed commands. Pre-loaded with **Orion Commerce** — a synthetic e-commerce dataset (fictional company, fictional people, realistic decisions). API key: `demo-key` · Project ID: `orion_commerce` · MCP on port 3742.

#### Connect your own project (~5 minutes)

```bash
curl -O https://raw.githubusercontent.com/skalrn/purpl_brain/main/setup-prebuilt.sh
bash setup-prebuilt.sh
```

`setup-prebuilt.sh` generates credentials, writes `.env`, downloads the Claude Code Stop hooks into `~/.claude/hooks/` (scripts that run when a Claude Code session ends and prompt the agent to log decisions if it hasn't), starts all services, and prints a ready-to-paste MCP config and CLAUDE.md snippet. No Node.js needed.

- **Port conflict:** if 3742 is busy: `MCP_HOST_PORT=3743 docker compose -f docker-compose.prod.yml up -d`

  Then use `http://localhost:3743/mcp` in your `~/.claude/settings.json`.

---

### Option B — Build from source

**Prerequisites:** Docker Desktop, Node.js 20+, [Ollama](https://ollama.ai) with `llama3.1:8b` and `nomic-embed-text:v1.5` pulled

```bash
git clone https://github.com/skalrn/purpl_brain
cd purpl_brain
bash setup.sh
```

`setup.sh` writes `.env`, builds the MCP server, starts all services via `docker compose`, and prints a ready-to-paste MCP config and CLAUDE.md snippet.

> **Ollama latency:** queries take ~14s (p50) to ~28s (p95). Normal — the LLM is running locally. Switch to `LLM_PROVIDER=anthropic` in `apps/api/.env` for ~2s responses.

---

## First 10 minutes

### If you used Option A (pre-built demo)

Data is already loaded — no need to seed anything. The brain is pre-populated with **Orion Commerce**, a synthetic e-commerce engineering team (fictional company, fictional people, realistic decisions). Open **http://localhost:3740** and try these queries:

- `"Why does the order confirmation email require both payment and inventory?"`
- `"What did Priya decide about refunds?"`
- `"What changed in the order management approach over the last two months?"`
- `"Show me open drift alerts"`

You should see cited answers with source attribution. That's the core loop working.

**API key:** `demo-key` · **Project ID:** `orion_commerce`

---

### If you used Option B (build from source)

Verify the core loop: log a decision, wait for the pipeline, query it back with a cited answer.

**Single command (fastest):**

```bash
API_KEY=$(grep DEV_API_KEY apps/api/.env | cut -d= -f2)
BRAIN_API_KEY=$API_KEY npm run demo:agent-memory -w apps/api
```

This logs a JWT library decision, waits for the pipeline, queries it back, and prints `PASS`. Ollama: ~60–90s. Anthropic: ~15s.

**Web UI:**

Open **http://localhost:3740** and follow the three-step onboarding loop.

1. **Log a decision** — fill in what was decided and why, click **Log decision →**
2. **Wait for the pipeline** — Ollama: ~60–90s · Anthropic: ~15s. The UI polls automatically.
3. **Ask the brain** — submit the pre-filled query. You should see a prose answer with citations.

**curl:**

```bash
API_KEY=$(grep DEV_API_KEY apps/api/.env | cut -d= -f2)
PROJECT=$(grep DEFAULT_PROJECT_ID apps/api/.env | cut -d= -f2)

curl -s -X POST http://localhost:3741/brain/agent-log \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "{
    \"session_id\": \"first-test\",
    \"project_id\": \"$PROJECT\",
    \"agent_id\": \"me\",
    \"work_completed\": \"Chose Redis over Memcached for session cache\",
    \"decisions\": [{
      \"id\": \"session-cache\",
      \"description\": \"Use Redis for session cache, not Memcached\",
      \"rationale\": \"TTL-native eviction and pub/sub for cache invalidation. Memcached requires a separate eviction job.\",
      \"alternatives_considered\": [\"Memcached\", \"in-memory LRU\"],
      \"confidence\": \"high\"
    }]
  }"

# Wait ~60–90s (Ollama) or ~15s (Anthropic), then:
curl -s -X POST http://localhost:3741/brain/query \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d "{\"query\": \"what was decided about the cache layer?\", \"project_id\": \"$PROJECT\"}" \
  | python3 -m json.tool
```

A response with `citations` and `answer` is the core loop working. If `citations` is empty, the pipeline is still processing — wait 30s and retry.

---

## What to seed first

**Seed an internal project, not a public one.** If you seed a well-known framework (React, Hono, Next.js), the LLM already knows those decisions from training data — the brain adds nothing. Seed your own private repo where the decisions are novel to the model.

**Decision-rich events beat raw activity.** PRs with long review threads, Slack channels where architecture is debated, meeting transcripts from design reviews — these yield decisions the extractor can find. Routine merge commits and trivial fixes yield nothing.

In practice, twenty well-chosen decisions from an internal project are likely to outperform two hundred events from a public repo the model already knows.

---

## Wiring the MCP server

**If you used `docker-compose.demo.yml` (pre-built image):** the MCP server is already running on port 3742 (or whichever port you set via `MCP_HOST_PORT`). Paste into `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "purpl-brain": {
      "url": "http://localhost:3742/mcp"
    }
  }
}
```

Then add this to `CLAUDE.md` in whichever repo you want to use the brain from:

```markdown
## Brain (purpl-brain MCP)

The purpl-brain MCP is connected.

- **Project ID:** `orion_commerce` (the pre-loaded demo) — or create your own by logging
  decisions with a new `project_id`. Any project ID you write to becomes queryable immediately.
- **Session start:** call `brain_query` to recall prior decisions and open drift alerts.
- **Before a significant change:** call `brain_analyze_impact`.
- **When a decision is made:** call `brain_log_decision`.
- **When something unexpected surfaces:** call `brain_log_signal`.
```

**If you used `setup.sh` (built from source):** paste the stdio config printed by `setup.sh` into `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "purpl-brain": {
      "command": "node",
      "args": ["/absolute/path/to/purpl_brain/apps/mcp/dist/index.js"],
      "env": {
        "BRAIN_API_URL": "http://localhost:3741",
        "BRAIN_API_KEY": "<your-key-from-setup.sh>",
        "BRAIN_AGENT_ID": "claude-code"
      }
    }
  }
}
```

Add the CLAUDE.md snippet printed by `setup.sh` to your project repo. Without it, tool calls depend on model judgment and will be inconsistent. (Option A users: use the snippet provided above instead.)

> **Note:** The example hook scripts in `.claude/hooks/` use `skalrn_purpl_brain` as the project ID. Change `PROJECT_ID` at the top of each script to match your own project. Running `setup.sh` does this automatically.

---

## Orchestration agents (REST API)

If you control the orchestration layer (a CI bot, a Python script, or any HTTP-capable agent), use the REST API directly. The agent does not need to know about purpl-brain; brain calls are explicit steps in your workflow.

This pattern has been tested with direct HTTP calls. If you use an orchestration framework, the REST API is callable from any of them; framework-specific integration patterns are not yet documented.

**The pattern:**

```
before dispatch:    GET context → POST /brain/query    (inject into agent prompt)
after completion:   extract decisions → POST /brain/agent-log
before big change:  POST /brain/query  { mode: "impact" }  (optional hard gate)
```

**Minimal Python (illustrative — not a tested script):**

`call_llm` and `extract_decisions` are placeholders you replace with your own implementation. The endpoint paths and auth headers are correct; the surrounding pattern has not been run end-to-end.

```python
import httpx, uuid

BRAIN = "http://localhost:3741"
KEY   = "your-api-key"           # from apps/mcp/.env: BRAIN_API_KEY
PROJECT = "your_project"         # from apps/api/.env: DEFAULT_PROJECT_ID

def brain_query(task: str) -> str:
    try:
        r = httpx.post(f"{BRAIN}/brain/query",
                       headers={"X-API-Key": KEY},
                       json={"query": task, "project_id": PROJECT},
                       timeout=60)
        return r.json().get("answer", "") if r.is_success else ""
    except Exception:
        return ""   # brain unavailable — proceed without context

def brain_log(task: str, decisions: list[dict]) -> None:
    try:
        httpx.post(f"{BRAIN}/brain/agent-log",
                   headers={"X-API-Key": KEY},
                   json={"session_id": f"agent-{uuid.uuid4().hex[:8]}",
                         "project_id": PROJECT,
                         "agent_id": "my-agent",
                         "work_completed": task[:200],
                         "decisions": decisions},
                   timeout=30)
    except Exception:
        pass    # log failure is non-fatal

def run_task(task: str) -> str:
    context = brain_query(task)
    prompt = f"Prior decisions:\n{context}\n\n---\n\n{task}" if context else task
    # Note: brain_query returns "" on failure but a non-empty "no results" message
    # on an empty corpus. Filter on len(context) > N or parse citations if you
    # need to distinguish between "brain unavailable" and "no decisions found".
    result = call_llm(prompt)                      # your LLM call here
    brain_log(task, extract_decisions(result))     # your decision extraction here
    return result
```

**Key rules:**
- Use the task description as the query, not a generic "recent decisions". Specific queries return what matters; broad queries flood context.
- Log immediately after each task, not just at session end. A decision lost when a session crashes is unrecoverable.
- Never raise on brain failure. The brain enhances context; it is not a dependency.


---

## Connect signal sources

### GitHub

```bash
# Backfill existing PRs and linked PR comment threads:
GITHUB_TOKEN=ghp_... npm run seed:github -w apps/api -- --repo org/repo --limit 50
```

For live ingestion: configure a GitHub webhook to `POST /webhooks/github`.

### Slack

```bash
# In .env: SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_CHANNEL_IDS
npm run worker:slack -w apps/api
```

### ADRs and local docs

```bash
npm run seed:local-docs -w apps/api -- \
  --dir ./docs \
  --project my_project \
  --base-url https://github.com/org/repo/blob/main/docs
```

Attribution resolved from git history. Linked GitHub PR threads are automatically followed and ingested.

### Meeting transcripts

```bash
curl -X POST http://localhost:3741/brain/ingest/transcript \
  -H "x-api-key: <key>" \
  -H "Content-Type: application/json" \
  -d '{"text": "...", "title": "Auth design review", "project_id": "my_project"}'
```

### Drift notifications

When a drift alert is confirmed, the brain can POST to any HTTP endpoint (a Slack webhook, a coordinator agent, a custom URL):

```bash
# In .env:
DRIFT_WEBHOOK_URL=https://hooks.slack.com/services/...
```

Payload includes: `alert_id`, `project_id`, `risk`, `challenged_decision_summary`, `challenging_content`, `reason`, `actor`, `timestamp`. Only LLM-confirmed alerts fire the webhook.

---

## LLM provider options

| | Ollama (default) | Anthropic |
|---|---|---|
| LLM | qwen2.5:7b (extraction) + llama3.1:8b (query) | Claude Haiku |
| Embeddings | nomic-embed-text:v1.5 | nomic-embed-text:v1.5 (Ollama still required) |
| Avg query latency | ~14s p50, ~28s p95 | ~2s |
| Cost | Free | ~$5–15/month |
| Test status | **Tested** | **Tested** |

Both paths use Ollama for embeddings. This keeps a single embedding space so you can switch LLM providers without re-indexing Qdrant.

---

## Verify everything works

```bash
bash demo.sh verify    # checks all services, auth, query, CORS
```

End-to-end evals:

```bash
npm run eval:integration -w apps/api   # 33 checks, full pipeline
npm run eval:mcp -w apps/mcp           # 8 checks, all MCP tools
npm run eval:cross-session -w apps/api # 5 queries, cross-session recall
npm run eval:multi-agent -w apps/api   # 58 checks, guardrail scenario (~4 min)
```

---

## Is purpl-brain the right tool?

**If you're running one agent on one codebase, a markdown decisions file may be all you need.** A `decisions/` folder with dated markdown files, vectorized with any embedding tool, covers cross-session recall with zero infrastructure. The eval-cross-session result (100% recall) is achievable with a good RAG tool. Don't run Neo4j and Qdrant if you don't need them.

At small scale that works. As the number of agents, sessions, and decisions grows, a flat file has no contradiction detection, no queryability across sessions, and no enforcement. It depends entirely on whoever (or whatever) writes to it remembering to keep it current.

**If cross-session recall is all you need, other tools are simpler.** There are hosted memory solutions that auto-ingest from agent conversations without requiring explicit decision logging and need no self-hosting. If `brain_analyze_impact` and proactive drift alerting are not features your workflow needs, those are worth evaluating first.

**purpl-brain earns its complexity when:**

- You run multiple agents working on the same codebase across separate sessions and need contradictions surfaced before they ship
- You need proactive alerts: drift detected and delivered before an agent queries, not after
- You need `brain_analyze_impact` as a guardrail: structured risk assessment with citations before an agent acts
- You want decisions stored with rationale and alternatives, not just facts, so impact analysis has something to reason over
- You want the same queryable store to eventually cover agent sessions, ADRs, and human signals (Slack, PRs, meetings) in one place

---

## Known limitations

- **Impact analysis uses a hybrid risk floor.** Any decision with an open drift alert is floored at `high`; any high-confidence decision is floored at `medium`. The LLM can raise tiers above the floor but cannot lower them below it. Decision age and downstream reference count are not yet used as floor inputs.
- **Drift detection skips GitHub-sourced decisions** to reduce false positives from PR noise.
- **Human communication ingestion is partial.** Agent write-back and document ingestion are tested. GitHub webhook ingestion is implemented. Slack ingestion is implemented but thread replies are not fetched, and decision extraction yield from conversational PR threads is low.
- **The Stop hook catches sessions that close cleanly.** Crashed or force-killed sessions do not fire the hook. Mid-session compaction before close is an open problem.
- **Logged decision quality depends on timing.** A decision logged when it is made is more complete than one reconstructed at session close.

---

## Architecture and design documents

| Audience | Document |
|----------|----------|
| Architecture deep dive | [docs/technical/architecture.md](docs/technical/architecture.md) |
| Agent write-back design | [docs/technical/adrs/004-agent-decision-trails.md](docs/technical/adrs/004-agent-decision-trails.md) |
| Embedding model selection | [docs/technical/adrs/005-embedding-model.md](docs/technical/adrs/005-embedding-model.md) |

---

## Running locally without Docker

```bash
docker compose up -d redis neo4j qdrant   # infra only
npm run dev -w apps/api                   # API on :3741
npm run worker:normalizer -w apps/api
npm run worker:extractor -w apps/api
npm run worker:brain-writer -w apps/api
npm run worker:drift -w apps/api
```
