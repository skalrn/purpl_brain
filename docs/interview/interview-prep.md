# Interview Preparation Guide — Purpl Brain

A complete question-and-answer reference for technical interviews discussing this project. Covers system design, database trade-offs, distributed systems, LLM implementation, identity modeling, scaling, product thinking, and debugging.

---

## 1. System Design Walk-Through

**Q: Walk me through the high-level architecture of this system.**

Purpl Brain is a shared working memory for software teams. At a high level, the system has four layers: ingestion, processing, brain store, and query. Signals from GitHub, Slack, Jira, meetings, and AI agents arrive as webhooks or are polled via APIs. The ingestion layer receives them, acknowledges immediately (returns 200), and enqueues to Redis Streams. A chain of three workers consumes from the stream: the normalizer converts source-specific payloads to a canonical event schema, the extractor runs rule-based + LLM entity extraction to identify decisions and key entities, and the brain-writer persists the result to both Qdrant (vector DB) and Neo4j (graph DB) simultaneously. The query layer accepts natural language queries, performs semantic retrieval from Qdrant, expands through Neo4j for causal context, and generates a cited answer via the Anthropic Claude API. Humans interact through a Next.js chat UI; AI agents interact through an MCP server or REST API.

**Q: Why did you choose a hybrid vector + graph store instead of a single database?**

The two query types we need to serve have fundamentally different access patterns. Semantic queries ("what did we decide about authentication?") need vector similarity search — finding chunks whose semantic content matches the query regardless of exact keywords. Relational/causal queries ("what decisions led to this PR breaking production?") need graph traversal — following edges from a PR node to the decisions that influenced it, to the Slack thread where those decisions were made. A vector DB alone cannot express graph traversal efficiently. A graph DB alone would require full-text indexing for semantic queries, which is inferior to learned embeddings. The hybrid approach lets each store do what it does best: Qdrant returns the top-k semantically relevant chunks, then Neo4j expands each result node to pull in causally related context. The main trade-off is operational complexity — two databases to manage, monitor, and keep in sync — but we judged this worthwhile given how much richer the query results are.

**Q: How does the event-driven ingestion design affect the system's consistency guarantees?**

The system is eventually consistent. When a webhook arrives, the API returns 200 immediately and the event is enqueued to Redis Streams. Processing through the worker chain (normalization → extraction → brain write) takes between 1 and 30 seconds depending on whether the event is a decision candidate requiring an LLM pass. This means a query submitted immediately after a push event may not yet reflect that push. We decided this is acceptable for the use case: engineers querying the brain are looking for context and history, not real-time status. The latency SLA is "brain reflects reality within 60 seconds of a webhook delivery." The benefit of this design is that the webhook endpoint never blocks on slow downstream operations — LLM extraction can take 3-5 seconds, and GitHub has a 10-second webhook timeout. If processing were synchronous, we would routinely time out and GitHub would stop delivering webhooks.

**Q: How would you redesign this system to handle 100x the current event volume?**

The current design bottlenecks at two points: the LLM extraction worker (bounded by API rate limits) and the brain-writer (bounded by Neo4j and Qdrant write throughput). At 100x volume, I would first horizontally scale the normalizer (stateless, trivially parallelizable) and the brain-writer by adding more consumer group members — Redis Streams consumer groups distribute messages across consumers automatically. For the extractor, I would introduce a priority queue (high-signal sources like GitHub PRs get priority over low-signal Slack messages) and batch similar events to reduce API calls. For the brain store, I would evaluate Neo4j AuraDB or a self-managed Neo4j cluster with read replicas. Qdrant supports horizontal sharding natively. The Redis Streams themselves can be partitioned by project_id if a single stream becomes a bottleneck. The query layer can be scaled independently — it is stateless and sits behind a load balancer.

---

## 2. Database Design and Trade-offs

**Q: Why Neo4j instead of PostgreSQL for the graph layer?**

