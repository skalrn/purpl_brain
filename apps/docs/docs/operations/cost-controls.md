---
sidebar_position: 2
---

# LLM Cost Controls

## What the LLM costs

For a team of 10 active agents making a typical workload of queries and extractions:

| Category | Daily cost |
|---|---|
| Entity extraction (Claude Haiku, decision candidates only) | ~$0.50-1.00 |
| Query answering (Claude Sonnet, per query) | ~$1.00-2.50 |
| Drift detection LLM confirmation (Claude Haiku) | ~$0.30-0.80 |
| Intent parsing (Claude Haiku, per query) | ~$0.10-0.30 |
| **Total** | **~$2-5/day** |

The primary cost lever is prompt caching. Without caching, system prompts are charged at full input token rate on every request. With caching, the stable prefix is charged at 1.25× on the first call and 0.1× on all subsequent calls within the TTL window — a 90% reduction on the cached portion.

## How prompt caching works

Caching is a **prefix match**. Any byte change anywhere before a `cache_control` breakpoint invalidates that cache entry and incurs a full re-charge. The render order is `tools → system → messages` — a breakpoint on the last system block caches tools and system together.

Two stable tiers and one volatile tier per LLM call:

```
[tools]              ← stable: same schema on every call
[system prompt]      ← stable: persona, extraction rules, citation contract
─── breakpoint 1 ───
[project context]    ← semi-stable: per-session graph snapshot, retrieved docs
─── breakpoint 2 ───
[per-request turn]   ← volatile: the document chunk or user query
```

## Breakpoint placement

### System prompt breakpoint

```python
response = client.messages.create(
    model="claude-sonnet-4-6",
    max_tokens=4096,
    system=[{
        "type": "text",
        "text": SYSTEM_PROMPT,
        "cache_control": {"type": "ephemeral", "ttl": "1h"}
    }],
    messages=[...]
)
```

Use `ttl: "1h"` for batch extraction pipelines where calls are spaced out with idle gaps. Use the default 5-minute TTL for interactive query sessions (the cache resets on every hit, so it stays alive as long as queries are flowing).

### Project context breakpoint

For the first message in a session, attach a second breakpoint at the end of the context block:

```python
messages = [
    {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": project_context,  # graph nodes, retrieved docs, schema
                "cache_control": {"type": "ephemeral"}
            },
            {
                "type": "text",
                "text": user_query  # volatile — no marker
            }
        ]
    }
]
```

The context block is charged at 1.25× on the first call, then 0.1× on every subsequent call within the 5-minute window. For a 50K-token context block (large graph snapshot), the savings per cached call are approximately 90% on that block.

### Multi-turn sessions

Move the breakpoint to the last block of the most recently appended turn on each call:

```python
def append_turn(messages: list, role: str, content: str) -> list:
    # Remove marker from previous last turn
    if messages:
        last = messages[-1]["content"]
        if isinstance(last, list):
            last[-1].pop("cache_control", None)
        elif isinstance(last, dict):
            last.pop("cache_control", None)

    messages.append({
        "role": role,
        "content": [{
            "type": "text",
            "text": content,
            "cache_control": {"type": "ephemeral"}
        }]
    })
    return messages
```

Each request reuses the full prior conversation prefix. Cache hits accumulate as the session grows.

## Silent invalidators

These patterns produce zero cache hits with no error message. Each one silently charges full input rate on every call:

| Anti-pattern | Fix |
|---|---|
| `f"Date: {datetime.now()}"` in system prompt | Move timestamps to a user message at the end |
| `json.dumps(entity_map)` without `sort_keys=True` | Use `sort_keys=True` |
| Per-request `trace_id` or `request_id` early in content | Append to a user message or omit |
| Varying tool set per request (add/remove tools conditionally) | Fix the tool set; use tool descriptions for conditional behavior |
| Switching models mid-session | Caches are model-scoped; pin one model per session |
| Conditionally including system sections (`if feature_flag: ...`) | Make the system prompt unconditional |

## Verifying cache hits

After any change to the prompt-building path, verify caching is working:

```python
print(f"Cache write: {response.usage.cache_creation_input_tokens}")  # 1.25× cost
print(f"Cache read:  {response.usage.cache_read_input_tokens}")       # 0.10× cost
print(f"Uncached:    {response.usage.input_tokens}")                  # full cost
```

`cache_read_input_tokens` must be non-zero on the second and subsequent calls with an identical prefix. If it stays zero, there is a silent invalidator. To find it: render the prompt to a string for two consecutive calls and diff the bytes. The diff will show exactly which tokens changed.

## Minimum cacheable prefix

Prefixes shorter than the model's minimum do not cache silently — they are charged at full rate with no warning:

| Model | Minimum tokens |
|---|---|
| claude-opus-4-7, claude-opus-4-6 | 4,096 |
| claude-sonnet-4-6 | 2,048 |

Ensure the system prompt exceeds the minimum for the model in use before relying on caching. The extraction system prompt (with schema definitions, decision taxonomy, and few-shot examples) exceeds 2,048 tokens. The query system prompt (with citation contract and retrieval instructions) must also exceed 2,048 to be cached.

## Breakpoints per call site

| Call site | Stable prefix | Session context | Volatile suffix |
|---|---|---|---|
| Entity extraction | Extraction rules, output schema, few-shot examples | Document batch metadata | Individual document chunk |
| Query / RAG | Query persona, citation contract | Retrieved graph nodes + vector results | User question |
| Drift detection | Detector definitions, severity rubric | Recent event window | New event batch |
| Agent log ingestion | Ingestion rules, entity schema | Current graph state snapshot | Incoming agent log |

Each call site follows the same two-breakpoint pattern. The system prompt breakpoint covers the stable rules that never change. The session context breakpoint covers the per-session state that changes between sessions but stays stable within a session.
