# Implementation Deep Dive

A comprehensive technical reference for engineers extending the Purpl Brain codebase. This document covers the full data flow, component responsibilities, data models, algorithms, and key code patterns.

---

## Full Data Flow: Ingestion to Query Response

```
External Source
    │
    ▼
Webhook / Listener / Ingest API
    │  (returns 200 immediately)
    ▼
Redis Streams: events:raw
    │
    ▼
normalizer.ts (worker)
    │  CanonicalEvent
    ▼
Redis Streams: events:normalized
    │
    ▼
extractor.ts (worker)
    │  Pass 1: rule-based filter
    │  Pass 2: LLM extraction (candidates only)
    │  ExtractionResult
    ▼
Redis Streams: events:extracted
    │
    ▼
brain-writer.ts (worker)
    │  Dual write: Neo4j + Qdrant
    │  resolveOrCreateActorPerson
    ▼
Neo4j (graph)  +  Qdrant (vectors)
    │                    │
    └──────────┬──────────┘
               ▼
        query-engine.ts
               │
        1. embed query
        2. Qdrant semantic search (top-k)
        3. Neo4j graph expand
        4. Context assembly + dedup
        5. LLM answer generation
        6. Citation assembly
               │
               ▼
        Chat UI / MCP client / REST caller
```

---

## Source Ingestion Strategies

### GitHub

GitHub sends webhooks for push, pull_request, pull_request_review, and issue_comment events. The webhook handler (`routes/webhooks.ts`) validates the `X-Hub-Signature-256` HMAC header, extracts the raw payload, and enqueues to `events:raw` with `source: "github"`.

The normalizer maps GitHub-specific fields to `CanonicalEvent`:
- `push` → actor = `pusher.name`, content = concatenated commit messages
- `pull_request` → actor = `sender.login`, content = title + body
- `pull_request_review` → actor = `review.user.login`, content = review body
- `issue_comment` → actor = `comment.user.login`, content = comment body

The `sourceId` is constructed from the GitHub delivery ID (`X-GitHub-Delivery` header) to ensure idempotency. Re-delivered webhooks do not produce duplicate nodes.

### Slack

Slack uses Bolt's event API (`workers/slack-listener.ts`). The listener subscribes to `message` and `app_mention` events. Slack's event payload is normalized similarly: actor = `event.user`, content = `event.text`, channelId = `event.channel`.

Slack user IDs (e.g., `U01ABC123`) are resolved to display names via the Slack Web API (`users.info`). The resolved display name is used as the `actor` in `CanonicalEvent`. Identity resolution then maps this display name to a Person node via fuzzy match or alias lookup.

### Jira

Jira sends webhooks for `jira:issue_created`, `jira:issue_updated`, and `comment_created`. The handler extracts the issue key, summary, description, and status transitions. Status transitions (e.g., `In Progress → Done`) are particularly valuable as signals for drift detection — a ticket that moves to Done without a corresponding PR merge is a signal worth surfacing.

### Meeting Transcripts

Transcripts are ingested via `POST /brain/ingest/transcript` or `POST /webhooks/fireflies` (Fireflies.ai webhook). The transcript parser (`lib/transcript-parser.ts`) auto-detects format:

- **VTT**: Parses WebVTT timestamp lines (`HH:MM:SS.mmm --> HH:MM:SS.mmm`) and speaker attribution (`Speaker Name: text`)
- **SRT**: Parses SRT sequence numbers, timestamp lines (`HH:MM:SS,mmm --> HH:MM:SS,mmm`), and subtitle text blocks
- **Plain text**: Speaker lines detected by regex pattern `^[A-Z][A-Za-z\s]+:\s` at line start

Parsed transcripts are chunked into `TranscriptChunk` objects (speaker, start_time, end_time, text). Each chunk becomes a separate `CanonicalEvent` with `source: "meeting"`. The actor is resolved via `resolvePersonByName` (fuzzy match on display name against known Person nodes).

Because a 60-minute meeting transcript can produce hundreds of chunks, transcript ingest submits a batch of events to `events:raw` in a single Redis XADD pipeline call. This is the "chunked multi-event" pattern — the API returns 200 after enqueuing all chunks, not after processing.

### Documents

Documents are ingested via `POST /brain/ingest/document` (single document paste or URL) or `POST /brain/ingest/crawl-docs` (GitHub repository crawl). The GitHub crawler (`lib/github-doc-crawler.ts`) uses the GitHub Trees API (`GET /repos/{owner}/{repo}/git/trees/{sha}?recursive=1`) to enumerate all files, then fetches content via the Contents API for files matching documentation patterns (`.md`, `.mdx`, `.rst`, `.txt` extensions, excluding `node_modules` and `dist`).