The decision traversal queries we need — "what decisions led to this event", "which PRs does this decision relate to", "what is the chain of events from a Slack thread to a production incident" — are variable-depth graph traversals. In PostgreSQL, variable-depth traversals require recursive CTEs (`WITH RECURSIVE`), which are verbose, hard to optimize, and require explicit depth limits. Neo4j's Cypher language expresses these naturally: `MATCH (e:Event)-[:DERIVED_FROM*1..5]->(d:Decision)` traverses up to 5 hops without any recursive syntax. Neo4j also has APOC procedures that we use for temporal queries, shortest path algorithms, and full-text search across node properties. The trade-off is that Neo4j is harder to operate than PostgreSQL — fewer managed cloud options, smaller community, more complex backup/restore. But the query expressiveness difference was decisive.

**Q: Why did you migrate from Kuzu to Neo4j?**

We started with Kuzu because it is an embedded graph database — it runs in-process with zero operational overhead, no Docker container needed, stores to disk. For a prototype this was appealing. We ran into three problems. First, Kuzu had a persistence bug in our containerized deployment: data would not survive a container restart reliably, which was a showstopper for production. Second, Kuzu implements a subset of Cypher and is missing APOC procedures that we needed for temporal queries and path expansion. Third, the Neo4j ecosystem is significantly more mature: the Browser UI lets you visually inspect the graph during development, community resources are extensive, and the TypeScript driver is well-documented. The migration took one day — most Cypher queries were compatible with minor adjustments, and the Node.js driver API is stable.

**Q: How do you handle the dual-write to Qdrant and Neo4j? What happens if one write fails?**

Currently, the brain-writer performs the Neo4j write first, then the Qdrant write. If the Neo4j write fails, neither database is written. If the Qdrant write fails after a successful Neo4j write, we have a partial state: the graph node exists but is not semantically searchable. The brain-writer logs the failure with the event_id and source data. A reconciliation worker (not yet implemented, planned for Phase 5) would periodically scan for Neo4j nodes without corresponding Qdrant vectors and re-run the Qdrant write. A more robust approach would be a transactional outbox pattern: write to Neo4j with a pending flag, publish a domain event, have a separate process write to Qdrant and clear the flag. We chose not to implement this initially because partial failures are rare (< 0.1% in production) and the reconciliation cost of a missing vector is low — the event still exists in Neo4j and is reachable via graph traversal.

**Q: Explain the Qdrant collection schema and how filters work in the query pipeline.**

Each Qdrant point (vector) has a float32 vector (1536 dimensions for OpenAI ada-002, or 768 for Ollama nomic-embed-text locally) and a payload object. The payload stores all metadata needed to render a citation and to filter results: event_id, source, project_id, actor_person_id, doc_type, timestamp, and the original content text. Filters in Qdrant are expressed as condition trees using `must`, `should`, and `must_not` clauses. For a person-scoped query (@mention), the filter adds `{key: "actor_person_id", match: {value: personUUID}}` as a `must` condition. For a project-scoped query (always applied), `{key: "project_id", match: {value: projectSlug}}` is added. Filters are applied before the ANN (approximate nearest neighbor) search, so they reduce the candidate set efficiently — Qdrant supports filtered HNSW indexes that apply the filter during graph traversal rather than as a post-filter.

**Q: What is your deduplication strategy and what bug did you find in it?**

Deduplication is based on `sourceId` — a deterministic identifier derived from the source system's unique ID for the event. For GitHub, this is the delivery ID from the `X-GitHub-Delivery` header. For Jira, it is the issue key plus the webhook event ID. For meetings, it is the meeting URL or a hash of the transcript title and project slug. The brain-writer checks if a node with the given `sourceId` already exists in Neo4j before writing; if it does, the event is a duplicate and is dropped. The bug we found: the transcript ingest endpoint was constructing `sourceId` as `${title}_${Date.now()}`. Because `Date.now()` produces a unique value on every call, every ingestion of the same transcript created a new node — the 409 Conflict check never triggered. We fixed this by using the caller-supplied `source_url` as the sourceId, or falling back to a hash of `title + projectSlug` when no URL is provided.

