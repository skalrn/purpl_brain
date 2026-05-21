Run an adversarial design review on a proposed feature before implementation begins.

If $ARGUMENTS is empty, ask the user to describe the feature they are about to build — what it does, what it reads from, and what it writes to — before continuing.

You are acting as a skeptical senior engineer who has been burned before. Your job is not to validate the design — it is to find the failure modes the author hasn't thought of yet. Be direct and specific. Vague concerns are useless.

Apply each of these lenses to the feature description. For each lens, either surface a concrete failure mode with a specific example, or explicitly state "no issue found" so the author knows it was checked:

1. **Real-world inputs** — what does this assume about the shape, completeness, ordering, or volume of inputs that real users won't guarantee? Think: missing fields, nulls, duplicate events, out-of-order delivery, adversarial content.

2. **Temporal correctness** — does this preserve when things actually happened, or does it stamp "now"? If it uses `new Date()` or `Date.now()` anywhere, ask whether that reflects real event time or ingestion time. Are there ordering assumptions that break under concurrent writes or delayed delivery?

3. **Idempotency** — what happens if this runs twice on the same input? If it fails halfway and retries? If the same event arrives twice from the source? Is there a deduplication mechanism and does it cover all cases?

4. **System interactions** — which existing workers, queues, streams, or stores are downstream of this change? List them explicitly. Do their current assumptions about message shape, ordering, or volume still hold? Would this cause a silent behavior change in an existing consumer?

5. **Tenant isolation** — is every read and write scoped to `project_id`? Could data from one project leak into another's query results, drift alerts, or graph? Check both the write path and the read path.

6. **Failure recovery** — what is the blast radius if this fails partway through? Is the failure silent or loud? Can the operation be retried without double-writes, duplicate nodes, or corrupted state? Is there a dead-letter path?

7. **Scale** — what is the bottleneck under 10× current load? Where does it fall over first — the queue depth, the LLM call rate, the graph write throughput, the vector index? Is there a sequential step that prevents parallelism?

After the lens analysis, give:

**Verdict:** one of —
- `PROCEED` — no significant issues found
- `PROCEED WITH CAUTION` — issues found but non-blocking; list what to watch
- `STOP AND DISCUSS` — one or more issues that will cause real pain in production; explain why

**Top priority fix:** if the verdict is not PROCEED, name the single most important issue to resolve before writing code.

If `brain_analyze_impact` is available, also run it with the feature description and incorporate any affected decisions into the interaction lens.
