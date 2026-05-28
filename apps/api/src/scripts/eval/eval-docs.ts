/**
 * eval-docs — smoke test for Phase 4 M1 document ingestion
 *
 * Ingest a synthetic ADR via the API, wait for pipeline, then query it back.
 * Pass criterion: cited answer references the ADR content.
 *
 * Usage: npm run eval:docs -w apps/api
 */
import "dotenv/config";

const API = process.env.BRAIN_API_URL ?? "http://localhost:3001";
const API_KEY = process.env.BRAIN_API_KEY ?? "";
const PROJECT = "eval_docs_project";

const SYNTHETIC_ADR = `# ADR-099: Use MessagePack over JSON for internal service communication

## Status
Accepted

## Context
Internal services exchange high-frequency telemetry payloads. JSON serialization was identified as a bottleneck under load testing (P99 latency increased by 40ms at 10k req/s).

## Decision
We decided to use MessagePack for all internal service-to-service communication. External APIs continue to use JSON. The boundary is the API gateway.

## Rationale
MessagePack provides ~30% smaller payloads and ~2x faster serialization than JSON for our telemetry schema. We evaluated Protocol Buffers and Avro but chose MessagePack because it requires no schema compilation step and integrates with existing Node.js services via a single library.

## Alternatives Considered
- Protocol Buffers: faster but requires schema compilation, adds tooling overhead
- Avro: good for streaming but complex for request-response patterns
- Remain with JSON: unacceptable under current load projections

## Consequences
All internal SDKs must be updated to support MessagePack encoding. The API gateway encodes/decodes at the boundary. No external API changes.
`;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (API_KEY) h["X-API-Key"] = API_KEY;
  return h;
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

console.log("\n── Phase 4 M1: Document ingestion eval ──\n");

// 1. Ingest the synthetic ADR
let ingestResult: { chunks_queued: number; document_type: string };
await check("POST /brain/ingest/document — accepts ADR text", async () => {
  ingestResult = await post("/brain/ingest/document", {
    text: SYNTHETIC_ADR,
    title: "ADR-099 MessagePack vs JSON",
    path: "docs/adrs/099-messagepack-vs-json.md",
    project_id: PROJECT,
    source_url: "brain://eval/adr-099",
  }) as typeof ingestResult;

  if (!ingestResult.chunks_queued || ingestResult.chunks_queued < 1) {
    throw new Error(`Expected ≥1 chunk, got ${ingestResult.chunks_queued}`);
  }
  if (ingestResult.document_type !== "adr") {
    throw new Error(`Expected document_type=adr, got ${ingestResult.document_type}`);
  }
});

console.log(`    chunks queued: ${ingestResult!.chunks_queued}, type: ${ingestResult!.document_type}`);

// 2. Wait for pipeline processing
console.log("\n  Waiting 12s for pipeline...");
await sleep(12000);

// 3. Query should return cited answer from the ADR
await check("brain_query returns answer citing ADR content", async () => {
  const res = await post("/brain/query", {
    query: "Why did we choose MessagePack over JSON for internal communication?",
    project_id: PROJECT,
    mode: "project",
  }) as { answer: string; citations: Array<{ source: string }> };

  const answer = res.answer.toLowerCase();
  if (!answer.includes("messagepack") && !answer.includes("serialization") && !answer.includes("json")) {
    throw new Error(`Answer doesn't reference MessagePack or serialization: "${res.answer.slice(0, 100)}"`);
  }
  const hasDocCitation = res.citations.some((c) => c.source === "document");
  if (!hasDocCitation) {
    throw new Error(`No document citation found. Citations: ${JSON.stringify(res.citations.map(c => c.source))}`);
  }
});

// 4. Query for alternatives
await check("brain_query returns alternatives from ADR", async () => {
  const res = await post("/brain/query", {
    query: "What alternatives were considered for internal serialization format?",
    project_id: PROJECT,
    mode: "project",
  }) as { answer: string; citations: Array<{ source: string }> };

  const answer = res.answer.toLowerCase();
  const mentionsAlternative = ["protocol buffers", "protobuf", "avro", "json"].some(
    (term) => answer.includes(term)
  );
  if (!mentionsAlternative) {
    throw new Error(`Answer doesn't mention alternatives: "${res.answer.slice(0, 150)}"`);
  }
});

// 5. Re-ingest check — document ingest is idempotent REPLACE (not 409 reject).
// Sending the same source_url a second time deletes prior Qdrant chunks and
// re-queues, returning 200. This prevents stale content from surviving updates.
await check("POST /brain/ingest/document — re-ingest same source_url returns 200", async () => {
  const result = await post("/brain/ingest/document", {
    text: SYNTHETIC_ADR,
    title: "ADR-099 MessagePack vs JSON",
    path: "docs/adrs/099-messagepack-vs-json.md",
    project_id: PROJECT,
    source_url: "brain://eval/adr-099",
  }) as { ok: boolean; chunks_queued: number };
  if (!result.ok) throw new Error(`Expected ok=true, got ${JSON.stringify(result)}`);
});

console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`);
if (failed > 0) process.exit(1);