Documents are chunked by `document-chunker.ts` before entering the ingestion pipeline. See the Chunking Algorithm section below.

Document type is detected from the file path:
- `adr/` or `adrs/` in path → `doc_type: "adr"`
- `prd/` in path → `doc_type: "prd"`
- `runbook/` or `playbook/` in path → `doc_type: "runbook"`
- Default → `doc_type: "doc"`

The `doc_type` is stored in the Qdrant payload, enabling specialist queries like "show me only ADRs about the auth service."

### AI Agent Logs

Agents write structured decision logs to `POST /brain/agent-log`. The endpoint accepts:

```typescript
interface AgentLog {
  agent_id: string;
  session_id: string;
  action: string;         // "decided" | "queried" | "modified" | "created"
  rationale: string;
  context_refs: string[]; // sourceIds of brain chunks the agent read
  outcome?: string;
  project_id: string;
}
```

Agent logs flow through the same `events:raw` → normalization → extraction → brain-write pipeline as human signals. The only difference is `source: "agent"` in the CanonicalEvent. This means agent decisions appear in the same Neo4j graph alongside human decisions and are retrievable via the same query interface.

---

## Data Models

### CanonicalEvent

The normalized representation of any signal from any source:

```typescript
interface CanonicalEvent {
  id: string;              // UUID, generated at normalization time
  sourceId: string;        // deterministic ID from source (GitHub delivery ID, Jira issue key, etc.)
  source: "github" | "slack" | "jira" | "meeting" | "doc" | "agent";
  projectId: string;
  actor: string;           // display name or login at source
  actorEmail?: string;
  content: string;         // normalized text content
  url?: string;            // canonical URL for citation
  timestamp: string;       // ISO 8601
  metadata: Record<string, unknown>;  // source-specific fields preserved
}
```

### ExtractionResult

Output of the extractor worker after LLM pass:

```typescript
interface ExtractionResult extends CanonicalEvent {
  entities: {
    decisions: DecisionEntity[];
    people: PersonEntity[];
    components: ComponentEntity[];
  };
  summary: string;         // LLM-generated 1-2 sentence summary
  isDecisionCandidate: boolean;
  extractionConfidence: number;  // 0.0 - 1.0
}

interface DecisionEntity {
  text: string;
  rationale?: string;
  alternatives?: string[];
  actors: string[];
  confidence: number;
}
```

### Neo4j Graph Schema

Node types and their key properties:

```
(:Event {
  id: UUID,
  sourceId: String,         // deterministic from source
  source: String,
  content: String,
  summary: String,
  url: String,
  timestamp: DateTime,
  projectId: String
})

(:Decision {
  id: UUID,
  text: String,
  rationale: String,
  confidence: Float,
  status: String,           // "active" | "superseded" | "drift"
  source_signals: String[]  // sourceIds of events that contributed
})

(:Person {
  id: UUID,                 // canonical UUID
  display_name: String,
  email: String,
  github_login: String,
  slack_user_id: String,
  jira_account_id: String,
  api_key: String           // for agent authentication
})

(:Component {
  id: UUID,
  name: String,
  type: String              // "service" | "library" | "database" | "api"
})

(:Project {
  id: UUID,
  slug: String,
  name: String
})
```

Relationship types:

```cypher
(Event)-[:AUTHORED_BY]->(Person)
(Event)-[:BELONGS_TO]->(Project)
(Event)-[:MENTIONS]->(Component)
(Event)-[:REFERENCES]->(Event)     // e.g., PR references commit
(Decision)-[:DERIVED_FROM]->(Event)
(Decision)-[:SUPERSEDES]->(Decision)
(Person)-[:HAS_ALIAS {source: String}]->(Person)
(Person)-[:MEMBER_OF]->(Project)
```

### Qdrant Payload Schema

Every vector stored in Qdrant has a payload:

```typescript
interface QdrantPayload {
  event_id: string;          // UUID matches Neo4j Event.id
  source_id: string;         // deterministic source ID
  source: string;            // "github" | "slack" | "jira" | "meeting" | "doc" | "agent"
  project_id: string;
  actor_person_id: string;   // UUID of resolved Person node in Neo4j
  content: string;           // original text of this chunk
  summary: string;
  url: string;
  timestamp: string;         // ISO 8601
  doc_type?: string;         // "adr" | "prd" | "runbook" | "doc" (documents only)
  chunk_index?: number;      // position within parent document
  speaker?: string;          // meeting transcripts only
}
```

