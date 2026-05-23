# purpl-brain: Technical Deep Dive
### For the builder who wants to understand it deeply and explain it to anyone

**How to use this document:** this is a preparation document, not a product spec. Read it before technical conversations, recruiter calls, or community discussions. Every section answers: what is it, why was it built this way, what was seriously considered instead, and what a sharp audience is likely to ask.

**Framing:** this is a side project built to find out whether a shared decision log for human-agent teams would actually hold up. The system works end-to-end for one developer plus AI agents. Team-scale validation has not happened yet. That is the open question.

---

## How to use this document

This document is written to do two things at once. First: teach you the AI and systems concepts behind every decision in this product, from scratch, as if you have strong software intuition but have not spent years building AI systems. Second: give you the vocabulary and reasoning to handle a technically sharp audience who asks hard questions.

Every section follows the same structure: what it is, why we built it this way, what we seriously considered instead, and what question a sharp engineer is likely to ask about it.

---

## Part 1 — What This Product Actually Does

Before getting into AI, it helps to understand the problem in purely human terms.

Software teams produce enormous amounts of knowledge every day — in Slack threads, GitHub PR descriptions and review comments, Jira tickets, design meeting recordings, and now increasingly in AI agent sessions. Almost all of that knowledge is immediately lost as a findable artifact. It lives in someone's browser history, or in a Slack channel that nobody searches, or in a PR that was merged six months ago.

The consequence: the same decisions get re-debated. New engineers and new agents re-derive context that already exists. A change gets merged that contradicts a design decision made in a meeting that nobody remembers. An AI agent picks up a task and makes different choices than the last agent who worked on the same codebase, because it has no memory of what that agent decided.

**purpl-brain is a living memory for the team.** It watches every signal channel (GitHub, Slack, Jira, meetings, AI agent sessions), extracts the knowledge embedded in those signals, stores it in a structured and searchable form, and serves it back to anyone — human or AI agent — who needs it.

The specific things it can answer:

- "What decisions have been made about the auth module, and who made them?"
- "What changed in the codebase this week and does any of it conflict with earlier decisions?"
- "An AI agent is starting a task on this ticket — what context should it know?"
- "We're considering adding feature X — what existing decisions does it affect?"

---

## Part 2 — The Core Insight That Makes This Different

Most knowledge management tools are archives. You put things in; you search for them; you get back what you put in.

This product is not an archive. It is an **inference engine** over team knowledge. The distinction matters:

An archive returns documents. This system returns **answers grounded in evidence**, tracing a chain from the answer back to the specific Slack message, PR comment, or meeting segment that supports it.

An archive does not know that two documents contradict each other. This system **detects contradictions** and alerts the team when a new decision conflicts with a prior one.

An archive treats AI agents as users who read from it. This system treats AI agents as **first-class actors who both read from and write to it** — an agent's decisions during a coding session are ingested, stored, and served as context to the next agent or human who works on the same problem.

That last point is the gap this system is built to fill. Most agent memory systems (Mem0, Zep, Microsoft Foundry Agent Memory) capture what agents *did* — facts and actions extracted automatically from conversation transcripts. None of them have a write path where agents explicitly log structured reasoning with rationale and alternatives. None of them put agent decisions and human decisions into the same graph. The human knowledge layer (Slack, Jira, meetings, GitHub reviews) and the agent knowledge layer remain separate silos in every existing system.

---

## Part 3 — AI Concepts Explained From Scratch

This section explains the AI building blocks used in this product without assuming you have used them before.

### 3.1 What is an embedding?

An embedding is a way of converting text into a list of numbers — typically several hundred numbers — such that texts with similar meaning end up with similar numbers.

Concretely: if you embed the sentence "we decided to use short-lived JWTs for authentication" and the sentence "the team agreed on 15-minute JWT expiry for security", the resulting number lists will be close to each other in mathematical space. If you embed "the quarterly revenue report", the resulting numbers will be far away from both.

This is not keyword matching. The similarity is semantic — it captures meaning, not just word overlap. Two sentences can use completely different words and still end up close in embedding space, if they describe the same idea.

**Why this matters for this product:** when a user asks "what decisions were made about auth?", we embed the question, then find all stored content whose embedding is close to the question's embedding. This finds relevant content even when the stored content uses different words than the question.

### 3.1.1 What are dimensions and why does the number matter?

The list of numbers produced by an embedding model is called a **vector**. Each number in the list represents one "dimension" of meaning. This product uses 768-dimensional vectors — meaning every piece of stored text becomes a list of 768 numbers.

A helpful analogy: imagine rating a movie on 768 different scales simultaneously (how much action, how much romance, how dark the tone is, how much it deals with family, and so on). Two movies with similar ratings across most of those 768 scales would end up "close" to each other. That is exactly what an embedding model does with text — it scores every piece of text on 768 abstract learned dimensions of meaning.

**Why the number 768 is fixed and non-negotiable for this system:** the Qdrant collection (the database that stores embeddings) is created with a fixed vector size at setup time. Once created with 768 dimensions, every vector stored in it must have exactly 768 numbers. Storing a 512-dimensional or 1536-dimensional vector fails immediately. This is not a limitation of the design — it is the correct behaviour, because vectors of different sizes are mathematically incomparable.

### 3.1.2 What model generates the embeddings?

This product uses two embedding models depending on the deployment configuration:

**Local development (default):** `nomic-embed-text:v1.5`, run locally via Ollama — a tool that runs AI models on your own machine. nomic-embed-text is an open-source embedding model that produces 768-dimensional vectors natively. It requires no API key, costs nothing per call, and runs on a developer's laptop in under 50ms per embedding. It performs competitively on standard embedding benchmarks (MTEB) for general and technical English text.

**Cloud / production (when `PROVIDER=anthropic`):** OpenAI's `text-embedding-3-small`. This model natively produces 1536-dimensional vectors, but the code requests 768 dimensions explicitly using OpenAI's dimension reduction feature. This keeps the vector size identical to the local model so the same Qdrant collection works in both environments. OpenAI's model has slightly higher benchmark scores for some domains, and the cost is $0.02 per million tokens — negligible for the query volume of a small team.

**Why two models?** Developers running the system locally should not need an OpenAI API key or pay per embedding call during development. nomic-embed-text via Ollama is free, fast, and good enough. In production, where reliability and benchmark quality matter more than cost of development setup, OpenAI's model is the more defensible choice.

### 3.1.3 What is cosine similarity?

To measure how "close" two vectors are — and therefore how similar two pieces of text are — this system uses **cosine similarity**. It is a score between -1 and 1:

- **1.0** means the two vectors point in exactly the same direction — the texts have essentially the same meaning.
- **0.0** means the vectors are perpendicular — the texts are unrelated.
- **-1.0** means the vectors point in opposite directions — theoretically opposite meaning (rare in practice for natural language).