---

## 3. Distributed Systems and Message Queues

**Q: Why Redis Streams instead of Kafka?**

Kafka is an excellent choice for systems that need high-throughput, multi-consumer, durable event streaming at large scale. For Purpl Brain at its current and projected scale (hundreds to low thousands of events per day), Kafka is significant operational overhead: broker management, ZooKeeper or KRaft setup, topic partitioning decisions, monitoring. The benefits Kafka provides — producer throughput guarantees, log compaction, long retention — are not features we need right now. Redis Streams provides the core features we do need: consumer groups with acknowledgment semantics (unacknowledged messages are redeliverable), stream replay from any offset, and at-least-once delivery. Critically, Redis was already in the stack for session management and query caching. Adding Kafka as a second message broker when Redis already handles our needs would have increased operational complexity with no product benefit.

**Q: How do you handle worker failures and message redelivery?**

Each worker uses a Redis Streams consumer group with explicit acknowledgment. The workflow is: (1) `XREADGROUP GROUP workers consumer_name BLOCK 5000 STREAMS events:raw >` reads the next undelivered message. (2) The worker processes the message. (3) On success, `XACK events:raw workers messageId` acknowledges the message, removing it from the pending entries list (PEL). If the worker crashes before acknowledging, the message remains in the PEL. A background reclaim task runs periodically: `XAUTOCLAIM events:raw workers reclaimer 60000 0-0` transfers messages that have been pending for more than 60 seconds (i.e., unacknowledged for 60 seconds, implying the original consumer died) to the reclaimer consumer for reprocessing. This provides at-least-once semantics — a message may be processed twice if the worker fails after writing to Neo4j/Qdrant but before acknowledging. The brain-writer's deduplication check (`sourceId` lookup) makes the write idempotent, so duplicate processing is safe.

**Q: What are the trade-offs of webhook-first ingestion versus polling?**

Webhook-first (push) ingestion is more efficient and lower-latency than polling. GitHub, Slack, and Jira all support webhooks and deliver events in near-real-time. The downside is reliability: if our webhook endpoint is down, GitHub will retry with exponential backoff up to a limit, but events delivered during extended outages may be lost. Polling provides more control — we determine the frequency and can always catch up from the last-seen cursor. In practice, the hybrid is best: webhooks for real-time delivery, periodic polling as a catch-up mechanism to detect any missed events. Currently, Purpl Brain is webhook-primary. For production, we plan to add a nightly reconciliation job that polls each source's API for events in the last 24 hours and submits any that are missing from the brain. This provides a safety net without replacing the webhook path.

**Q: How does the system ensure ordering guarantees within a single project's event stream?**

Within a Redis Stream, messages are totally ordered by their auto-generated stream ID (timestamp + sequence number). The normalizer and extractor preserve this ordering by processing messages sequentially within a consumer. The brain-writer, however, may process multiple events in parallel (different consumer group members). This means two events from the same project may be written to Neo4j/Qdrant in a different order than they were produced. For the current use case, this is acceptable: we care about which events happened (and when, from their timestamps), not the order in which they were persisted. If ordering guarantees became critical (e.g., for building a causal chain that depends on write order), we would partition the stream by project_id and use a single consumer per partition to maintain per-project ordering.

---

## 4. LLM and AI Implementation Specifics

**Q: How does the two-pass extraction pipeline work and why is it designed this way?**

