# We Wrote a Prompt Caching Spec. Then We Shipped Code That Violated Every Rule In It.

---

Six weeks into building an LLM-powered knowledge system, we wrote `llm-cost-controls.md`. It was a careful document: seven rules for prompt caching, annotated with the reasoning behind each one, a section on anti-patterns, and explicit instructions for the Anthropic SDK calls that power the system.

The document was good. We referenced it when writing new LLM call sites. We added it to `CLAUDE.md` with a note saying "Rules enforced when writing SDK code." We felt appropriately responsible about our infrastructure costs.

A full-codebase review found that the actual `llm.ts` implementation violated every rule in the document. Not one or two — all of them. The query engine sent 12,000-token retrieved context blocks as plain strings with no cache_control on every query. The extraction pipeline — the highest-volume call site in the system — had zero second-breakpoint caching. No call site logged `cache_read_input_tokens`. The document said "If it is zero, there is a silent invalidator — find it before shipping." Nobody had verified it was non-zero.

This article is about why this gap happens, what it costs, and the one change to the code structure that makes compliance verifiable rather than aspirational.

---

## 1. 🔍 What Prompt Caching Actually Requires

Anthropic's prompt caching works by letting you mark content blocks with `cache_control: { type: "ephemeral" }`. Marked blocks are cached for 5 minutes (default) or 1 hour (explicit TTL). On subsequent calls with the same prefix, you pay for cache reads instead of cache writes — roughly 10× cheaper for reads vs. writes.

The rules that follow from this are mechanical:

**Rule 1 — System prompt must be a content block array, not a string.** A plain string system prompt cannot have `cache_control`. The SDK accepts both, but only the block form supports caching.

**Rule 2 — Cache the last block of the system prompt.** The cache key is prefix-based: everything before and including the marker must be identical on every call for a cache hit. The system prompt is static per call site, so mark its last block.

**Rule 3 — For session-scoped context (retrieved documents, graph snapshots), add a second breakpoint at the end of the first user message's context block.** This is the expensive one to get right. If you retrieve 12,000 tokens of context and send it as a plain string, you pay 12,000 tokens of cache write on every query, even if the same documents were retrieved before.

**Rule 4 — Never interpolate dynamic content into cached blocks.** Timestamps, UUIDs, request IDs — anything that varies per call — invalidates the cache silently. Dynamic content goes in a separate, uncached turn at the end.

**Rule 5 — For extraction pipelines with bursty traffic and idle gaps, use 1-hour TTL.** The default 5-minute TTL evaporates during idle periods. Use `{ type: "ephemeral", ttl: "1h" }` anywhere calls are batched with gaps between batches.

**Rule 6 — Verify caching is working.** `response.usage.cache_read_input_tokens` must be non-zero on the second call with an identical prefix. If it's zero, there is a silent invalidator — wrong block structure, dynamic content in a cached block, prefix mismatch. Find it before shipping.

---

## 2. 🛑 What We Actually Shipped

Our `llm.ts` `chat()` function looked like this:

```typescript
const response = await anthropicClient.messages.create({
  model,
  max_tokens: maxTokens,
  system: system
    ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
    : undefined,
  messages: userMessages.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content  // ← plain string, no cache_control
  })),
});
```

Rule 1: compliant — system prompt is a block array.
Rule 2: compliant — last (and only) system block is marked.
Rule 3: **violated** — `content: m.content` is a plain string. No way to add a cache_control marker.
Rule 4: not checked — dynamic content in system prompts was not audited.
Rule 5: **violated** — no `ttl: "1h"` anywhere.
Rule 6: **violated** — `response.usage` is never logged or checked.

The query engine assembled up to 12,000 characters of retrieved context and passed it as a plain string user message. Every query paid full input token price for the context. If a user asked three questions in a row about the same project — exactly the usage pattern an agent at session start would exhibit — all three queries paid full price for the same retrieved documents.

The extractor called the LLM once per `decision_candidate` event. In a large GitHub repo with 500 candidate PRs, that's 500 separate LLM calls. Each one re-sent the full system prompt (1,500 tokens) plus the event content. With a 5-minute cache TTL, bursts that finish in under 5 minutes would hit the cache — but any burst with gaps (normal when processing against Anthropic rate limits) would miss. No 1-hour TTL.

---

## 3. 💡 Why This Gap Happens

The gap between the spec and the implementation has a specific cause: **the `chat()` function signature makes correct caching impossible, not just missing.**

```typescript
interface Message {
  role: "system" | "user" | "assistant";
  content: string;  // ← a string. You cannot attach cache_control to a string.
}

export async function chat(
  model: string,
  messages: Message[],
  options: LLMOptions = {}
): Promise<string>
```

