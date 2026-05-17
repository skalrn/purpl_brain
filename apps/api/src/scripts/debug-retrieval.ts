import "dotenv/config";
import { embed } from "../lib/embed.js";
import { qdrant, COLLECTION } from "../lib/qdrant.js";

const PROJECT = process.argv[2] ?? "encode_httpx";

const queries = [
  "What asyncio changes were made for Python 3.14 compatibility?",
  "What is the status of the MockTransport elapsed time feature?",
  "Is FunctionAuth part of the public httpx API?",
  "What did the team do in response to CVE-2025-43859?",
];

for (const q of queries) {
  console.log(`\nQuery: ${q}`);
  const vec = await embed(q);
  const results = await qdrant.search(COLLECTION, {
    vector: vec,
    limit: 10,
    filter: { must: [{ key: "project_id", match: { value: PROJECT } }] },
    with_payload: true,
  });
  for (const r of (results as Array<{score:number; payload?: Record<string,unknown>}>).slice(0, 5)) {
    const id = String(r.payload?.graph_node_id ?? "?");
    const content = String(r.payload?.content ?? "").slice(0, 90).replace(/\n/g, " ");
    console.log(`  ${r.score.toFixed(3)}  ${id.padEnd(35)}  ${content}`);
  }
}