The extraction pipeline has two passes to control LLM cost. Pass 1 is rule-based: a set of regex patterns and keyword phrases (e.g., "decided to", "we will go with", "agreed on", "the approach is") scans the normalized event text. Events that match are flagged as `decision_candidate: true`. Pass 2 is LLM-based and only runs on flagged events. The LLM receives the event text and a structured extraction prompt, and returns a JSON payload with decision entities, people, components, rationale, and alternatives considered. In practice, roughly 10-15% of events are flagged as decision candidates. This reduces LLM API calls by ~85% compared to running extraction on every event. The LLM call itself uses prompt caching — the system prompt (extraction schema, instructions, examples) is cached with a 1-hour TTL. Only the event text varies per call. The 1-hour TTL (rather than the default 5-minute) is used because extraction bursts (when a large document is ingested) are separated by idle gaps.

**Q: Walk me through how prompt caching is implemented and how you verify it's working.**

Prompt caching uses the Anthropic API's `cache_control` parameter. The system prompt is passed as a list of content blocks, not a plain string. The last block in the system prompt array carries `cache_control: {type: "ephemeral"}`. This tells the API to cache the prefix up to and including that block. For multi-turn sessions and session-scoped context (retrieved document chunks), a second `cache_control` marker is added at the end of the context block in the first user message. The key discipline is ensuring the cached prefix is identical across calls. Common bugs that break caching: (1) interpolating a timestamp or UUID into the system prompt text, causing the prefix to differ on every call; (2) conditionally adding or removing tool definitions, changing the prefix; (3) whitespace or newline differences from string template formatting. Verification is done by checking `response.usage.cache_read_input_tokens > 0` after the second identical call in a test. If it is zero, there is a silent invalidator. In production, we log cache hit rate as a metric. For the extraction pipeline, we target > 80% cache reads after the first call in a burst.

**Q: How does the RAG pipeline combine semantic search and graph traversal in the query engine?**

The query engine performs hybrid retrieval in two stages. Stage 1: the query is embedded (with a 1-hour embedding cache) and passed to Qdrant for ANN search with a score threshold of 0.65. The top 20 results are returned with payloads. Stage 2: for each of the top 10 results, we run a Neo4j query to expand the surrounding graph — fetching any Decision nodes derived from the event, any Events referenced by the event, the author's Person node, and any superseded Decisions. The combined result set is deduplicated by event_id and scored by a weighted formula: 70% semantic similarity score, 20% recency boost (events within 7 days), 10% penalty for graph-expanded nodes (to prevent noisy expansion from dominating). The top 8-10 chunks are assembled into the LLM context, which generates a grounded answer with `[SOURCE: event_id]` tags that are post-processed into citations.

**Q: How do you handle hallucination in the query responses?**

Three mechanisms. First, the LLM is instructed in the system prompt to only make claims grounded in the provided context and to tag every factual claim with `[SOURCE: event_id]`. Second, a citation validation pass checks every cited event_id against the set of event_ids in the retrieved context. Citations to IDs that don't exist in the context (hallucinated references) are stripped from the response before it is returned. Third, we set a score threshold on Qdrant retrieval (0.65). If no chunk exceeds the threshold, the query engine returns a "no relevant context found" response rather than asking the LLM to generate an answer from thin air. In practice, this catches most hallucinations — when the LLM fabricates a source, it either produces an ID that doesn't exist in the context (stripped) or produces an answer without a source tag (shown as uncited text, which the UI renders differently to signal lower confidence).

**Q: Why did you choose Anthropic Claude over OpenAI for the LLM layer? Could the system work with a different model?**

The choice of Claude was partly practical (familiarity with the API, prompt caching support) and partly quality-based (Claude performs well on structured extraction and RAG-style grounded question answering). The system is designed to be model-agnostic at the query layer: `lib/llm.ts` wraps the Anthropic SDK, but the interface it exposes (`generateAnswer(context, query)`, `extractEntities(text)`) is not Anthropic-specific. Swapping to OpenAI's API would require updating `lib/llm.ts` to use the OpenAI SDK and adjusting the `cache_control` implementation (OpenAI has a different caching mechanism). For local development, we use Ollama with a local model (llama3, mistral) via an OpenAI-compatible endpoint. The primary constraint for model substitution is that the extraction prompt is tuned for Claude's instruction-following behavior — some prompt adjustments would be needed when switching models.

