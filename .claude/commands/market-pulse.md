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

**Highest product risk:** Write-back adoption — empty brain on first use is the highest-probability early churn cause (documented in prd.md R1).

## Sources to search

- Stack Overflow Developer Survey (annual — check for new edition)
- GitHub Blog (engineering / AI section)
- O'Reilly Radar
- Anthropic / OpenAI / Google engineering blogs
- Mem0, LangChain, CrewAI, AutoGen release notes and blog posts
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
