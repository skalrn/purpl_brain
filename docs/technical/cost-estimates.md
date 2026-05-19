# Cost Estimates

**Last updated:** 2026-05-15

---

## Scenarios

| Scenario | Users | Repos | Queries/month | Total/month |
|---|---|---|---|---|
| Minimal beta | 5-10 | 1 | 200 | ~$14-20 |
| **Real beta** | **10** | **25 (2-3 per user)** | **2,000** | **~$76-86** |

---

## Real Beta — Summary (Recommended Planning Target)

10 users × 2.5 repos average = 25 repos, 2,000 queries/month.

| Item | Cost/month |
|---|---|
| Hosting (Hetzner CX42) | ~$20 |
| Claude API | ~$56 |
| Embeddings (Ollama, self-hosted) | $0 |
| **Total** | **~$76/month** |

---

## Hosting

Single VM running all services via Docker Compose (Fastify + Redis + Qdrant + Neo4j + Next.js UI + Ollama).

| Provider | Spec | Cost/month | Notes |
|---|---|---|---|
| Hetzner CX22 | 2 vCPU, 4GB RAM, 40GB SSD | ~$4 | Too small for real beta |
| Hetzner CX32 | 4 vCPU, 8GB RAM, 80GB SSD | ~$9 | Sufficient for minimal beta |
| **Hetzner CX42** | **8 vCPU, 16GB RAM, 160GB SSD** | **~$20** | **Recommended for real beta** |
| DigitalOcean Basic | 2 vCPU, 4GB RAM, 80GB SSD | ~$18 | More expensive for same specs |
| AWS t3.small | 2 vCPU, 2GB RAM | ~$17 | Too little RAM |

### Why CX42 for real beta

25 repos of Qdrant vector data grows to ~4-6GB. The CX32's 80GB disk and 8GB RAM become tight once Ollama, Qdrant, and the app are all running under query load.

### RAM allocation (CX42, real beta)

| Service | RAM estimate |
|---|---|
| FastAPI app | ~200MB |
| Redis | ~100MB |
| Qdrant (25 repos) | ~1.5GB |
| Neo4j (Docker) | ~500MB |
| Next.js UI | ~100MB |
| Ollama + nomic-embed-text | ~500MB |
| **Total** | **~2.6GB** |

16GB gives comfortable headroom for query spikes.

---

## Embeddings

Self-hosted via Ollama on the same VM. No per-token cost.

**Model:** `nomic-embed-text` (768-dim, runs on CPU)

### Embedding provider comparison (for reference)

| Provider | Model | Cost per 1M tokens |
|---|---|---|
| Ollama (self-hosted) | `nomic-embed-text` | $0 |
| OpenAI | `text-embedding-3-small` | $0.02 |
| Voyage (Anthropic) | `voyage-3-lite` | $0.02 |
| Voyage (Anthropic) | `voyage-3` | $0.06 |
| Cohere | `embed-english-v3.0` | $0.10 |
| OpenAI | `text-embedding-3-large` | $0.13 |

### Estimated token volume by scenario

| Event | Minimal beta | Real beta |
|---|---|---|
| Initial ingest (one-time) | ~200k | ~5M |
| Ongoing events/month | ~50k | ~1.25M |
| Queries/month | ~100k | ~1M |
| **Steady-state total** | **~150k/month** | **~2.25M/month** |

At real beta volume, `text-embedding-3-large` would cost ~$0.29/month — still negligible. Ollama is preferred for zero external API dependency and no rate limits.

**Milestone 7 eval:** Compare retrieval quality between `nomic-embed-text`, `text-embedding-3-small`, and `text-embedding-3-large` before committing to a provider for Phase 2.

---

## Claude API

Used in two places: Haiku for extraction and intent parsing, Sonnet for query answering.

### Pricing

| Model | Input | Output | Cache read |
|---|---|---|---|
| Claude Haiku 4.5 | $0.80/1M | $4.00/1M | $0.08/1M |
| Claude Sonnet 4.6 | $3.00/1M | $15.00/1M | $0.30/1M |