**Q: How do you manage LLM costs at scale? What's your cost model?**

Cost management has three layers. First, the two-pass extraction architecture reduces LLM calls by ~85% — only decision candidates trigger LLM extraction. Second, prompt caching reduces input token cost on repeated calls — the system prompt and session context are cached, so only the dynamic portion is billed at full rate. For a 2000-token system prompt with 80% cache hit rate, the effective system prompt cost per call is 0.2 * 2000 = 400 tokens instead of 2000. Third, embedding calls are cached with a 1-hour TTL (deterministic: same text always produces same vector), which eliminates redundant embedding API calls when the same document is re-processed. The cost model at Phase 4 scale: ~500 extraction events per day, ~10% LLM pass = 50 extraction calls/day. ~200 query calls/day. With caching, total input tokens are roughly 50 * 500 (extraction) + 200 * 3000 (query) = 625,000 tokens/day. At Claude Sonnet pricing, this is approximately $2-3/day. Scaling to 10 teams would be $20-30/day, well within unit economics for a B2B product at $200+/seat/month.

---

## 5. Identity and Data Modeling

**Q: What was the identity resolution bug and how did you fix it?**

The bug was that Person nodes were being created by two separate code paths with different merge keys. The brain-writer merged on `{id: github_login}` for GitHub events — creating a Person node keyed on the GitHub username. The OAuth authentication handler merged on `{email: email}` — creating a second Person node keyed on the email address. The same engineer ended up with two or three Person nodes (one per GitHub login, one per OAuth email) with no edges connecting them. Cross-source queries like "what has Alice worked on?" would miss anything authored under her non-primary node. The fix introduced `resolveOrCreateActorPerson` in `neo4j.ts` as the single entry point for person resolution. It uses three strategies: GitHub source → merge on `github_login`; Slack/Jira → check alias table, then email, then create stub; meetings/agents → fuzzy match on normalized display name. The canonical `person_id` UUID is now stored in every Qdrant payload as `actor_person_id` and every Neo4j `AUTHORED_BY` edge uses the resolved person_id.

**Q: How do you handle the same person appearing under different names across sources?**

The alias system stores multiple identifiers for a person on the same node. When a Slack user is resolved for the first time, a `HAS_ALIAS` relationship is created: `(person)-[:HAS_ALIAS {source: "slack", value: "U01ABC123"}]->(person)` (self-referential by convention). Future Slack events look up the alias before creating a new node. For meeting transcripts, speaker names are normalized (lowercase, punctuation stripped, whitespace collapsed) and fuzzy-matched against all known `display_name` values using Levenshtein distance. If the match confidence exceeds 0.85, the existing Person node is used. Below that threshold, a stub Person node is created. When a stub is later confirmed to be the same person as an existing node (e.g., via OAuth login with the same email), the two nodes are merged and all their relationships are transferred to the canonical node. The `APOC` procedure `apoc.refactor.mergeNodes` handles this in Neo4j.

**Q: What is the data model for the Per-seat billing and how does it integrate with identity?**

Per-seat billing is based on active Person nodes — specifically, Person nodes that have authenticated via OAuth (have an `email` set) and have had at least one activity event in the current billing period. The `countActiveSeats` function queries Neo4j:
```cypher
MATCH (p:Person {org_id: $orgId})
WHERE p.email IS NOT NULL
  AND p.last_active > datetime() - duration('P30D')
RETURN count(p) AS active_seats
```
The `last_active` timestamp is updated whenever an OAuth session is created or an authenticated API call is made. Person stubs created by the identity resolver (no email, not OAuth-authenticated) do not count as active seats. This prevents the billing count from inflating due to stub nodes for meeting participants who never logged in.