The `actor_person_id` field is the critical link between Qdrant and Neo4j. A Qdrant filter on `actor_person_id` scopes a semantic search to a specific person's contributions across all sources.

---

## Chunking Algorithm

Documents too large for a single embedding call are split by `document-chunker.ts` using a sliding window algorithm.

**Parameters:**
- `chunkSize`: 2048 characters (~512 tokens at average English token density)
- `overlap`: 410 characters (~20% of chunk size)

**Algorithm:**

```typescript
function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // Boundary detection: prefer paragraph break within last 20% of chunk
    if (end < text.length) {
      const searchStart = end - Math.floor(chunkSize * 0.2);
      const paraBreak = text.lastIndexOf('\n\n', end);
      if (paraBreak > searchStart) {
        end = paraBreak + 2;
      } else {
        // Fall back to sentence boundary
        const sentenceBreak = text.lastIndexOf('. ', end);
        if (sentenceBreak > searchStart) {
          end = sentenceBreak + 2;
        }
      }
    }

    chunks.push(text.slice(start, end));

    const nextStart = end - overlap;
    // Guard: prevent infinite loop on short text
    if (nextStart <= start || end >= text.length) break;
    start = nextStart;
  }

  return chunks;
}
```

The infinite loop guard (`if (nextStart <= start || end >= text.length) break`) was added after discovering that text shorter than the overlap size caused `start` to go negative, producing an infinite loop. Any text shorter than `chunkSize` produces exactly one chunk.

Each chunk is submitted as a separate `CanonicalEvent` with `chunk_index` in metadata. The parent document's `sourceId` is shared across all chunks so they can be retrieved and reassembled if needed.

---

## Identity Resolution System

`resolveOrCreateActorPerson` in `lib/neo4j.ts` is the single entry point for mapping any actor reference from any source to a canonical Person UUID.

### Resolution Strategies by Source

**GitHub:**
```cypher
MERGE (p:Person {github_login: $login})
ON CREATE SET p.id = randomUUID(), p.display_name = $login, p.created_at = datetime()
RETURN p.id AS person_id
```
GitHub logins are globally unique and stable. This is the simplest and most reliable merge key.

**Slack and Jira:**
1. Check alias table: `MATCH (p:Person)-[:HAS_ALIAS {source: $source, value: $userId}]->() RETURN p.id`
2. If not found, check email: `MATCH (p:Person {email: $email}) RETURN p.id`
3. If not found, create stub: new Person node with `display_name`, link alias

**Meetings and Agents:**
1. Fuzzy match on `display_key` (normalized: lowercase, remove punctuation, collapse whitespace)
2. If confidence > 0.85, use matched node
3. Otherwise create stub keyed on `display_key`

### Alias Table

Aliases are stored as properties on a `HAS_ALIAS` relationship:
```cypher
(person:Person)-[:HAS_ALIAS {source: "slack", value: "U01ABC123"}]->(person)
```

Self-referential by convention — the alias points back to the same node to make lookup queries uniform.

### OAuth Merge

When a user authenticates via GitHub OAuth, `auth.ts` calls `upsertPersonByEmail` which does a two-step merge:
1. Find existing Person by `github_login` (set during bot event processing)
2. If found, add `email` to the existing node
3. If not found, create new Person with both `github_login` and `email`

This prevents the shadow duplicate problem where bot-created Person nodes and OAuth-created Person nodes for the same human exist separately.

---

## RAG Pipeline

The query engine (`services/query-engine.ts`) implements a three-stage pipeline:

### Stage 1: Intent Classification and Query Preprocessing

The raw query string is classified by a lightweight rule-based classifier:
- **Temporal query**: contains date ranges, "last week", "since", "before" → routes to temporal query path
- **Person query**: contains @mention or proper noun matching a known Person → adds person filter
- **Component query**: mentions a known component name → adds component filter
- **General semantic**: default

The query string is also normalized: lowercase, punctuation stripped for embedding, but preserved for display.

### Stage 2: Hybrid Retrieval

**Semantic retrieval (Qdrant):**
```typescript
const embedding = await embed(normalizedQuery);  // cached 1hr TTL

const results = await qdrant.search(COLLECTION, {
  vector: embedding,
  limit: 20,
  filter: buildQdrantFilter(intent),  // project_id, actor_person_id, doc_type filters
  with_payload: true,
  score_threshold: 0.65
});
```