### Monthly cost breakdown — real beta (2,000 queries, 25 repos)

| Call | Model | Input tokens | Output tokens | Cost |
|---|---|---|---|---|
| Intent parsing | Haiku | 2,000 × 300 = 600k | 2,000 × 100 = 200k | ~$1.30 |
| Entity extraction | Haiku | 375 × 1,500 = 562k | 375 × 200 = 75k | ~$0.75 |
| Query answering | Sonnet | 2,000 × 6,600 = 13.2M | 2,000 × 500 = 1M | ~$54 |
| **Monthly total** | | | | **~$56** |

**One-time initial ingest** (25 repos × ~60 Haiku extraction calls): ~$3

### Prompt caching impact

System prompts are cached per CLAUDE.md requirements. Cache reads cost ~10x less than input tokens. At real beta volume (~2,000 queries/month), system prompt caching saves ~$1-2/month. The large per-query context (retrieved chunks) changes each call and is not cacheable.

Effective monthly range: **$52–$56** depending on cache hit rate.

---

## Context Window Budget Cuts

Sonnet query answering is ~70% of total spend. The primary lever is the retrieved context size passed to each Sonnet call.

Current default: **6,000 tokens** per query (top-K chunks + 1-hop graph neighbors).

| Context window | Sonnet input/query | Monthly Sonnet cost | Total/month | Quality impact |
|---|---|---|---|---|
| 6,000 tokens (default) | 6,600 tokens | ~$54 | ~$76 | Full — all retrieved context included |
| 4,000 tokens | 4,600 tokens | ~$38 | ~$60 | Low — top chunks still included, some graph neighbors trimmed |
| 2,500 tokens | 3,100 tokens | ~$25 | ~$47 | Medium — only highest-scored chunks, no graph expansion |
| 1,500 tokens | 2,100 tokens | ~$17 | ~$39 | High — retrieval becomes shallow, citation depth suffers |

### Recommended budget tiers

**Standard (~$76/month):** 6,000 token context. Full retrieval quality. Use this unless budget is a constraint.

**Budget (~$60/month):** 4,000 token context. Trim low-scoring graph neighbors first, keep exact entity matches and high-similarity chunks. Minimal quality loss for most queries.

**Minimal (~$47/month):** 2,500 token context. Disable 1-hop graph expansion entirely, vector search only. Noticeable quality drop on relational queries ("what tickets does this decision affect?") but acceptable for simple factual lookups.

### How to implement tiered context in code

Control via a single `context_budget_tokens` parameter in the query layer. Trimming priority order (drop last first):

1. Low-scoring graph neighbors (score < 0.3)
2. Duplicate-adjacent chunks (same source, overlapping content)
3. Graph neighbors (all)
4. Low-similarity vector chunks (score < 0.5)

Never trim: exact entity match chunks, the chunk containing the directly cited decision.

---

## Scaling Sensitivity

| Monthly queries | Claude cost (6k ctx) | Claude cost (4k ctx) | Total (6k ctx) |
|---|---|---|---|
| 200 (minimal beta) | ~$5.60 | ~$4 | ~$14-20 |
| 2,000 (real beta) | ~$56 | ~$38 | ~$76 |
| 5,000 | ~$138 | ~$96 | ~$158 |
| 10,000 | ~$275 | ~$192 | ~$295 |

At 10,000 queries/month the cost warrants revisiting the architecture (caching frequent query results, routing simple queries to Haiku).

---

## Cost by Phase (forward look)

| Phase | Additional services | Estimated increment |
|---|---|---|
| Phase 1 (real beta) | GitHub only, 25 repos | ~$76/month |
| Phase 2 | Slack + agent write-back | +query volume, same infra |
| Phase 3 | Jira/Linear, anomaly engine | Possibly upgrade VM to CX52 |
| Phase 4 | MCP server, multi-user auth | Auth service, larger VM |
