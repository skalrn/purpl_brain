# ADR-001: Hybrid Brain Store — Vector Database + Graph Database

**Status:** Accepted  
**Date:** 2026-05-15  
**Deciders:** Deepak Kollipalli  

---

## Context

The brain must support two fundamentally different retrieval patterns:

1. **Semantic similarity** — "Find decisions related to authentication" — requires vector search over embedded chunks
2. **Relational and causal reasoning** — "What does this PR change affect downstream?" — requires graph traversal over typed edges

No single database handles both patterns well. A pure vector store cannot traverse causal chains. A pure graph database cannot do semantic similarity without embedding workarounds that degrade query quality.

## Decision

Use a **hybrid brain store**: a dedicated vector database paired with a dedicated graph database, kept in sync by the processing pipeline.

- **Vector store:** Qdrant (self-hosted for POC) — stores embedded chunks with metadata, serves similarity queries
- **Graph database:** Neo4j 5 Community — stores the knowledge graph, serves relational and causal traversal queries

Each ingested event creates nodes/edges in both stores. The vector store chunk carries the graph node ID as metadata, enabling the query layer to cross-reference from a similarity result to its graph neighborhood.

## Alternatives Considered

**Pure vector store (e.g., Pinecone only)**  
Rejected. Cannot traverse `affects` or `contradicts` edges. Impact analysis would require loading all chunks and doing in-memory filtering — expensive and inaccurate at scale.

**Pure graph database with vector plugin (e.g., Neo4j with vector index)**  
Rejected as the sole store. Neo4j's vector search is improving but not as performant or flexible as a dedicated vector store for high-throughput similarity queries. Neo4j is used as the graph database; Qdrant handles the vector search path.

**Single document store with metadata filtering (e.g., Elasticsearch)**  
Rejected. Metadata filtering approximates graph traversal but cannot represent typed, directional edges or multi-hop paths. Contradiction detection and impact analysis would be unreliable.

## Consequences

- Processing pipeline must write to two stores atomically — failure handling required (write to graph first, then vector; vector write failure triggers retry)
- Query layer must join results across both stores — adds complexity but enables the full query capability set
- At POC scale (< 10 projects, < 100k nodes), operational overhead is manageable
- If scale demands, Qdrant → Pinecone migration is straightforward (same API shape); Neo4j Community → Neo4j Enterprise (or a managed graph service) requires operational changes but no schema mapping