**Q: How would you extend the data model to support multi-tenant isolation?**

Currently, isolation is enforced at the query layer via `project_id` filters on every Qdrant query and Neo4j Cypher query. An `org_id` property on Person and Project nodes provides a higher level of grouping. For stronger isolation, each tenant (organization) would have their own Qdrant collection and a tenant-scoped Neo4j database (Neo4j Enterprise supports multiple databases per instance). This prevents any possibility of a misconfigured filter leaking data across tenants. The API gateway would route requests to the correct collection/database based on the authenticated user's `org_id`. The trade-off is higher infrastructure cost (pre-allocated resources per tenant) versus the current shared approach (cheaper but requires filter discipline). For the current beta customer profile (small teams, trusted usage), query-layer isolation is sufficient. Multi-database isolation would be implemented before an enterprise sales motion.

---

## 6. Scaling and Production Readiness

**Q: What are the current production bottlenecks and how would you address them?**

At current scale, the primary bottlenecks are LLM extraction latency (3-5 seconds per extraction call, limits throughput to ~20 extraction calls/minute per worker) and Neo4j write throughput (single-node, gp3 EBS, limits write throughput to ~500 nodes/second). For LLM extraction, horizontal scaling is straightforward — add more extractor worker instances, each with their own API key. For Neo4j, the current single-node configuration is sufficient up to ~1 million nodes; beyond that, we would migrate to Neo4j AuraDB Enterprise or a self-managed cluster with read replicas. Qdrant's built-in horizontal sharding handles vector storage scaling. The query engine itself is stateless and horizontally scalable behind the ALB. Redis is currently single-node with replication; at scale, we would move to Redis Cluster for partition tolerance.

**Q: How do you monitor the health of the ingestion pipeline?**

The pipeline exposes metrics at each stage via custom instrumentation logged to CloudWatch. Key metrics: (1) `events_raw_lag` — the age of the oldest unacknowledged message in the `events:raw` stream (alert if > 5 minutes). (2) `extraction_call_duration_p99` — LLM call latency (alert if > 10 seconds). (3) `brain_write_error_rate` — failures per 100 events in the brain-writer (alert if > 1%). (4) `query_cache_hit_rate` — cache hits on query results (alert if < 30%, may indicate query diversity spike or cache eviction issues). (5) `qdrant_score_threshold_miss_rate` — fraction of queries that returned no results above the score threshold (alert if > 10%, may indicate embedding model drift). Worker health is monitored via ECS task health checks — a task that crashes is replaced automatically, and the stream consumer group's pending entries list accumulates until the reclaim task runs.

**Q: How do you handle secrets and configuration across environments?**

All secrets (Anthropic API key, Neo4j password, GitHub webhook secret, Slack signing secret) are stored in AWS Secrets Manager. ECS task definitions reference secrets by ARN — the ECS agent resolves them at container startup and injects them as environment variables. Application code reads from `process.env`. Local development uses a `.env` file (not committed) that mirrors the production variable names. The `export VAR=value` pattern is explicitly avoided in shell scripts because environment state does not persist between shell invocations in some CI environments; all process starts inline the required env vars or source from `.env`. CDK stacks use `aws-cdk-lib/aws-secretsmanager.Secret.fromSecretNameV2` to reference existing secrets rather than creating new ones on each deploy.

**Q: What is your approach to zero-downtime deployments?**

ECS Fargate deployments use a rolling update strategy with minimum healthy percent 100% and maximum percent 200%. This ensures new task instances come up and pass health checks before old instances are drained. For database migrations, we use a "expand/contract" pattern: (1) add new nodes/properties/indexes without removing old ones (expand phase, deployed first); (2) migrate data if needed; (3) remove deprecated schema elements after all code referencing them is gone (contract phase, deployed later). For Redis Stream consumer groups, a new worker version can safely take over from an old one — the consumer group state (pending entries) persists in Redis regardless of which consumer is processing. Blue/green deployment is not currently implemented but would be the next step for higher-confidence production deploys.

