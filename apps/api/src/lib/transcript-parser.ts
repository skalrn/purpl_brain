// Parses VTT, SRT, and plain-text transcripts into structured segments.
// Speaker names are extracted from "Name: text" patterns in all formats.

export interface TranscriptSegment {
  speaker: string | null;  // null when no speaker tag present
  text: string;
  timestamp: string | null; // ISO string when available, null for plain text
}

export interface ParsedTranscript {
  segments: TranscriptSegment[];
  speakers: string[];        // unique speaker names found
  format: "vtt" | "srt" | "plain";
}

// ── VTT (WebVTT) ────────────────────────────────────────────────────────────

function vttTimestampToIso(ts: string, baseDate: string): string {
  // ts format: HH:MM:SS.mmm or MM:SS.mmm
  const parts = ts.split(":");
  let h = 0, m = 0, s = 0;
  if (parts.length === 3) {
    [h, m] = [parseInt(parts[0]), parseInt(parts[1])];
    s = parseFloat(parts[2]);
  } else {
    m = parseInt(parts[0]);
    s = parseFloat(parts[1]);
  }
  const d = new Date(baseDate);
  d.setTime(d.getTime() + (h * 3600 + m * 60 + s) * 1000);
  return d.toISOString();
}

function parseVtt(text: string, baseDate: string): ParsedTranscript {
  const segments: TranscriptSegment[] = [];
  const cuePattern = /(\d{2}:\d{2}:\d{2}\.\d{3}|\d{2}:\d{2}\.\d{3})\s*-->\s*[\d:.]+\s*\n([\s\S]*?)(?=\n\s*\n|\n[\d]{2}:|$)/g;

  let match;
  while ((match = cuePattern.exec(text)) !== null) {
    const timestamp = vttTimestampToIso(match[1], baseDate);
    const cueText = match[2].trim();
    if (!cueText) continue;

    const speakerMatch = cueText.match(/^<v\s+([^>]+)>([\s\S]+)$/) ??   // <v Speaker> text
                         cueText.match(/^([^:\n]+):\s+([\s\S]+)$/);     // Speaker: text
    if (speakerMatch) {
      segments.push({ speaker: speakerMatch[1].trim(), text: speakerMatch[2].trim(), timestamp });
    } else {
      segments.push({ speaker: null, text: cueText, timestamp });
    }
  }

  return { segments, speakers: extractSpeakers(segments), format: "vtt" };
}

// ── SRT (SubRip) ─────────────────────────────────────────────────────────────

function srtTimestampToIso(ts: string, baseDate: string): string {
  // ts format: HH:MM:SS,mmm
  const [time] = ts.split(",");
  const [h, m, s] = time.split(":").map(Number);
  const d = new Date(baseDate);
  d.setHours(d.getHours() + h, d.getMinutes() + m, d.getSeconds() + s);
  return d.toISOString();
}

function parseSrt(text: string, baseDate: string): ParsedTranscript {
  const segments: TranscriptSegment[] = [];
  const blocks = text.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    if (lines.length < 3) continue;

    const tsLine = lines.find((l) => l.includes("-->"));
    if (!tsLine) continue;

    const tsMatch = tsLine.match(/(\d{2}:\d{2}:\d{2},\d{3})/);
    const timestamp = tsMatch ? srtTimestampToIso(tsMatch[1], baseDate) : null;

    const textLines = lines.filter((l) => !/^\d+$/.test(l.trim()) && !l.includes("-->")).join(" ").trim();
    if (!textLines) continue;

    const speakerMatch = textLines.match(/^([^:\n]+):\s+([\s\S]+)$/);
    if (speakerMatch) {
      segments.push({ speaker: speakerMatch[1].trim(), text: speakerMatch[2].trim(), timestamp });
    } else {
      segments.push({ speaker: null, text: textLines, timestamp });
    }
  }

  return { segments, speakers: extractSpeakers(segments), format: "srt" };
}

// ── Plain text ────────────────────────────────────────────────────────────────

function parsePlain(text: string): ParsedTranscript {
  const segments: TranscriptSegment[] = [];
  const lines = text.split("\n").filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const speakerMatch = line.match(/^([A-Z][^:\n]{1,40}):\s+(.+)$/);
    if (speakerMatch) {
      segments.push({ speaker: speakerMatch[1].trim(), text: speakerMatch[2].trim(), timestamp: null });
    } else {
      segments.push({ speaker: null, text: line.trim(), timestamp: null });
    }
  }

  return { segments, speakers: extractSpeakers(segments), format: "plain" };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractSpeakers(segments: TranscriptSegment[]): string[] {
  return [...new Set(segments.map((s) => s.speaker).filter(Boolean) as string[])];
}

export function flattenToText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => (s.speaker ? `${s.speaker}: ${s.text}` : s.text))
    .join("\n");
}

export function detectAndParse(text: string, baseDate: string): ParsedTranscript {
  const trimmed = text.trim();
  if (trimmed.startsWith("WEBVTT") || /\d{2}:\d{2}:\d{2}\.\d{3}\s*-->/.test(trimmed)) {
    return parseVtt(text, baseDate);
  }
  if (/^\d+\s*\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/.test(trimmed)) {
    return parseSrt(text, baseDate);
  }
  return parsePlain(text);
}
