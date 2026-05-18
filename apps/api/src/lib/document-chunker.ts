// 512-token sliding window chunker (4 chars ≈ 1 token)
// Breaks at paragraph or sentence boundaries where possible.

const CHUNK_CHARS = 2048;   // ~512 tokens
const OVERLAP_CHARS = 410;  // ~20% overlap

export type DocumentType = "adr" | "prd" | "runbook" | "unknown";

export function detectDocumentType(filePath: string): DocumentType {
  const lower = filePath.toLowerCase();
  if (/\/adrs?\/|\/adr[-_]|\badr\b/.test(lower)) return "adr";
  if (/\/prd\/|prd\.md$|product[-_]requirements/.test(lower)) return "prd";
  if (/\/runbooks?\/|runbook/.test(lower)) return "runbook";
  return "unknown";
}

export function chunkText(text: string, chunkSize = CHUNK_CHARS, overlap = OVERLAP_CHARS): string[] {
  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      // Prefer paragraph break
      const paraBreak = text.lastIndexOf("\n\n", end);
      if (paraBreak > start + chunkSize / 2) {
        end = paraBreak;
      } else {
        // Fall back to sentence break
        const sentBreak = text.lastIndexOf(". ", end);
        if (sentBreak > start + chunkSize / 2) {
          end = sentBreak + 1;
        }
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk.length > 20) chunks.push(chunk);

    if (end >= text.length) break;

    const nextStart = end - overlap;
    if (nextStart <= start) break; // no forward progress — text shorter than overlap
    start = nextStart;
  }

  return chunks;
}