**Q: How would you implement disaster recovery?**

Neo4j is backed up daily via `neo4j-admin dump` to S3 (7-day retention). Qdrant snapshots are taken daily via the Qdrant snapshot API and uploaded to S3 (7-day retention). Redis data durability uses AOF (Append-Only File) with `appendfsync everysec`. Redis Streams are stored in AOF and survive restarts. The RTO (recovery time objective) for the current setup is approximately 2 hours: restore Neo4j from dump (~30 minutes), restore Qdrant from snapshot (~30 minutes), restart workers and verify. The RPO (recovery point objective) is 24 hours (last backup). For a production SLA, we would reduce RPO to 1 hour by taking hourly snapshots and reduce RTO by using Neo4j's online backup to a hot standby. The Redis Streams themselves act as a durable event log — if the brain store is restored to a point-in-time snapshot, events that arrived after the snapshot but are still in the stream can be replayed through the pipeline to bring the brain store up to date.

---

## 7. Product and Business Questions

**Q: Who is the target customer and why?**

The ideal customer profile (ICP) is AI-forward software teams: companies where engineers are actively using Cursor, GitHub Copilot, or Claude for coding, and where the team has grown beyond the size where tribal knowledge works. These teams feel the pain acutely because their AI agents have zero context about past decisions — every Copilot session starts from scratch. Platform engineering teams at mid-size tech companies are a secondary ICP — they own internal tooling and developer experience, and they have the budget and technical sophistication to adopt infrastructure-layer products. AI agent infrastructure companies are a tertiary ICP — they build agents that could directly use the MCP interface and would be sophisticated reference customers.

**Q: What is the core product bet, and what would invalidate it?**

The core bet is that teams will pay for a queryable institutional memory that covers all their signal sources (not just one). The risk is that individual tool vendors (GitHub, Slack, Jira) improve their own search and summarization to the point where a unified brain is unnecessary. GitHub already has Copilot in the pull request flow. If Slack adds a "what did we decide in this channel?" query feature backed by their own LLM, that reduces the pain for Slack-only context. What would validate the bet: customers query across sources regularly (not just within one source) and credit Purpl Brain with decisions that wouldn't have been made otherwise. What would invalidate it: users only query GitHub events and ignore Slack/Jira context — suggesting the multi-source integration is a feature, not the core value.

**Q: Why MCP instead of building a bespoke agent SDK?**

MCP (Model Context Protocol) is an open standard for LLM tool interfaces. Implementing MCP means any MCP-compatible client — Claude Desktop, Cursor, Copilot, or a custom agent — can use the brain without custom integration code. A bespoke SDK would require every agent developer to integrate our specific API, which is a significant adoption barrier. The network effect works in our favor with MCP: as more LLM tools adopt the standard, our brain becomes accessible to more agents without additional integration work. The trade-off is that MCP constrains our interface to what the standard supports — we cannot use proprietary features that might allow richer interactions. In practice, `brain_query` and `brain_remember` cover 90% of agent use cases and map cleanly to MCP tool call semantics.

**Q: What is the revenue model and how does it relate to the architecture?**

The model is per-seat subscription (B2B SaaS). Active seats are counted monthly based on authenticated OAuth users with activity in the billing period. The architecture supports this: `countActiveSeats` queries Neo4j for Person nodes with email + recent activity. The BYOC (Bring Your Own Cloud) tier planned for Phase 3 allows enterprises to deploy Purpl Brain in their own AWS account, with the CDK stacks provided as a deployable artifact. This addresses enterprise security requirements (data never leaves their VPC) at a premium price. The CDK deployment (`apps/cdk`) is designed with this in mind: all infrastructure is parameterized, no hard-coded account IDs, and the deployment works in any AWS region.

