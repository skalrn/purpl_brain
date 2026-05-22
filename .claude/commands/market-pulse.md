# market-pulse

Analyze how multi-agent development is evolving in the developer community and assess whether purpl-brain's current value proposition, positioning, and docs remain well-calibrated.

## What this skill does

1. Searches recent developer community content (blog posts, surveys, practitioner write-ups) for signal on multi-agent development patterns, pain points, and tooling gaps — targeting the same communities as the original May 2026 analysis: r/LocalLLaMA, r/ClaudeAI, r/devtools, r/MachineLearning, Stack Overflow, GitHub Blog, O'Reilly, and practitioner substacks.

2. Structures findings across five dimensions:
   - **How teams are working** — dominant patterns, frameworks in use, team sizes, solo vs. collaborative
   - **Pain points** — ranked by frequency and severity; note any new pain points not present in prior analysis
   - **Community vocabulary** — exact language developers use (not product language); identify any shifts
   - **Trust signals** — developer trust/distrust data; any change from the 45.7% distrust baseline (Stack Overflow 2025)
   - **Tooling landscape** — new entrants, provider memory feature changes, anything that competes with or validates purpl-brain

3. Maps findings against purpl-brain's current positioning in `docs/product/vision.md`:
   - Which of the five competitive differentiators are still unoccupied?
   - Has any provider closed the cross-agent / cross-tool / audit-grade gap?
   - Is the ICP still accurate (Profile A: agent operator, Profile B: concurrent project developer)?
   - Does the community vocabulary still mismatch the product vocabulary, and how much?

4. Assesses whether docs need updates:
   - `vision.md` — problem statement, competitive table, ICP
   - `prd.md` — risks section (especially R1 write-back adoption), success metrics
   - Any new risk worth adding based on landscape shifts

5. Produces a structured report with:
   - **Still valid** — findings from prior analysis that hold
   - **Changed** — anything meaningfully different since last run
   - **New signals** — pain points or patterns not in the prior analysis
   - **Doc changes recommended** — specific sections and what to update (or "none")

## Prior analysis baseline (May 2026)

Key findings to compare against:

**Pain points ranked:**
1. Context doesn't survive session boundaries (near-universal)
2. No shared working memory across team members
3. Decisions made in sessions are invisible and non-retrievable
4. Debugging and observability are opaque
5. Re-derivation cost is invisible but enormous
6. No semantic search over past decisions
7. Cross-session identity and attribution

**Trust baseline:** 45.7% of developers actively distrust AI (Stack Overflow 2025); 76% refuse AI for deployment/monitoring; 3.1% highly trust.

**Adoption baseline:** 52% not using agents or using simpler AI tools; 38% experimenting; only 17.1% say agents improved team collaboration.

**Industry architecture convergence:** Orchestrator spawns ephemeral subagents with fresh context windows; no shared mutable state; MCP as dominant tool protocol.

**Key gap purpl-brain fills:** Semantic retrieval over agent decision history specifically — confirmed unoccupied as of May 2026.

**Vocabulary mismatch:** Community says "context loss / re-explaining to the new session / AI contradicted itself." Product says "institutional memory / decision trails / audit-grade." Bridge phrase confirmed: "The next agent session knows what the last one decided."

**Highest product risk:** Write-back adoption — empty brain on first use is the highest-probability early churn cause (documented in prd.md R1). R1 has two distinct failure modes:

- **Failure mode A — Trigger discipline:** agent doesn't call `brain_log_decision` at all. Mitigations: CLAUDE.md mid-session logging instruction (primary), session-end stop hook (safety net), onboarding seed, brain health indicator, periodic digest.
- **Failure mode B — Content quality:** agent calls but logs noise or misses what matters. Mitigations: server-side schema validation on the write API (reject entries missing rationale/alternatives; force retry — this is a pre-beta API contract decision), re-derivation heuristic (*"would not knowing this cause session N+1 to redo work or make a conflicting choice?"*), auto-extraction fallback from transcripts as last resort (lower confidence, recovers *what* but loses *why*).

Timing note: end-of-session logging compounds failure mode B — early decision reasoning gets compressed out of context by session end. Mid-session logging is a quality argument, not just a discipline argument.

