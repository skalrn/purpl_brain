# ADR-005: Embedding Model — nomic-embed-text (Local) over OpenAI text-embedding-3-*

**Status:** Accepted  
**Date:** 2026-05-21  
**Deciders:** Deepak Kollipalli  

---

## Context

purpl-brain uses Qdrant for semantic vector retrieval. Every ingested document chunk and every query is embedded before being stored or searched. The embedding model is therefore a foundational choice: it determines vector dimensionality, retrieval quality, runtime cost, and infrastructure dependencies.

The system currently uses `nomic-embed-text` via a local Ollama instance. This choice was made implicitly as a local-first default and was never recorded as an explicit decision.

The question arose whether switching to OpenAI `text-embedding-3-small` (1536 dim) or `text-embedding-3-large` (3072 dim) would improve retrieval quality on technical content — ADRs, PR bodies, Jira tickets, meeting transcripts.

A model switch is not a configuration change. The codebase includes a fail-fast guard (`checkEmbeddingModel` in `apps/api/src/lib/qdrant.ts`) that detects mismatches between the stored collection model and the currently configured model and halts startup. This means any switch requires a full re-embedding of all existing Qdrant collections per project before the system can restart.

---

## Decision

**Retain `nomic-embed-text` (local Ollama) as the embedding model.**

Do not switch to OpenAI `text-embedding-3-*` at this time.

---

## Reasoning

### Against switching now

**Cost model changes fundamentally.** nomic-embed-text runs locally at zero marginal cost per token. text-embedding-3-small costs ~$0.02/1M tokens; text-embedding-3-large ~$0.13/1M tokens. Every ingest, re-ingest, and query incurs this cost in perpetuity. For a multi-tenant system ingesting GitHub PRs, Jira tickets, Slack threads, and meeting transcripts continuously, this is non-trivial.

**New runtime dependency.** Switching adds a hard dependency on `OPENAI_API_KEY` in production. Ollama is already a required service; OpenAI would be a second external API dependency with its own availability and rate-limit surface.

**Full re-embedding required.** The fail-fast guard means all existing collections must be re-embedded before the system can start. This is a coordinated migration across all tenant projects — not a rolling change.

**No observed retrieval failures.** Phase 1 and Phase 2 evals show 5/5 attribution accuracy. There is no evidence that nomic-embed-text is the bottleneck in retrieval quality. Upgrading preemptively without a measured gap is premature optimization.

### When to revisit

- Retrieval miss rate rises in beta on semantically close but distinct concepts (e.g., two different ADRs about the same component, or PRs with similar titles but different intent)
- A local high-dimension model becomes available via Ollama that matches or exceeds text-embedding-3-small quality without the API dependency
- A tenant specifically requires OpenAI embeddings for compliance or interoperability reasons

### Migration path when the time comes

1. Set `EMBEDDING_MODEL=text-embedding-3-small` (or `-large`) in env
2. Run `npx tsx src/scripts/reset-pipeline.ts --project <project_id>` per tenant to drop and re-embed the collection
3. Verify `response.usage.cache_read_input_tokens` behavior is unaffected in the query layer
4. The fail-fast guard will catch any misconfiguration before queries are served

---

## Alternatives Considered

| Model | Dim | Provider | Cost | Notes |
|---|---|---|---|---|
| `nomic-embed-text` ✓ | 768 | Local (Ollama) | Free | Current default |
| `text-embedding-3-small` | 1536 | OpenAI API | ~$0.02/1M tokens | Better benchmarks on technical text; adds API dependency |
| `text-embedding-3-large` | 3072 | OpenAI API | ~$0.13/1M tokens | Best quality; 2× storage vs 3-small; significant cost |

---

## Consequences

- The embedding model is `nomic-embed-text` and must be documented as such in `.env.example` and setup instructions
- Any future model switch must go through the re-embedding migration path above — it is never safe to swap the model without resetting the collection
- The `checkEmbeddingModel` guard must remain in place and must never be bypassed