In this product, a cosine similarity above **0.72** between a new decision and an existing one triggers the drift detection pipeline (meaning: these two decisions are about the same topic and may contradict each other). This threshold was calibrated pre-beta: the original threshold of 0.55 produced 15-30 alerts per day at 10-agent scale, which exceeded practical triage capacity. Raising it to 0.72 trades recall for precision — it catches near-identical contradictions while filtering semantically adjacent but non-conflicting decisions. The threshold is a configuration parameter, not a hard architectural constant.

The name "cosine" comes from the fact that it measures the cosine of the angle between the two vectors in 768-dimensional space. The intuition is: if you were standing at the origin and pointing at two different directions, how similar are those directions? Length does not matter — only direction. This makes cosine similarity robust to text length: a long paragraph and a short summary of the same idea can have cosine similarity close to 1.0.

### 3.1.4 Why switching embedding models breaks the system — and why this is a safety feature, not a bug

This is one of the most important things to understand about how the system is built.

**The fundamental problem:** vectors from different embedding models are incomparable. Two models do not share a common notion of "similar direction." If you stored 10,000 vectors using nomic-embed-text and then switched to OpenAI's model, a new query's embedding (from OpenAI's model) would produce cosine similarity scores against stored embeddings (from nomic) that are effectively random — not high, not low, just meaningless. The system would return the wrong results with no error, silently. This is the worst possible failure mode: wrong answers that look right.

**The analogy:** imagine two people both claim to measure temperature, but one uses Celsius and the other uses Fahrenheit. A measurement of "37" from one and "37" from the other are not the same temperature. If you compare them without knowing the scale mismatch, you will draw wrong conclusions — and there is no obvious signal that anything is wrong.

**The protection built into this system:** at startup, the API reads the name of the embedding model that was used to populate the current Qdrant collection (stored in collection metadata). It compares this to the model currently configured in the environment. If they do not match, the API refuses to start:

```
FATAL: embedding model mismatch — cannot start query layer safely.
  Stored in Qdrant collection: nomic-embed-text:v1.5
  Currently configured:        text-embedding-3-small
  Re-embed the collection before restarting.
```

This crash-on-mismatch is intentional. A silent mismatch would be far more damaging than a refused startup.

**What "re-embedding" means:** if you legitimately want to switch models (for example, upgrading nomic-embed-text to a newer version, or migrating from local to cloud), you must:
1. Delete the existing Qdrant collection (erasing all stored vectors).
2. Re-create the collection with the new vector size (if the new model has different dimensions).
3. Re-run the full ingestion pipeline against all historical events to re-embed everything with the new model.
4. Update the stored model name in collection metadata.

This process can take hours for large datasets. It is the correct cost of switching models — the alternative (silently serving wrong results) is not acceptable for a system whose purpose is reliable, citable answers.

**Why you also cannot switch to an Anthropic embedding model even though the LLM is Anthropic:** Anthropic does not currently offer a standalone embedding model API. The LLM (for extraction and answer generation) is Anthropic's Claude. The embedding model is either nomic-embed-text (locally) or OpenAI's text-embedding-3-small (cloud). These are separate concerns: the LLM generates text, the embedding model converts text to numbers. They do not have to be from the same provider.

### 3.2 What is a vector database?

A vector database is a database optimised for one specific query: "given this list of numbers, find me the stored items whose numbers are most similar." This query is called approximate nearest-neighbor search.

Regular databases (SQL, for example) are fast at exact lookups ("find all rows where status = 'open'") but terrible at similarity queries. You cannot ask PostgreSQL to "find the ten rows most similar in meaning to this sentence" — it has no concept of semantic distance.

Qdrant is the vector database used in this product. It stores each embedded chunk of text alongside its embedding, plus metadata (source, timestamp, project, actor). When a query comes in, Qdrant returns the top-K most semantically similar chunks in about 100ms.

**Tradeoff:** approximate nearest-neighbor search is approximate. It trades perfect recall for speed. At the scale of this product (tens of thousands of chunks, not billions), the approximation error is negligible.

### 3.3 What is a graph database?

A graph database stores data as nodes (things) and edges (relationships between things), rather than as rows and columns.

In this product, nodes include: `Event` (a Slack message, a PR, a meeting segment), `Decision` (an extracted conclusion), `Ticket` (a Jira issue), `Person`, `DriftAlert`. Edges include: `EXTRACTED_FROM` (this Decision came from this Event), `AUTHORED_BY` (this Event was created by this Person), `CHALLENGES` (this new Decision conflicts with that older one), `REFERENCES` (this PR mentions this ticket), `INFORMS` (this Decision influenced this Ticket).

The power of a graph database is **traversal**: you can follow edges efficiently across many hops. "Find all tickets that depend on decisions that came from this PR" is a three-hop graph traversal. In a relational database, this would require three joins with careful indexing. In Neo4j, it is a Cypher query that runs in milliseconds.

**Why the product needs both:** vector search finds semantically similar content. Graph traversal finds causally related content. They answer different questions, and both are necessary. A semantic search for "auth module decisions" finds the Slack thread where JWTs were discussed. A graph traversal from a newly merged PR finds every decision, ticket, and agent session that depends on the code that PR changed.

### 3.4 What is RAG?

RAG stands for Retrieval-Augmented Generation. It is the most widely used pattern for making a language model answer questions about information it was not trained on.

The pattern has three steps:

1. **Retrieve** — given a user's question, find the most relevant chunks of your knowledge base (using vector search, graph traversal, or both)
2. **Augment** — assemble those chunks into a context window and give them to the language model
3. **Generate** — have the model produce an answer *based only on what you gave it*, citing the specific chunks it drew from

RAG solves the fundamental limitation of a language model: it only knows what it was trained on, which has a knowledge cutoff date and does not include your team's private information. RAG lets you inject current, private, specific information into every answer.

**The critical discipline in this product's RAG implementation:** the model is explicitly instructed never to answer beyond what the retrieved sources support. If the sources don't contain the answer, the model says so — it does not invent an answer. This is enforced through the prompt contract (discussed in Part 6) and a post-generation citation validator.

### 3.5 What is a large language model (LLM) in this context?

This product uses two Anthropic models:

- **Claude Haiku** for fast, cheap classification tasks — determining what kind of query the user is asking, routing to the right retrieval mode. Haiku is small, fast, and inexpensive.
- **Claude Sonnet** for answer generation — reading the retrieved context and producing a grounded, cited answer. Sonnet is larger and more capable; it produces better reasoning and better writing.

In the extraction pipeline, the LLM's job is to read raw content (a Slack thread, a PR description, a meeting transcript) and identify structured decisions: what was decided, by whom, why, with what confidence. This is the most quality-critical step in the system — everything downstream depends on the quality of what gets extracted.

### 3.6 What is prompt caching?

Every time you call an LLM API, you pay for the tokens in the prompt. For this product, the system prompt — which includes extraction rules, output schema, citation instructions, and agent persona — is thousands of tokens long and is the same across every call in a session.

Prompt caching lets the provider (Anthropic) keep the first N tokens of a prompt in a fast cache. On the first call, you pay 1.25× the normal rate to write to cache. On subsequent calls that share the same prefix, you pay only 0.1× — a 90% reduction.

**In practice:** for this product's extraction pipeline, the system prompt and schema are cached. Each extraction call sends a new document chunk as the volatile suffix, but the large stable prefix is served from cache. At scale, this reduces LLM costs by 60–80%.

**What breaks caching (and why it matters):** any change to the text that appears before the cache breakpoint invalidates the cache. The most common mistake is including a timestamp or a randomly generated request ID in the system prompt. The system looks identical to a human reading it, but the bytes are different on every call, so the cache never hits. The cost control document in this repo lists the specific anti-patterns and their fixes.

---

## Part 4 — The Architecture, Layer by Layer

### 4.1 The ingestion layer

This is how information enters the system.

**Webhooks (the primary path):** GitHub, Slack, Jira, and Linear all support webhooks — they push an HTTP request to this system within seconds of an event happening. A PR is merged: GitHub sends a webhook. A Slack thread receives a reply: Slack sends a webhook. A Jira ticket transitions to "Won't Fix": Jira sends a webhook.

**Why webhooks over polling:** the alternative is polling — asking GitHub "anything new since I last checked?" on a timer. Polling has two problems. First, it introduces lag equal to the poll interval (5 minutes polling = up to 5 minutes for the brain to learn about a PR merge). Second, it burns API rate limits proportionally to poll frequency. Webhooks are near-real-time (< 30 seconds) and rate-limit-friendly because the source system only sends events when something actually happens.

**The deduplication guarantee:** every event entering the system carries a deduplication ID derived from the source system's native ID. Before processing, the system checks whether this ID has been seen before. Webhooks can and do deliver the same event multiple times (network hiccups, retries). Without deduplication, the same PR merge could create duplicate Decision nodes and corrupt the knowledge graph.

**The Redis Streams queue:** when a webhook arrives, the ingestion endpoint does one thing: write the raw event to a Redis Stream and return 200 OK. This makes the webhook endpoint extremely fast (milliseconds) and decouples receipt from processing. The processing pipeline reads from the stream at its own pace. If processing is slow or fails, events queue up safely in Redis without affecting webhook delivery.

**Fallback for historical data:** webhooks only deliver future events. To ingest historical data (all past GitHub PRs, past Slack threads, past Jira tickets), seed scripts exist that call the source APIs directly and submit events through the same pipeline. This means the brain can be bootstrapped with months of history before a team's first real query.

### 4.2 The processing pipeline

Three workers process each event in sequence:

**Normalizer:** converts the source-specific format into the canonical event schema. A GitHub PR event, a Slack message event, and a Jira transition event all have completely different JSON structures from their respective APIs. The normalizer translates each into a consistent format with the same fields: `event_id`, `source`, `actor`, `timestamp`, `raw_content`, `url`. Downstream components never need to know where an event came from — they work with the canonical format.

**Extractor:** this is where AI is applied. The extractor reads the normalised event and identifies structured knowledge: decisions made, action items, entity references (people, tickets, PRs, technologies). This is explained in depth in Part 5.

**Brain-writer:** takes the extractor's output and writes it into both storage systems — Neo4j (graph) and Qdrant (vector). It also runs the drift detector to check whether any new Decision contradicts an existing one.

**Why three separate workers instead of one?** Separation of concerns and independent scaling. The normalizer is fast (no LLM calls). The extractor is slow (LLM call for decision candidates). The brain-writer has its own failure modes (network calls to Neo4j and Qdrant). Separating them means a failure in one does not block the others, and each can be scaled or retried independently.

### 4.3 The brain store

Two databases, kept in sync by the brain-writer.

**Qdrant (vector store):** stores chunks of text as embeddings with metadata. Every event is chunked into pieces small enough to fit in a context window, embedded, and stored in Qdrant with the event ID, source, timestamp, and project ID as metadata. Qdrant serves similarity queries in the retrieval phase of every user query.

**Neo4j (graph database):** stores the structured knowledge graph. Nodes, edges, properties. Provides the relational traversal that pure vector search cannot: "find everything downstream of this decision," "find all decisions that contradict this one," "find all events authored by this person in this project." Also stores the temporal history — every node has `valid_from` / `valid_to` timestamps, enabling point-in-time queries.

**Write order and failure handling:** the brain-writer writes to Neo4j first, then Qdrant. If the Neo4j write fails, neither store is updated (the event stays in the queue for retry). If the Neo4j write succeeds but the Qdrant write fails, the event goes into a retry queue specific to Qdrant writes. This means Neo4j is the authoritative store — Qdrant may lag temporarily, but Neo4j is always consistent. A query can succeed from Neo4j alone if Qdrant is behind.

### 4.4 The query layer

Translates a natural language question into a grounded, cited answer. Five stages:

**Stage 1 — Intent parsing:** a fast Haiku call classifies the question into one of five modes (project-scoped, temporal, expertise-scoped, agent-resume, impact analysis) and extracts structured parameters (project ID, time range, entity references). This takes ~400ms.

**Stage 2 — Retrieval (runs in parallel with intent parsing):** the raw query is embedded immediately — before intent parsing finishes. Vector search on Qdrant starts with that embedding. When intent parsing finishes, its filters are applied to the already-running search. This saves ~400ms by running embedding + vector search in parallel with the LLM intent parse. After vector search returns top-K chunks, graph traversal expands the result set via three parallel Neo4j patterns: decision chain (other events sharing the same decisions), author activity (recent events by the same person), and ticket linkage (events co-referencing the same tickets). Graph expansion is what makes this better than plain RAG — it pulls in causally related content that vector similarity alone would miss.

**Stage 3 — Context budget:** the retrieval result is ranked and trimmed to a 6,000-token context budget. Exact entity matches (the user specifically asked about PR #234, and PR #234 is in the results) are never dropped. High-similarity chunks are dropped last. Graph-expanded neighbors are dropped first. Chunks that are dropped are also removed from the citation list — the LLM cannot cite what it cannot see.

**Stage 4 — Answer generation:** Sonnet reads the retrieved context and produces an answer with inline citations. The prompt contract is strict: every claim must cite a source; if the sources are insufficient, the model says so rather than inventing an answer. The response is streamed — the user sees content arriving ~1 second into the LLM call rather than waiting for the full answer.

**Stage 5 — Citation validation:** after the answer is generated, a post-processing step verifies that every cited source number corresponds to a real chunk in the context. This catches hallucinated citations — cases where the LLM asserts `[3]` for a claim but source 3 says something unrelated. In the current implementation, a failed citation validation returns the answer with a warning flag.

### 4.5 The anomaly engine

Runs after every brain update. Two modes:

**Drift detection:** after a new Decision is written to the graph, the system embeds the decision text and compares it against all existing Decisions for the same project using Qdrant similarity. If a new decision is semantically close to an existing one (threshold: cosine similarity > 0.72, calibrated pre-beta from an initial 0.55), it flags the pair for LLM confirmation. The LLM reads both decisions and determines whether they genuinely contradict each other or are just about the same topic but compatible. Confirmed contradictions create a `CHALLENGES` edge in the graph and a `DriftAlert` node.

**Impact analysis:** given any starting node (a PR, a ticket, a decision), traverses the graph following `affects`, `implements`, and `references` edges to depth 3 (direct dependencies, their dependencies, transitive effects). Returns a ranked list of everything the starting node touches. This is the "what does this change affect?" query that normally requires a senior engineer to answer from memory.

**Two-stage drift detection design:** the first stage (vector similarity) is cheap and runs on every event. The second stage (LLM confirmation) is expensive and runs only when similarity is high. This filters out the ~95% of decisions that are not close to anything existing, so the LLM only pays for the cases that actually need judgment. Without the first stage as a filter, the cost of running LLM confirmation on every decision would be prohibitive.

### 4.6 The MCP server

MCP (Model Context Protocol) is Anthropic's open standard for how AI agents access external tools and context. Any MCP-compatible agent (Claude Code, Cursor, or a custom agent) can connect to the brain's MCP server and use four tools:

- `brain_query` — ask the brain a natural language question
- `brain_log_decision` — write a structured decision log from an agent session into the brain
- `brain_analyze_impact` — before making a significant change, check which existing decisions it might affect
- `brain_log_signal` — report an unexpected finding that may contradict what the brain believes

**Why MCP instead of a custom API SDK?** If the brain exposed only a bespoke REST API, every new agent runtime would require a custom integration. With MCP, any runtime that speaks MCP (and the list is growing) gets access for free. The standard is agent-framework-agnostic — it works regardless of whether the agent is built on LangChain, LlamaIndex, the Claude API directly, or a custom stack.

**Two transports:** stdio (for local use — the MCP server is a subprocess of the agent runtime) and HTTP+SSE (for remote use — the MCP server is a network service, required for cloud deployment). The same business logic serves both; transport is a configuration choice.

---

## Part 5 — Entity Extraction: The Hardest Part

This is the component that most directly determines the quality of everything else. If extraction is bad, the knowledge graph is wrong, and every query answer is wrong. It deserves a detailed treatment.

### 5.1 The core challenge

Extracting ticket numbers and people's names from text is a regex problem. The genuinely hard problem is extracting **decisions** — conclusions that are often:

- Implicit ("ok we're going with JWT" does not say "we decided to use JWT", but it is clearly a decision)
- Fragmented across multiple messages in a thread
- Expressed differently depending on the medium (written PR description vs. spoken meeting language)
- Indistinguishable from suggestions, open questions, and rejected ideas unless you have the full conversational context

A system that only extracts explicit "we have decided to..." statements misses the vast majority of real team decisions.

### 5.2 Two-pass approach: cheap first, LLM second

Running an LLM call on every ingested event would be expensive and slow. The two-pass approach reduces LLM calls by approximately 65%.

**Pass 1 (rule-based, runs on every event):** a fast, deterministic pre-filter using phrase matching. A curated list of decision marker phrases — "we decided", "agreed to", "going with", "let's go with", "won't fix", "moving forward with", plus a separate list of spoken-language markers for meeting transcripts — determines whether the event is a decision candidate. If no markers match, the event is processed for entity references (tickets, people, dates, technologies) but skipped for the expensive LLM extraction. This pass also extracts ticket numbers via regex, people via @-mention patterns, dates via natural language date parsing, and technology keywords via a curated fuzzy-match list.

**Pass 2 (LLM, runs only on decision candidates):** Claude reads the full content and extracts structured decisions: description (what was decided), rationale (why, if stated), confidence (high/medium/low), decision maker, scope, reversibility, and a mandatory quoted text that must appear verbatim in the source. If the LLM cannot quote the source text, confidence must drop to medium or low. This prevents the model from inventing decisions that were not actually stated.

### 5.3 Source-specific extraction strategies

The extraction unit — what text you give the LLM — differs by source and matters enormously.

**Slack:** the extraction unit is the full thread, not individual messages. Decisions in Slack are almost always distributed: someone asks a question, others debate, one person announces the conclusion, others react. A single message ("ok we're going with JWTs") loses the rationale that appeared two messages earlier. The full thread gives the LLM the context to fill in why the decision was made. Reaction signals (👍 from 2+ people on a message containing a decision marker) increase the confidence score by 0.15 — this is metadata, not text, so it is applied after the LLM call as a modifier.

**GitHub PRs:** three extraction zones with different signal densities. PR description is high-trust — this is where the author explains their choices. Review comments are medium-trust but often the most valuable — a reviewer saying "don't use this approach because X, use Y instead" followed by the author switching to Y is a complete decision with rationale. The merge event itself is an implicit decision confirmation. Review comments are extracted as units (comment + reply chain), not individually.

**Jira/Linear:** status transitions are implicit decisions that must be mapped explicitly. A "Won't Fix" transition means "decided not to implement this." A "Deferred" transition means "decided to deprioritise this." The rationale is almost never in the transition — it's in the most recent comment before the transition. The extractor reads back to find that comment as the candidate rationale source.

**Meeting transcripts:** the noisiest source. The extraction unit is a sliding window of three segments — the current segment plus two preceding ones — because meeting rationale typically precedes the decision announcement by one to two speaker turns. Speaker attribution must be preserved: "Alice: let's go with JWT" is more informative than just "let's go with JWT" because the speaker's role affects confidence.

**Agent logs:** no LLM extraction needed. Agent logs are already structured — the decisions are explicitly labeled by the agent that emitted the log. These are the highest-confidence inputs to the system, because the agent itself identified what it decided.

### 5.4 Confidence scoring

Four signals combined into a final score:

- Linguistic markers (weight 0.4): "decided", "agreed", "we will" → high; "let's", "plan to" → medium; "maybe", "could" → low
- Social confirmation (weight 0.3): multiple 👍 reactions or a senior team member confirming → high; single agreement → medium; no response → low
- Source authority (weight 0.2): a #decisions channel or an ADR file → high; a design discussion channel → medium; #random → low
- Rationale presence (weight 0.1): rationale explicitly stated → high; partial → medium; absent → low

The resulting score determines whether a decision is stored as a full-weight Decision node (≥ 0.7), a deprioritised Decision node (0.4–0.69), or a low-confidence candidate not surfaced in normal queries (< 0.4). Every decision is stored regardless of confidence — the confidence level determines how it appears in query results.

---

## Part 6 — The Citation Contract

This is one of the most important design decisions in the product, and the one that most distinguishes it from a typical chatbot or search tool.

**The problem with unconstrained LLM answers:** a capable language model will always produce a fluent, confident answer. If the context it was given does not actually support the answer, it will fill the gap from its training data or from inference. The user has no way to tell whether the answer came from their team's actual documents or from the model's general knowledge.

**The citation contract:** the system prompt for answer generation includes strict rules that the model cannot deviate from:

1. Every factual claim must include an inline citation (e.g., `[1]`, `[2]`) referring to a numbered source.
2. No claim may appear without a supporting source.
3. If the retrieved sources do not contain enough information to answer, the model must say so explicitly: "The brain does not have sufficient information to answer this question."
4. The model may never extrapolate, infer, or generalise beyond what the sources directly state.

After the answer is generated, a post-processing step verifies that every cited number corresponds to a real chunk in the context, and that the cited chunk contains at least one key term from the associated claim. This catches hallucinated citations — a real failure mode where the model confidently cites "source [3]" for a claim, but source 3 says something entirely different.

**Why this matters for a tech audience:** it converts the product from "a chatbot that might be right" into "a lookup tool with a verifiable audit trail." Every answer can be independently verified. The user can click a citation and see the exact Slack message, PR comment, or meeting segment the claim came from, with timestamp and author. This is the property that makes the system trustworthy enough for teams to rely on it for architectural decisions.

---

## Part 7 — Agent Write-Back: The Novel Loop

The most architecturally novel aspect of this product is that AI agents are not passive consumers of the brain — they are writers.

### 7.1 The problem it solves

An AI coding agent (Claude Code, a Cursor agent, a custom agent built on the Anthropic API) makes dozens of decisions during a session: which library to use, how to structure a module, what error handling approach to take, which alternative to reject and why. These decisions are made in the context of the task, are often well-reasoned, and are completely invisible to the rest of the team and to any future agent working on the same codebase.

The consequence: two agents working on related tasks at different times make inconsistent choices, because neither knows what the other decided. A human engineer reviews the work and cannot understand why the code looks the way it does, because the agent's reasoning was never recorded. A senior engineer who would have pushed back on a specific choice has no visibility into what was decided.

### 7.2 The structured decision log

Agents emit a structured JSON log at session end (or at defined checkpoints). The schema includes:

- `session_id`, `agent_id`, `task_id`, `codebase`, `timestamp_start`, `timestamp_end`
- `decisions[]` — each with: description, rationale, alternatives considered, confidence
- `work_completed` — what was built
- `unresolved` — questions or blockers the agent did not resolve
- `next_steps` — recommended follow-on actions
- `files_modified` — which files were touched

This log is submitted to `POST /brain/agent-log`, processed through the same pipeline as human-generated events, and stored in the same knowledge graph. Agent decisions are treated with the same weight and visibility as decisions made in a meeting or Slack thread.

### 7.3 Write-back compliance in practice

The system depends on agents calling the write API. Compliance is not 100%.

From observed usage (rough estimates, not controlled measurements):

- **Claude Code + CLAUDE.md + session-end Stop hook:** ~85-90%. The hook acts as a safety net — if the session ends without a log, it prompts the agent for a retrospective before closing.
- **Claude Code + CLAUDE.md, no hook:** ~60-70%. Roughly one session in three produces nothing, not because the agent is broken but because coding work absorbs attention and logging feels like overhead.
- **Cursor:** ~40-60%. Cursor has no hook system, so the session-end safety net is unavailable.

The sessions most likely to skip logging are the highest-stakes ones — where the agent hit something unexpected and pivoted. This skew is the hardest problem: the missing 10-15% is weighted toward exactly the cases where missing a log hurts most.

**The auto-extraction fallback:** if a session produces no log, a post-session extraction pass over the raw transcript can recover *what* was done but frequently misses *why* it was decided. A transcript that says "let me check... okay, I'll use Redis" doesn't contain the tradeoff analysis. Auto-extracted entries are flagged as lower confidence. The right framing: auto-extraction changes the failure mode from empty brain to noisy brain. An empty brain teaches users the system doesn't work. A noisy brain keeps them engaged long enough to fix the setup.

### 7.5 Why structured, not free text

A natural language session summary is easy to write. It is difficult to parse reliably for entity extraction, graph linking, or contradiction detection. A structured schema lets the processing pipeline treat agent decisions the same as human decisions — with typed graph edges, queryable fields, and a defined confidence level. The `schema_version` field in the log means breaking changes can be versioned without breaking historical data.

### 7.6 The read side

An agent beginning a session calls `brain_query` (or `GET /brain/agent-resume`) with its task ID. The brain returns:

- Relevant prior decisions from previous agent sessions on the same codebase
- Human decisions about the same modules, from PRs and meetings
- Open drift alerts that affect the area being worked on
- A diff: "since the last agent session ended, these PRs were merged and these decisions were changed"

The drift diff is what makes agent resume qualitatively different from just reading a session log. Without the diff, you get a historical record. With the diff, you get: "the agent decided X three days ago, but PR #89 merged yesterday and changed the auth module the agent relied on."

---

## Part 8 — Cost Controls at Scale

LLM API calls are expensive. Every architectural decision about when to call an LLM, which model to use, and how to structure the call has cost implications.

### 8.1 Model tiering

**Haiku** for fast, cheap tasks: intent parsing (classifying a query into a mode), simple entity extraction on short events. Haiku is approximately 25× cheaper per token than Sonnet and fast enough for latency-sensitive paths.

**Sonnet** for quality-sensitive tasks: answer generation (where the output quality directly affects user trust), complex decision extraction from long documents.

No call in this product uses Opus (the most capable but also most expensive model) for production inference. Opus is appropriate for one-time research, evaluation, and architectural reasoning — not for per-event extraction calls.

### 8.2 The two-pass extraction filter

As described in Part 5: running LLM extraction only on decision candidates (approximately 35% of events) rather than all events reduces LLM costs by ~65% on the extraction path. The rule-based first pass costs essentially nothing.

### 8.3 Prompt caching

The system prompt for extraction and query calls is large (thousands of tokens) and identical across every call in a session. Anthropic's prompt caching reduces the cost of re-sending this stable prefix from full price to 10% of full price after the first call. At scale, this is a 60–80% reduction in the cost of the stable portion of every API call.

The implementation discipline required: the stable prefix must be byte-for-byte identical across calls. Any dynamic content (timestamps, random IDs, per-request state) must be moved to the volatile suffix, after the cache breakpoint. A single timestamp in the system prompt breaks caching for every call, permanently, with no error message — the only signal is `cache_read_input_tokens = 0` in the API response.

---

## Part 9 — Tradeoffs: What Was Seriously Considered and Rejected

| Decision | What was built | What was rejected | Why |
|---|---|---|---|
| **Brain store** | Qdrant (vector) + Neo4j (graph) | Pure vector store (Pinecone only); Pure graph with vector plugin | Vector alone cannot traverse causal chains. Graph plugin search degrades quality at scale. Two dedicated stores, one responsibility each. |
| **Embedding model (local)** | `nomic-embed-text:v1.5` via Ollama (768 dims) | `text-embedding-3-small` for all environments; no local model | nomic-embed-text runs free on a developer's laptop with no API key. Using a remote API for local dev adds cost, latency, and an internet dependency. Both models produce 768-dim vectors, keeping the Qdrant collection schema identical across environments. |
| **Embedding model (cloud)** | OpenAI `text-embedding-3-small` with dimension reduction to 768 | Anthropic embedding model; Cohere; nomic-embed-text cloud API | Anthropic has no standalone embedding API. OpenAI's model has strong MTEB benchmark scores and $0.02/M token cost. Dimension reduction to 768 keeps collection schema identical to local model. |
| **Vector size** | 768 dimensions across all environments | Different sizes per model (e.g. 1536 for cloud, 768 for local) | Qdrant collection schema is fixed at creation. Different sizes per environment would require maintaining two separate collections with different retrieval paths. 768 is supported natively by nomic-embed-text and via reduction by text-embedding-3-small. |
| **Agent interface** | MCP server + Python SDK (LangGraph/ADK) | Custom SDK per agent framework only | MCP is agent-framework-agnostic for IDE agents (Claude Code, Cursor). Python SDK covers orchestration-framework agents (LangGraph, ADK) that cannot use MCP. REST API available for any HTTP-capable agent. |
| **Ingestion** | Webhook-first, event-driven | Batch polling; Third-party integration platforms (Zapier, Make) | Polling cannot meet the 5-minute anomaly detection SLA without expensive high-frequency polling. Third-party platforms add latency, cost, and a critical-path dependency. |
| **Agent write-back** | Structured JSON schema | Read-only agents; Natural language summaries | Read-only misses the most valuable missing context (agent decisions). Unstructured summaries cannot be reliably parsed for graph linking and contradiction detection. |
| **Event queue** | Redis Streams | Kafka; Direct API calls (no queue) | Kafka adds significant operational overhead unjustified at POC scale. No queue = brittle, no backpressure, retries impossible. |
| **Extraction approach** | Two-pass (rule filter + LLM) | LLM on all events; Pure rules | LLM on all events is 65% more expensive; pure rules miss implicit and fragmented decisions. |
| **Citation model** | Strict grounding with post-gen validation | Unconstrained LLM answers | Unconstrained LLM answers hallucinate sources. The citation contract makes the system auditable and trustworthy. |
| **Historical reprocessing** | Full pipeline replay from `events:raw` | Schema migration scripts | Schema migrations require tracking all derived states. Replay from raw is simpler — wipe derived state, re-run with new schema. (Selective backfill is a planned improvement.) |

---

## Part 10 — Questions a Technical Audience Will Ask

These are the questions most likely to come from a senior engineering or ML audience, along with honest and well-reasoned answers.

---

**Q: Embedding models have a knowledge cutoff. How do you handle terminology that postdates the training data?**

Both embedding models used (nomic-embed-text locally, text-embedding-3-small in cloud) are trained on large general corpora and handle most software-engineering terminology well. For highly domain-specific or newly coined terms, embeddings may be less discriminative — the model has never seen the term, so it cannot place it precisely in semantic space. The practical mitigation is two-fold: (1) the graph traversal layer supplements vector search, so if two nodes share a ticket reference or a PR link, they are connected regardless of whether their embeddings are close; (2) the system stores `raw_content` on every Event node in Neo4j, so if a better embedding model is adopted in the future, historical data can be re-embedded by replaying from raw without re-fetching anything from source systems.

**Q: Why can't you just swap in an Anthropic or a better embedding model without consequences?**

You can — but it is a deliberate migration, not a configuration change. Swapping the embedding model invalidates every vector stored in Qdrant, because vectors from different models are mathematically incomparable (see section 3.1.4). The system detects the mismatch at startup and refuses to start rather than silently returning wrong results. To migrate: delete and recreate the Qdrant collection with the new vector size, re-run ingestion for all historical events, update the stored model name in collection metadata. This is the correct cost of a model upgrade. The `raw_content` field on every Event node in Neo4j is the re-embedding safety net — no data is lost, only the derived vectors need to be regenerated.

A common misconception: because the LLM is Anthropic's Claude, people assume the embedding model should also be from Anthropic. These are separate components with separate providers. The LLM produces text. The embedding model produces numbers. Anthropic does not currently offer a standalone embedding API, so the embedding model is necessarily from a different provider.

**Q: How do you know the embedding model is actually finding the right content — what is the recall?**

Formally, this is not benchmarked for the specific dataset of software team knowledge. The eval suite tests end-to-end query quality (does the answer correctly cite a known decision?) but does not isolate vector search recall as a separate metric. This is a known gap. The practical substitute is graph expansion: after vector search returns top-K chunks, the graph traversal layer adds causally related content (decisions sharing a ticket reference, events by the same author, linked PRs). This means even if a relevant chunk is ranked 11th by cosine similarity and falls outside the top-K, it may still be retrieved if it is graph-adjacent to something that was retrieved. The combined system has higher recall than pure vector search alone. A rigorous recall benchmark (constructing a gold-standard test set from known team decisions, then measuring how often the relevant chunk appears in the retrieved context) would be the right next engineering investment before moving beyond beta.

**Q: How do you prevent the LLM from hallucinating decisions that weren't made?**

Three mechanisms. First: the extraction prompt explicitly instructs the model to require a verbatim `quoted_text` from the source for any high-confidence decision — if it cannot quote, it must lower the confidence. Second: the confidence scoring system deprioritises low-confidence decisions in query results, so even if a borderline decision slips through, it does not appear prominently. Third: the citation validator in the query layer verifies that every claim in an answer is actually supported by the retrieved chunks.

**Q: What happens when two decisions genuinely aren't contradictory but are about the same topic — does the drift detector generate false positives?**

Yes, it can. The drift detector uses a two-stage design specifically to manage this. Stage 1 (Qdrant similarity above 0.85) is cheap and broad — it generates candidates, including false positives. Stage 2 (LLM confirmation) reads both decisions and determines whether they actually contradict each other or are merely related. Only confirmed contradictions produce a DriftAlert. The LLM confirmation step is the false-positive filter. The threshold for Stage 1 is tunable — lowering it catches more contradictions but increases LLM calls for confirmation.

**Q: How does the system handle identity — the same person appearing as @alice on Slack, alice@company.com in a meeting transcript, and github.com/alice_dev on GitHub?**

Currently, partial. The normalizer maps known patterns (GitHub usernames, Slack user IDs) to a canonical `Person` node using a lookup table seeded by the initial team configuration. Cross-source person deduplication — resolving that @alice, alice@company.com, and alice_dev are the same person without a lookup table — is Phase 3 work (identity resolution milestone). The planned approach is matching on shared email addresses (GitHub API provides email for verified accounts), fuzzy name matching, and co-occurrence patterns (if alice@company.com and alice_dev appear in the same meeting and the same PR review, they are probably the same person).

**Q: At what scale does the architecture break?**

The Qdrant + Neo4j combination at local / single-host scale handles up to approximately 10 projects and 100,000 nodes comfortably. Beyond that, Qdrant moves to a cloud-hosted instance (Qdrant Cloud has the same API, so it is a configuration change, not a code change). Neo4j Community Edition handles up to a few million nodes on a single server; beyond that, Neo4j Enterprise (or a migration to a managed graph service) is needed. The Redis Streams queue becomes a bottleneck at sustained ingestion rates above roughly 10,000 events per day — at that point, a Kafka migration is warranted. None of these thresholds are relevant for the current beta; they are the known scale ceiling.

**Q: An AI agent's decision log is attacker-controlled input. How do you prevent prompt injection from contaminating the knowledge graph?**

This is one of the identified security findings. The current pipeline trusts the content of agent logs for LLM extraction. A malicious or compromised agent could inject a decision log containing a prompt injection payload that influences downstream LLM extraction calls or, worse, a crafted `codegen_prompt` field that gets surfaced to other agents as "a task to execute." The mitigations in plan: (1) treat `codegen_prompt` and all agent-sourced content as untrusted text, not as instructions; (2) require human approval before any agent acts on a Task node derived from external input; (3) validate agent log structure strictly before any LLM call uses it.

**Q: Why Redis Streams instead of a proper message queue (RabbitMQ, SQS)?**

Redis Streams provides the features needed for this use case — consumer groups, at-least-once delivery, backpressure — with significantly simpler operations than a dedicated message queue. Redis was already in the stack for rate limiting and session state. Adding a message queue would mean a second infrastructure dependency and a second operational surface. At POC and early beta scale, Redis Streams is sufficient. The migration path to Kafka (for scale) or SQS (for managed infrastructure) is straightforward — consumer group semantics are the same, and the worker code abstracts the queue behind a `StreamWorker` base class.

**Q: How does this compare to Mem0? They score 94.4 on LongMemEval — isn't that better than what you have?**

Mem0's April 2026 algorithm scores 94.4 on LongMemEval, which measures cross-session recall — how well a system remembers facts from prior conversations. That benchmark measures a real and valuable capability. It does not measure whether the system captures *why* a decision was made, what alternatives were considered, or whether it can detect when a new decision contradicts an old one.

Mem0 intercepts at the application layer: you pass raw conversation turns, it extracts facts automatically, near-100% write-back coverage by construction. The failure mode is content quality. A conversation that produces "let's use Redis for the revocation list" gets extracted as "team uses Redis." The reasoning — TTL-native eviction, the concurrency model, why Postgres was rejected — doesn't survive a general-purpose extraction pass. The system's write-back is structured and explicit: the agent provides rationale and alternatives directly. Coverage is lower (~85-90% with the hook), content quality is higher.

The honest comparison: Mem0 solves coverage. This system bets on quality. Whether that tradeoff is worth it depends on whether you need to know what happened or why it was decided.

**Q: What about Zep? It has bi-temporal tracking — doesn't that make it more sophisticated?**

Yes, on the temporal dimension specifically. Zep/Graphiti scores 71.2% overall on LongMemEval (63.8% on the temporal sub-task). Its bi-temporal model tracks both when a fact was valid and when it was recorded — which matters for queries like "what did the team believe about the auth model in March?" The system's current Decision node model has `valid_from` / `valid_to` fields but does not implement automatic `valid_to` updates when a superseding decision is logged. That is a real gap.

What Zep does not do: ingest signals from GitHub, Slack, Jira, and meeting transcripts into the same graph. It is agent-scoped, not team-scoped. A Slack thread and an agent session don't end up in the same queryable store in Zep. Whether bi-temporal tracking or multi-source human+agent graph is the more valuable property depends on the use case.

**Q: Microsoft already shipped Foundry Agent Memory. Doesn't that make this redundant?**

Foundry Agent Memory (shipped December 2025, billing June 2026) covers conversational cross-session continuity for Azure-native teams: automatic extraction, consolidation, and retrieval across agent sessions. For Azure teams that need basic "remember what the agent did last week," it is already a viable answer.

What it does not do: structured decision provenance (rationale, alternatives, confidence), multi-source ingestion (Slack, Jira, meetings alongside agent sessions), drift detection across agents and surfaces, or non-Azure agent support. These are the three gaps the system is specifically built around. Microsoft extending Foundry Agent Memory to cover those three is plausible — it is months of opinionated product work, not a config change.

The honest position: for Azure-native teams who need basic cross-session continuity, Foundry Agent Memory is already worth evaluating. This system is for teams who need to know *why* decisions were made and want the human knowledge layer (Slack threads, Jira tickets, design meetings) in the same graph as the agent knowledge layer.

**Q: Why not just use application-layer interception like Mem0 does, instead of asking agents to cooperate?**

Application-layer interception achieves near-100% write-back coverage. The cost is what gets extracted: automatic extraction from conversation transcripts reliably recovers actions, not reasoning. "Chose Redis over Postgres because TTL-native eviction matched the access pattern and Postgres would have required a background job" requires the agent to have expressed that reasoning explicitly. Most transcripts don't contain it that way — the reasoning is implicit in the back-and-forth that led to the conclusion.

The system's bet is that structured reasoning at 85-90% coverage is more valuable than shallow facts at 100% coverage. Whether that bet is right depends on how teams actually use the memory: if they just want to avoid re-discovering actions, Mem0's approach works. If they need to understand the constraints that shaped a decision, cooperative write-back with schema validation is the only path.

**Q: You built this almost entirely with Claude. What does that mean for the quality and security of the code?**

It means the development velocity was dramatically higher than solo development would otherwise allow. It also means the code reflects the AI's strengths and weaknesses: the code is generally well-structured and the documentation is thorough, but security discipline requires explicit attention because an AI assistant optimises for making things work, not for adversarial thinking. The security review (run by Opus 4.7) identified the specific gaps: unauthenticated MCP HTTP transport, credential defaults leaking into production, missing per-project authorization, and an injection pipeline in the agent write-back path. These are fixable and known. The broader point: AI-assisted development is a force multiplier but not a substitute for deliberate security review, and this project treated them as distinct activities.

---

## Part 11 — The Data Flow, End to End

The most grounding way to understand the system is to trace a single event from input to answer.

**Scenario:** A developer merges a PR changing the auth module. A teammate later asks, "What decisions have been made about auth?"

```
T+0s    Developer merges PR #234 on GitHub
T+0.5s  GitHub webhook fires → POST /webhooks/github on the brain API
T+0.5s  API validates HMAC-SHA256 signature, writes raw event to Redis Stream "events:raw"
T+0.5s  API responds 200 OK to GitHub

T+1s    Normalizer worker reads from "events:raw"
        → extracts PR title, description, review comments, changed files (auth/token.py)
        → maps GitHub actor to Person node via username lookup
        → writes to "events:normalized"

T+2s    Extractor worker reads from "events:normalized"
        Pass 1: finds "going with short-lived JWTs" in PR description → decision_candidate=true
        Pass 2: LLM extraction (Claude Haiku):
          Decision extracted: {
            description: "Use short-lived JWTs (15-min expiry) for auth tokens",
            rationale: "Compliance requirement from security review",
            confidence: "high",
            decision_maker: "alice",
            quoted_text: "going with short-lived JWTs, compliance requires it"
          }
        → writes to "events:extracted"

T+4s    Brain-writer reads from "events:extracted"
        → MERGE Event node in Neo4j (event_id: pr_234_merged)
        → MERGE Decision node, create EXTRACTED_FROM edge to Event
        → MERGE Person node for alice, AUTHORED_BY edge
        → Embed event content → write 3 chunks to Qdrant
        → Drift detector: similarity search finds existing Decision:
          "Use long-lived session tokens for simplicity" (from March meeting)
          Cosine similarity: 0.91 → above threshold, trigger LLM confirmation
        → LLM: "These decisions contradict each other" → confirmed
        → Create CHALLENGES edge between new and old Decision
        → Create DriftAlert node

T+5s    DriftAlert surfaced in chat UI for the project

--- later ---

T+10min  Teammate opens chat UI, asks: "What decisions have been made about auth?"

T+10:00  Query received → embed raw query immediately
T+10:00  Intent parser (Haiku): mode=project_scoped, domain_tags=["auth"]
T+10:00  Vector search: top-10 chunks → includes 2 chunks from PR #234, 1 from March meeting
T+10:00  Graph expansion: Decision "short-lived JWT" → CHALLENGES → Decision "long-lived tokens"
          → both decisions pulled into context
T+10:01  Context assembled: 4 chunks, 2 decisions, 1 drift alert — 3,400 tokens, within budget
T+10:01  Answer generation (Sonnet):
          "Two decisions about auth token handling have been made:
           1. In March 2026, the team decided to use long-lived session tokens [1]
           2. PR #234 (alice, May 2026) decided to switch to short-lived JWTs (15-min expiry)
              citing a compliance requirement [2]
           Note: these decisions are flagged as contradictory [3]."
T+10:04  Citation validation passes → response streamed to UI
```

The teammate sees a complete answer with clickable citations — one to the March meeting transcript segment, one to the PR #234 description, one to the drift alert — in under 4 seconds.

---

## Part 12 — What Is Not Done Yet and Why

Honesty matters in technical demos. The following known limitations are worth being able to address directly:

**Per-project authorization:** implemented via `MEMBER_OF` edges in Neo4j and `requireProjectMember` middleware. Users are granted membership on GitHub OAuth login. Fine-grained permission mirroring from source systems (respecting GitHub repo visibility rules at the query layer) is a post-beta item.

**Selective backfill:** when the extraction schema changes (a new attribute is added, or a new node type is introduced), the current system replays the full event history to pick up the new schema. There is no selective backfill for just the affected time range or just events missing a specific attribute. This is a post-beta improvement.

**Cross-source person deduplication:** alice on Slack and alice_dev on GitHub are not automatically linked. Known team members can be manually mapped; automatic resolution across sources is Phase 3 work.

**No agent instrumentation:** agents must explicitly emit a structured log by calling `POST /brain/agent-log`. Automatic capture from agent sessions (parsing streaming tool use events, for example) is more complex and is deferred.

**English only:** the decision marker phrase lists, the fuzzy-match technology list, and the embedding model are all optimised for English. Non-English source content will have lower extraction quality.

---

---

## Part 13 — Validation State: What Has and Hasn't Been Tested

Being clear about this matters. Overclaiming validation is the fastest way to lose credibility with a technical audience.

**Validated end-to-end (one developer, one set of agents):**

- Write-back mechanism: agents call the write API mid-session, the validation layer rejects low-quality entries, retry produces a better record.
- Query retrieval: queries at session start return prior decisions with citations. The Redis consumer group ordering constraint example in the articles is real — logged mid-session, retrieved by the next session, not re-derived.
- Multi-source ingestion: GitHub events, Slack messages, and Jira tickets flow through the pipeline and appear in the same graph as agent decisions. Cross-source citation works.
- Drift detection: tested with deliberately contradictory inputs, surfaces the alert with correct context and citations.
- MCP interface: `brain_query`, `brain_log_decision`, `brain_analyze_impact`, `brain_log_signal` all work via Claude Code.

**Not yet validated:**

- **Team scale.** The system has not been used by a second person. The hypothesis — that a developer joining a project mid-stream gets useful context from the graph without the first developer doing anything extra — has not been tested.
- **Cross-developer write consistency.** One developer can maintain write-back discipline because they set up the system. Whether a second developer's agents produce entries that are consistent enough in quality and schema to be useful alongside the first developer's entries is unknown.
- **Drift detection at real decision volume.** Tested with synthetic contradictions. Behaviour at 50-100 real decisions per day across multiple developers is untested.
- **Identity resolution.** alice@company.com and alice_dev on GitHub are not automatically linked. Manual mapping works for known team members; automatic cross-source resolution is not built.

**The specific question that needs early users to answer:**

Does the structured decision trail hold its value when a second human joins the graph? Everything else is secondary.

---

## Part 14 — Explaining This to Non-Technical Audiences

For recruiters, PMs, or generalists who ask about the project. Use these framings.

### "What is it in one sentence?"

"A shared memory for software teams where both humans and AI agents write what they decide and why — so neither has to re-derive what the other already figured out."

### "Why does this matter?"

Every AI coding session starts cold. The agent re-reads files, re-derives constraints, and re-makes decisions that were already made in a previous session. At one developer, that's wasted time. At a team of five, each running multiple agent sessions daily, the same knowledge gets re-derived by every session. This system stores decisions once and retrieves them for every session that needs them.

The second problem: humans make decisions in Slack and Jira. Agents make decisions in coding sessions. Neither system knows what the other decided. This system puts both in the same graph so any actor — human or agent — can query the full decision history.

### "Isn't this just a wiki or a knowledge base?"

A wiki requires humans to write it, keep it current, and remember to read it before every session. Agents don't read wikis. This system has a write path for both humans (via ingestion from Slack, Jira, GitHub, meetings) and agents (via structured API write-back), and a read path for both (natural language query or MCP tool call). The key difference: it is active, not passive. It flags contradictions. It notifies when a new decision conflicts with an old one. A wiki does nothing when you make a decision that contradicts something written six months ago.

### "Who is it for?"

Developers who use AI agents daily and feel the pain of starting every session cold. Teams running multiple AI agents on the same codebase who want visibility into what each agent decided. Engineers who want an auditable record of AI agent reasoning, not just what was committed.

### "Is it production-ready?"

Honest answer: it works end-to-end for one developer. The team-scale hypothesis — that it holds value when multiple humans and agents write to the same graph — has not been tested yet. That is what early access is designed to find out.

### "What's the hardest part technically?"

Not the storage. The hardest problem is getting agents to write back consistently, and getting the write-back to capture reasoning rather than just actions. Automatic extraction (what Mem0 and Zep do) is reliable but captures facts. Cooperative write-back with structured schema captures reasoning but depends on agent discipline. Both approaches have failure modes. The system bets on reasoning being more valuable than coverage.

---

*Last updated: 2026-05-22. Threshold corrected to 0.72 (pre-beta calibration from 0.55). Competitive Q&A section added (Mem0/Zep/Foundry). Validation state section added. Non-technical explanation section added.*