On each run: check whether any of the trigger or quality mitigations have been shipped. Flag shipped items as **Changed** and note whether they moved the write-back rate metric.

## Competitive baseline (May 2026)

Two categories of competition. Check both on each run.

### Provider-shipped memory (erosion risk: low-medium)
These close the single-tool single-user gap but will not build cross-runtime or audit-grade layers.

| Tool | Status as of May 2026 | Watch for |
|---|---|---|
| Claude Projects | Stable — pinned files, user-scoped, Anthropic-only | Any cross-tool or team-scoping announcement |
| Cursor Rules / Project Memory | Stable — human-authored, Cursor-only | Agent write-back path |
| ChatGPT Memory | Stable — per-user, per-account | Any team/org scoping |
| GitHub Copilot Spaces | Stable — repo-pinned, Copilot-only | External signal ingestion |
| **Cloudflare Agent Memory** | **Private beta Apr 2026 → public beta late Apr 2026. Closest competitor in stated intent.** Shared team profiles for coding agents (Claude Code, OpenCode). Accumulates coding conventions as durable team asset. **BUT:** infrastructure passthrough only — no decision schema, no rationale/alternatives/citations, no GitHub/Jira/Slack ingestion, no drift detection, locked to Cloudflare Workers runtime. Cannot answer "what did the team decide about X?" | Schema layer addition; query interface; external signal connectors; runtime portability |

### Agent memory infrastructure (erosion risk: medium on first two differentiators)
General-purpose memory libraries. Solve "agent forgets between sessions" for any app — not dev-team specific.

| Tool | Status as of May 2026 | Watch for |
|---|---|---|
| **Mem0** | Market leader, ~48K GitHub stars. Cross-agent scoping (user/session/agent/app). New token-efficient single-pass extraction algorithm (Apr 2026). No GitHub/Jira/Slack ingestion. No structured decision schema. No drift detection. | Dev-team specific SKU; decision schema add-on; external signal connectors |
| Zep / Graphiti | Temporal knowledge graph with validity windows. Not dev-team specific. No external ingestion. | Dev team pivot; contradiction detection |
| Letta (MemGPT) | Per-agent OS-inspired memory. No shared team layer. | Team-scoped shared memory |
| LangMem | Key-value, team namespace scoping, LangGraph-tied. | Decision schema; external ingestion |
| Cognee | 30+ data source connectors + knowledge graph. Broadest ingestion. No decision schema, no drift detection. | Dev-team positioning; structured decision schema |

### Gap matrix — which differentiators remain unoccupied (as of May 2026)

| Differentiator | Covered? | Closest threat |
|---|---|---|
| Cross-agent, cross-tool (not runtime-locked) | Partially (Mem0, LangMem have scoping; none have MCP-native dev focus) | Mem0 + MCP integration |
| Team-scoped, not user-scoped | Yes — Mem0, LangMem, Cloudflare | Eroded |
| **Structured decision trails with citations** | **Nobody** | Cloudflare or Mem0 adding schema |
| **Grounded in team signal history (GitHub, Jira, Slack, meetings)** | **Nobody** | Cognee pivoting to dev teams |
| **Drift detection across agents and surfaces** | **Nobody** | — |

On each run: re-check the last three rows. If any competitor has closed one, flag it as a **Changed** finding and recommend a `vision.md` update.

## Sources to search

- Stack Overflow Developer Survey (annual — check for new edition)
- GitHub Blog (engineering / AI section)
- O'Reilly Radar
- Anthropic / OpenAI / Google engineering blogs
- Mem0, Zep, Letta, LangMem, Cognee release notes and blogs
- Cloudflare Agents docs and blog (high priority — fastest-moving competitor)
- Practitioner substacks: FutureAGI, Composio, Galileo, FlowHunt
- Any new MCP ecosystem developments
- Note: Reddit blocks Anthropic's crawler — use aggregated research and practitioner write-ups instead

## Output format

Produce a written report structured as:

```
# Market Pulse — [date]

## What's changed since [prior date]
...

## Still valid
...

## New signals
...

## Competitive landscape update
...

## Doc changes recommended
[list specific files + sections, or "none"]

## Vocabulary update
[any shifts in how developers talk about this]
```

After the report, ask: "Do you want me to apply the recommended doc changes now?"