A developer following the spec who wants to add a cache breakpoint on the retrieved context block has no way to do it. The `Message` type only allows strings. They would have to either bypass `chat()` entirely and call the Anthropic SDK directly, or violate the abstraction. Most developers would look at the existing call sites, see that they all pass strings, and conclude that the spec is aspirational or that the function handles it internally.

This is the pattern that causes compliance to drift: the abstraction layer makes correct behavior harder than incorrect behavior, and nothing checks compliance at runtime.

---

## 4. 🔧 The Fix: Make Correct Caching the Default

The solution is to extend the `chat()` function signature to make the cache breakpoints an explicit parameter:

```typescript
interface CachedBlock {
  text: string;
  cacheTtl?: "5m" | "1h";
}

interface ChatOptions extends LLMOptions {
  // Static context retrieved for this request (docs, graph snapshots).
  // Placed as content blocks in the first user message with cache_control.
  cachedUserContext?: CachedBlock[];
  
  // Override system prompt cache TTL. Default: "5m" (ephemeral).
  // Use "1h" for extraction pipelines with bursty patterns.
  systemCacheTtl?: "5m" | "1h";
}
```

The query engine then passes retrieved context explicitly:

```typescript
const answer = await chat(
  MODELS.QUERY,
  [
    { role: "system", content: ANSWER_SYSTEM_PROMPT },
    { role: "user", content: `Question: ${request.query}\n\nAnswer using the context above.` },
  ],
  {
    cachedUserContext: [{
      text: assembledContext,   // the 12,000-token retrieved block
      cacheTtl: "5m",
    }],
  }
);
```

Internally, `chat()` constructs the Anthropic API call correctly:

```typescript
// Inside chat(), for Anthropic provider:
const firstUserTurn = [
  // Cached context blocks come first in the user turn
  ...(options.cachedUserContext ?? []).map((block, i, arr) => ({
    type: "text" as const,
    text: block.text,
    // Only the LAST context block gets cache_control
    ...(i === arr.length - 1 ? {
      cache_control: {
        type: "ephemeral" as const,
        ...(block.cacheTtl === "1h" ? { ttl: "1h" } : {}),
      }
    } : {}),
  })),
  // The volatile question always comes after the cached context
  { type: "text" as const, text: userMessages[0].content },
];
```

Now the correct structure is what the function produces by default. There is nowhere for a developer to accidentally place dynamic content in a cached block — the parameter separation makes it structurally impossible.

---

## 5. 📊 Verifying Compliance at Runtime

The spec says to verify `cache_read_input_tokens > 0`. Add this to the `chat()` function directly:

```typescript
if (PROVIDER === "anthropic") {
  const cacheHit = response.usage.cache_read_input_tokens ?? 0;
  const cacheMiss = response.usage.cache_creation_input_tokens ?? 0;
  
  // Log for observability
  console.log(`[llm] cache_read=${cacheHit} cache_write=${cacheMiss} model=${model}`);
  
  // In development: assert cache hits on repeated calls
  if (process.env.ASSERT_CACHE_HITS === "true" && cacheMiss > 0 && cacheHit === 0) {
    console.warn(`[llm] WARNING: cache miss with no prior hit — possible silent invalidator`);
  }
}
```

And add an eval that calls the same query twice and asserts the second call hits the cache:

```typescript
// eval-cache-compliance.ts
const firstResponse = await runQuery({ query: TEST_QUERY, project_id: TEST_PROJECT });
const secondResponse = await runQuery({ query: TEST_QUERY, project_id: TEST_PROJECT });

assert(
  secondResponse.cache_read_tokens > 0,
  `Cache miss on second identical query — silent invalidator present. ` +
  `Check for dynamic content in system prompt or missing context block marker.`
);

console.log(`✓ Cache hit rate: ${secondResponse.cache_read_tokens} read tokens on second call`);
```

This eval catches any future regression in caching compliance — a changed system prompt structure, a dynamic value accidentally injected, a model upgrade that changed TTL behavior.

---

## 6. 🔑 The General Rule

A compliance document that is not structurally enforced by the code is a hope, not a guarantee.

For prompt caching specifically: if your LLM abstraction layer accepts `string` content, compliance is impossible by default. The correct pattern is to make `cachedUserContext` an explicit parameter so developers cannot accidentally put retrieved documents in the wrong place.

For any technical spec: the question worth asking is "does the code make the correct behavior easier than the incorrect behavior?" If the answer is no, the spec will drift. Not through malice or negligence — but because developers follow existing patterns, and if the existing patterns are wrong, new code follows them.

The fix is not a better code review process. It is a better function signature.

---

*This article is part of a series on building production-grade LLM infrastructure. The caching gap described here was found in a full-codebase review of purpl_brain.*