**Graph expansion (Neo4j):**
For each of the top-10 semantic results, the engine pulls in causally related nodes:
```cypher
MATCH (e:Event {id: $eventId})
OPTIONAL MATCH (e)<-[:DERIVED_FROM]-(d:Decision)
OPTIONAL MATCH (e)-[:REFERENCES]->(ref:Event)
OPTIONAL MATCH (e)-[:AUTHORED_BY]->(p:Person)
OPTIONAL MATCH (d)-[:SUPERSEDES]->(prev:Decision)
RETURN e, d, ref, p, prev
LIMIT 15
```

The graph expansion adds context that semantic search alone cannot find: the decision that was derived from a PR comment, the earlier decision that the current one supersedes, the author's other contributions.

### Stage 3: Context Assembly and Answer Generation

Retrieved chunks are deduplicated by `event_id`, then ranked by a combined score:
```
score = (semantic_score * 0.7) + (recency_boost * 0.2) + (graph_depth_penalty * 0.1)
```

`recency_boost` is calculated from the event timestamp — events within the last 7 days get a 0.1 boost, last 30 days get 0.05.

`graph_depth_penalty` reduces the score of nodes pulled in via graph expansion (not directly retrieved by semantic search) to prevent graph-expanded noise from dominating the context.

The top 8-10 chunks (up to ~6000 tokens) are assembled into the LLM context. The LLM call uses prompt caching:

```typescript
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-5",
  system: [
    {
      type: "text",
      text: QUERY_SYSTEM_PROMPT,  // static instructions, schema
      cache_control: { type: "ephemeral" }  // cached, 5-min TTL default
    }
  ],
  messages: [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: assembledContext,
          cache_control: { type: "ephemeral" }  // session-scoped context cached
        },
        {
          type: "text",
          text: `Question: ${query}`  // dynamic, not cached
        }
      ]
    }
  ]
});
```

### Citation Assembly

Every answer includes citations grounded to source events. The citation contract:

```typescript
interface Citation {
  sourceId: string;
  source: string;     // "github" | "slack" | etc.
  url: string;
  actor: string;
  timestamp: string;
  snippet: string;    // verbatim excerpt from source chunk
}
```

Citations are assembled by matching `[SOURCE: event_id]` tags in the LLM's output against the retrieved chunks. The LLM is instructed in the system prompt to tag every factual claim with the source event ID. Post-processing strips the tags from the displayed answer and builds the citation list.

Deduplication: if the same `sourceId` appears multiple times (common when a document is chunked into multiple vectors), only the first occurrence is shown in the citation list, with the highest-confidence snippet.

A validation pass checks that every cited `event_id` exists in the retrieved context. Citations to hallucinated IDs are stripped before the response is returned.

---

## LLM Prompt Caching Implementation

`lib/llm.ts` wraps the Anthropic SDK and enforces caching discipline across all call sites.

### Extraction Pipeline (1-hour TTL)

Extraction calls are bursty: when a large document is ingested, dozens of chunks are processed in parallel. The extraction system prompt is large (~2000 tokens) and identical across all calls. The 1-hour TTL ensures the cache survives the gap between document ingestion batches.

```typescript
const EXTRACTION_SYSTEM: Anthropic.TextBlockParam[] = [
  {
    type: "text",
    text: buildExtractionSystemPrompt(),  // static, deterministic
    cache_control: { type: "ephemeral", ttl: "1h" } as any
  }
];
```

The `ttl: "1h"` extension is passed as an untyped field (the SDK's TypeScript types don't expose TTL yet, but the API accepts it).

### Query Sessions (5-minute default TTL)

Interactive query sessions use the default 5-minute TTL. The context window changes with every query (different retrieved chunks), but the system prompt is stable. Caching the system prompt saves ~2000 tokens of input cost on every call in a session.

### Cache Verification

During development and in CI evals, cache hit rate is verified:

```typescript
if (process.env.VERIFY_CACHE && response.usage.cache_read_input_tokens === 0) {
  logger.warn({
    usage: response.usage,
    firstSystemBlockLength: systemBlocks[0].text.length
  }, "Cache miss on repeated call — check for silent invalidators");
}
```

Common silent invalidators found during development:
- Timestamp interpolated into system prompt text
- Tool definitions added/removed conditionally per request
- Whitespace or newline differences in system prompt construction

---

## MCP Server Interface

The MCP server (`routes/mcp.ts`) exposes the brain to any MCP-compatible LLM client (Claude Desktop, Cursor, Copilot). It implements the `@modelcontextprotocol/sdk` server interface.

### Tools Exposed

