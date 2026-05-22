---
sidebar_position: 1
---

# ADR-001: Hybrid Brain Store

**Status:** Accepted | **Date:** 2026-05-15

## The problem

The brain must serve two retrieval patterns that are fundamentally at odds with each other in terms of what database architecture they require.

**Semantic retrieval:** "Find decisions related to authentication." The input is a natural language query. The output is a ranked list of content chunks that are semantically similar to the query, even if they don't share exact keywords. This requires embedding every chunk into a vector space and doing nearest-neighbor search. No graph database does this well natively.

**Causal traversal:** "What does merging this PR affect downstream?" The input is a starting node. The output is a subgraph: all nodes reachable via specific edge types (`AFFECTS`, `IMPLEMENTS`, `REFERENCES`) up to a specified depth. This requires a graph database with typed, directional edges. No vector store can do this — metadata filtering approximates graph traversal but cannot represent multi-hop paths or directional edge types.

The two requirements are genuinely incompatible in a single store. The question is whether the cost of maintaining two stores is worth the benefit of serving both patterns properly.

## The decision

Two stores, always in sync:

**Qdrant** (self-hosted via Docker) for semantic retrieval. Every ingested chunk is embedded and written to Qdrant with metadata that links back to the Neo4j node: `graph_node_id`, `project_id`, `source`, `source_url`, `actor`, `timestamp`, `has_decisions`.

**Neo4j 5 Community** (self-hosted via Docker) for the knowledge graph. Every Decision, Event, Person, Ticket, and DriftAlert is a node. Every relationship between them is a typed, directional edge. Neo4j is the source of truth — graph writes happen first, vector writes follow.

The query layer joins across both: vector search produces candidate chunk IDs, which are mapped to `graph_node_id` to look up their graph neighborhood in Neo4j, which produces related nodes that are then fetched from Qdrant for additional context.

## What was rejected and why

**Pure Pinecone (or any pure vector store):** Cannot traverse `CHALLENGES` or `AFFECTS` edges. Impact analysis and drift detection would require loading all candidate chunks into memory and doing in-memory filtering — expensive, unscalable, and inaccurate for multi-hop paths. A chunk semantically similar to "auth module" does not automatically include everything that the auth module `AFFECTS`.

**Neo4j with vector index only:** Neo4j has an improving vector index. At POC scale it works. The concern is that Neo4j's vector search is not the primary strength of the database, and for high-throughput semantic similarity queries, a dedicated vector store outperforms it in flexibility and query expression. More importantly, future migration to a managed Qdrant instance or Pinecone would be straightforward (same API shape) — the migration risk is low if the vector store is isolated.

**Elasticsearch with metadata filtering:** Elasticsearch approximates graph traversal via metadata filtering, but cannot represent typed directional edges or multi-hop traversal paths. Contradiction detection requires "find all Decision nodes where the description is semantically similar to this new decision, and where scope overlaps" — this is not expressible in metadata filters.

**Single document store (MongoDB, Postgres):** Could store the graph as adjacency lists, but traversal performance degrades badly at multi-hop depth and cannot use graph-native algorithms.

## The tradeoff

The cost of maintaining two stores is real. The processing pipeline must write to both atomically. Failure handling is required — graph write succeeds, vector write fails, event goes to retry queue. The query layer must join across both stores, adding complexity. At POC scale (< 10 projects, < 100K nodes) this is manageable.

The benefit is that both retrieval patterns work properly. Semantic similarity search is fast and flexible. Causal traversal is exact and multi-hop. Neither compromises the other.

Migration path if scale demands it: Qdrant to Pinecone is a straightforward API swap. Neo4j Community to Neo4j Enterprise (or a managed graph service) requires operational changes but no schema mapping.

## Implementation reality

The dual-write pattern creates one practical gotcha: if a worker crashes after writing to Neo4j but before writing to Qdrant, the graph node exists but is not searchable via vector query. The retry queue (`retry:qdrant_writes`) handles this. On startup, items in `retry:qdrant_processing` are moved back to `retry:qdrant_writes` and re-attempted.

This is the only significant operational complexity added by the hybrid architecture. It has not caused correctness issues in practice — the worst case is that a Decision node is not semantically searchable for a few minutes until the retry succeeds.