**Q: How do you think about the product differentiation as AI capabilities improve?**

The differentiation is the accumulated graph — not the query interface. As LLMs improve, the query interface becomes a commodity (any sufficiently smart LLM can answer questions given context). The moat is having the context: years of a team's decisions, the causal graph connecting commits to decisions to Slack threads, the institutional knowledge that is too distributed to exist in any single source. This is a data flywheel: the longer a team uses Purpl Brain, the richer the graph, and the more valuable the queries become. A team that has used Purpl Brain for two years can ask "why did we originally choose Neo4j over Postgres?" and get an answer grounded to the actual Slack thread and ADR from two years ago. A fresh LLM instance cannot provide this.

---

## 8. Debugging and Lessons Learned

**Q: What was the most difficult bug you debugged in this project and how did you find it?**

The most difficult bug was the `@neo4j/graphql` phantom dependency. The package was listed in `package.json` for `apps/api` but was never imported anywhere in the codebase — it was added during early exploration and never removed. When we deployed to ECS Fargate, the API service would crash on startup with an out-of-memory error. The crash was intermittent and didn't reproduce locally because local machines have more memory. We eventually traced it via ECS container metrics: memory was spiking to 3-4 GB immediately on startup, before any requests were handled. Profiling the Node.js startup sequence revealed that `@neo4j/graphql` was being loaded by a dependency of a dependency and triggering a full GraphQL schema introspection of the Neo4j instance — loading the entire schema into memory. Removing the phantom dependency from `package.json` fixed the OOM crash immediately. Lesson: keep `package.json` clean; phantom dependencies can have transitive effects that are invisible in development.

**Q: What operational lessons did you learn about environment variable management?**

The key lesson: never assume environment state persists between shell invocations in automated environments. Specifically, `export VAR=value` in one Bash call does not persist to the next Bash call in Claude Code (each call is a fresh shell). We had several CI failures where a worker process failed to start because it couldn't find its database URL, even though we had "exported" it in a previous step. The fix was to either use a `.env` file sourced at process start, or to inline env vars directly on the process start command: `REDIS_URL=redis://... NEO4J_URI=bolt://... node dist/worker.js`. The `.env` file approach is cleaner for development; the inline approach is more explicit in scripts. The broader lesson: treat environment state as immutable configuration, not mutable runtime state.

**Q: Describe a time when a deceptively simple bug caused significant debugging time.**

The source label bug in citation assembly. Every citation was being labeled as `source: "github"` regardless of the actual source of the event. A Slack message's citation said "GitHub" in the UI. The bug was a single line in `query-engine.ts`: when building citation objects from Qdrant payload results, the `source` field was hardcoded to `"github" as const` — a literal string, not a variable reading from the payload. This was written during early development when GitHub was the only source and was never updated when Slack and Jira were added. The bug was invisible until we actually ingested Slack data and looked at the citations. Finding it took longer than it should have because we initially assumed the issue was in the brain-writer (not storing source correctly in Qdrant), which led us to add instrumentation there first before finding the real culprit in the query engine. Lesson: end-to-end integration tests that check citation metadata (not just answer correctness) would have caught this immediately.

**Q: What would you do differently if you were starting the project over?**

Three things. First, establish the identity resolution model (`resolveOrCreateActorPerson`) before writing any ingestion code. We bolted it on after having three sources in production, which required a data migration to fix all existing nodes. Starting with a clear person resolution contract would have saved a full day of migration work. Second, write the eval scripts in parallel with the implementation rather than after. We wrote evals after completing each milestone — this worked, but several bugs were caught only during eval that could have been caught earlier with lighter integration tests running during development. Third, enforce `sourceId` determinism as a linting rule or type constraint from the start. The `Date.now()` bug in transcript ingest was caught by code review, but if `sourceId` had been a branded type (`SourceId`) that could only be constructed by a deterministic factory function, the bug would have been a compile error.