**`brain_query`**
```typescript
{
  name: "brain_query",
  description: "Query the project brain for context, decisions, and history",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
      project_id: { type: "string" },
      filters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["github", "slack", "jira", "meeting", "doc", "agent"] },
          actor_email: { type: "string" },
          date_from: { type: "string" },
          date_to: { type: "string" }
        }
      }
    },
    required: ["query", "project_id"]
  }
}
```

**`brain_remember`**
```typescript
{
  name: "brain_remember",
  description: "Write a decision or observation to the project brain",
  inputSchema: {
    type: "object",
    properties: {
      agent_id: { type: "string" },
      session_id: { type: "string" },
      action: { type: "string", enum: ["decided", "queried", "modified", "created"] },
      rationale: { type: "string" },
      context_refs: { type: "array", items: { type: "string" } },
      project_id: { type: "string" }
    },
    required: ["agent_id", "session_id", "action", "rationale", "project_id"]
  }
}
```

Tool definitions are sorted alphabetically (`brain_query` before `brain_remember`) to ensure a deterministic order for prompt caching. The MCP server must not add or remove tools per-session.

### Transport

The MCP server uses HTTP with SSE (Server-Sent Events) for streaming tool results. Agents connect to `GET /mcp/sse` for the event stream and `POST /mcp/message` to send tool calls. Authentication uses the agent's API key in the `Authorization: Bearer` header, which resolves to a Person node via `getPersonByApiKey`.

---

## Drift Detection

The drift detector worker (`workers/drift-detector.ts`) runs on a scheduled interval (every 5 minutes). It queries Neo4j for Decision nodes in `active` status and checks for signals that contradict the decision:

```cypher
MATCH (d:Decision {status: "active"})
WHERE d.created_at > datetime() - duration('P30D')
WITH d
MATCH (e:Event)
WHERE e.timestamp > d.created_at
  AND e.projectId = d.projectId
  AND e.content CONTAINS d.text  // simplified; actual uses embedding similarity
RETURN d, collect(e) AS contra_signals
LIMIT 50
```

In practice, the contradiction check uses embedding cosine similarity (Qdrant) rather than substring match, but the graph query structure is the same. If a contradiction signal score exceeds the threshold (0.75 by default), the Decision's `status` is updated to `drift` and a drift alert event is written back to the brain.

---

## Deployment Architecture (AWS CDK v2)

The CDK stacks (`apps/cdk/`) deploy:

- **API Stack**: ECS Fargate service (2 vCPU, 4 GB) behind an ALB. Auto-scales on CPU > 70%.
- **Worker Stack**: Separate ECS Fargate tasks for each worker (normalizer, extractor, brain-writer, drift-detector). Workers are stateless; Redis Streams provides durability.
- **Data Stack**: ElastiCache Redis cluster (r6g.large), Qdrant on EC2 (m6i.xlarge, gp3 EBS), Neo4j on EC2 (r6i.xlarge, gp3 EBS).
- **Chat Stack**: Next.js app on ECS Fargate or S3+CloudFront (static export).

Workers and the API share the same VPC. Redis, Qdrant, and Neo4j are in private subnets. The ALB is in public subnets.

Environment variables are stored in AWS Secrets Manager and injected into ECS task definitions. The `export VAR=value` pattern cannot be used in the shell because environment state does not persist between Claude Code Bash tool calls — all process starts must inline env vars or source from `.env`.

---

## Common Extension Patterns

### Adding a New Ingestion Source

1. Add a handler in `routes/webhooks.ts` or a new listener process
2. Map source fields to `CanonicalEvent` in `workers/normalizer.ts` (add a case to the source switch)
3. Add source-specific entity extraction hints in `workers/extractor.ts` if the source has structured fields
4. Ensure `sourceId` is deterministic (not Date.now() — use a stable identifier from the source)
5. Add the source string to the `source` union type in `packages/types`
6. Write an eval script in `apps/api/src/scripts/eval-*.ts` covering the new source

### Adding a New Query Filter

1. Add the filter field to the query API schema in `routes/query.ts`
2. Update `buildQdrantFilter` in `services/query-engine.ts` to translate the filter to a Qdrant `must` condition
3. Ensure the field is stored in `QdrantPayload` by `workers/brain-writer.ts`
4. Test that the filter does not break existing queries when absent (all filters are optional)

### Adding a New MCP Tool

1. Define the tool with a deterministic name (alphabetical ordering must be maintained)
2. Add the tool definition to the sorted array in `routes/mcp.ts`
3. Implement the handler
4. Verify that adding the tool does not break the cache prefix for existing tools (run the cache verification check)
