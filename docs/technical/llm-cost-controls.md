# LLM Cost Controls — Prompt Caching

This document specifies how to apply Anthropic prompt caching across Project Brain's extraction and query calls so that the system prompt and project context are not re-charged on every request within a session.

## Core Invariant

**Caching is a prefix match.** Any byte change anywhere before a `cache_control` breakpoint invalidates that cache entry and incurs a full re-charge. Render order is `tools → system → messages` — a breakpoint on the last system block caches tools and system together.

## Call Structure and Breakpoint Placement

Project Brain's LLM calls have two stable tiers and one volatile tier:

```
[tools]              ← stable: same schema on every call
[system prompt]      ← stable: agent persona, extraction rules, citation contract
─── breakpoint 1 ───
[project context]    ← semi-stable: per-session (graph snapshot, retrieved docs, schema)
─── breakpoint 2 ───
[per-request turn]   ← volatile: the document chunk or user query
```

### Breakpoint 1 — System prompt

```python
response = client.messages.create(
    model="claude-opus-4-7",
    max_tokens=4096,
    system=[{
        "type": "text",
        "text": SYSTEM_PROMPT,
        "cache_control": {"type": "ephemeral", "ttl": "1h"}  # 1h for extraction pipelines
    }],
    messages=[...]
)
```

Use `"ttl": "1h"` for batch extraction pipelines where calls are spaced out. Use the default 5-minute TTL for interactive query sessions (the cache resets on every hit, so it stays alive as long as calls are flowing).

### Breakpoint 2 — Session-scoped project context

For the first message in a session, attach a second breakpoint at the end of the context block:

```python
messages = [
    {
        "role": "user",
        "content": [
            {
                "type": "text",
                "text": project_context,        # graph nodes, retrieved docs, schema
                "cache_control": {"type": "ephemeral"}
            },
            {
                "type": "text",
                "text": user_query              # volatile — no marker
            }
        ]
    }
]
```

This context block is charged at the 1.25× write rate on the first call of a session, then at 0.1× on every subsequent call within the 5-minute window.

### Multi-turn query sessions

Move the breakpoint to the last block of the most-recently-appended turn on each call:

```python
def append_turn(messages: list, role: str, content: str) -> list:
    # Remove marker from the previous last turn
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

## Silent Invalidators — Do Not Do These

These patterns produce zero cache hits with no error message:

| Anti-pattern | Fix |
|---|---|
| `f"Date: {datetime.now()}"` in system prompt | Move to a user message at the end |
| `json.dumps(entity_map)` without `sort_keys=True` | Use `sort_keys=True` |
| Per-request `trace_id` or `request_id` early in content | Append to a user message or omit |
| Varying tool set per request (add/remove tools) | Fix the tool set; use tool descriptions to guide conditional behavior |
| Switching models mid-session | Caches are model-scoped; pin one model per session |
| Conditionally including system sections | Make the full system prompt unconditional |

## Verifying Cache Hits

After any change to the prompt-building path, verify caching is working:

```python
print(f"Cache write: {response.usage.cache_creation_input_tokens}")  # 1.25x cost
print(f"Cache read:  {response.usage.cache_read_input_tokens}")       # 0.1x cost
print(f"Uncached:    {response.usage.input_tokens}")                  # full cost
```

`cache_read_input_tokens` must be non-zero on the second and subsequent calls with an identical prefix. If it stays zero, there is a silent invalidator — render the prompt to a string for two consecutive calls and diff the bytes to find it.

## Economics

For an extraction call with a ~50K-token system prompt:

- **First call**: 50K × 1.25× (cache write) + volatile tokens × 1×
- **Every subsequent call within TTL**: 50K × 0.1× + volatile tokens × 1×
- **Savings per cached call**: ~90% on the stable portion

For 1-hour TTL: write cost is 2× instead of 1.25×. Break-even is 3 calls within the hour (2× + 0.1× + 0.1× = 2.2× vs 3× uncached).

**Minimum cacheable prefix by model** — prefixes shorter than this silently do not cache:

| Model | Minimum tokens |
|---|---|
| claude-opus-4-7, claude-opus-4-6 | 4,096 |
| claude-sonnet-4-6 | 2,048 |

Ensure the system prompt exceeds this threshold before relying on caching.

## Application to Project Brain Call Sites

| Call site | Stable prefix | Session context | Volatile suffix |
|---|---|---|---|
| Entity extraction | Extraction rules, output schema | Document batch metadata | Individual document chunk |
| Query / RAG | Query agent persona, citation contract | Retrieved graph nodes + vector results | User question |
| Anomaly detection | Detector definitions, severity rubric | Recent event window | New event batch |
| Agent log ingestion | Ingestion rules, entity schema | Current graph state snapshot | Incoming agent log |

Each call site follows the same two-breakpoint pattern: one on the system prompt, one at the end of the session-scoped context block.
