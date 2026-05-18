import { v4 as uuidv4 } from "uuid";
import { basename, extname } from "path";
import { chunkText, detectDocumentType } from "./document-chunker.js";
import type { CanonicalEvent } from "@purpl/types";

const GITHUB_API = "https://api.github.com";

interface GitTreeItem {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

interface GitTree {
  tree: GitTreeItem[];
  truncated?: boolean;
}

interface GitHubContents {
  content: string;
  encoding: string;
}

async function githubGet<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "purpl-brain/1.0",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}`);
  }
  return res.json() as Promise<T>;
}

async function fetchFileContent(token: string, repo: string, filePath: string): Promise<string> {
  const data = await githubGet<GitHubContents>(
    `${GITHUB_API}/repos/${repo}/contents/${filePath}`,
    token
  );
  if (data.encoding !== "base64") throw new Error(`Unexpected encoding: ${data.encoding}`);
  // GitHub wraps base64 content with newlines — strip them before decoding
  return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8");
}

export async function crawlRepoDocs(
  token: string,
  repo: string,       // "org/repo"
  projectId: string,
  pathPrefix = "docs"
): Promise<CanonicalEvent[]> {
  const tree = await githubGet<GitTree>(
    `${GITHUB_API}/repos/${repo}/git/trees/HEAD?recursive=1`,
    token
  );

  if (tree.truncated) {
    console.warn(`[doc-crawler] tree truncated for ${repo} — large repos may miss some docs`);
  }

  const docFiles = tree.tree.filter(
    (item) =>
      item.type === "blob" &&
      item.path.startsWith(pathPrefix) &&
      item.path.endsWith(".md")
  );

  console.log(`[doc-crawler] found ${docFiles.length} .md files under ${pathPrefix}/ in ${repo}`);

  const events: CanonicalEvent[] = [];

  for (const file of docFiles) {
    try {
      const content = await fetchFileContent(token, repo, file.path);
      const title = basename(file.path, extname(file.path)).replace(/[-_]/g, " ");
      const docType = detectDocumentType(file.path);
      const fileUrl = `https://github.com/${repo}/blob/HEAD/${file.path}`;
      const chunks = chunkText(content);

      for (let i = 0; i < chunks.length; i++) {
        events.push({
          event_id: `doc_${uuidv4()}`,
          source: "document",
          source_id: `${repo}/${file.path}`,
          project_id: projectId,
          actor: { type: "human", id: "github-docs", name: "Repository Docs" },
          timestamp: new Date().toISOString(),
          event_type: "document_chunk",
          raw_content: chunks[i],
          url: fileUrl,
          document_title: title,
          document_path: file.path,
          document_type: docType,
          chunk_index: i,
          total_chunks: chunks.length,
        });
      }

      console.log(`[doc-crawler] ${file.path} → ${chunks.length} chunk(s) (${docType})`);
    } catch (e) {
      console.warn(`[doc-crawler] skipping ${file.path}:`, (e as Error).message);
    }
  }

  return events;
}

// Fetch and chunk a single file — used by the webhook push handler
export async function crawlSingleFile(
  token: string,
  repo: string,
  filePath: string,
  projectId: string
): Promise<CanonicalEvent[]> {
  const content = await fetchFileContent(token, repo, filePath);
  const title = basename(filePath, extname(filePath)).replace(/[-_]/g, " ");
  const docType = detectDocumentType(filePath);
  const fileUrl = `https://github.com/${repo}/blob/HEAD/${filePath}`;
  const chunks = chunkText(content);

  return chunks.map((chunk, i) => ({
    event_id: `doc_${uuidv4()}`,
    source: "document" as const,
    source_id: `${repo}/${filePath}`,
    project_id: projectId,
    actor: { type: "human" as const, id: "github-docs", name: "Repository Docs" },
    timestamp: new Date().toISOString(),
    event_type: "document_chunk" as const,
    raw_content: chunk,
    url: fileUrl,
    document_title: title,
    document_path: filePath,
    document_type: docType,
    chunk_index: i,
    total_chunks: chunks.length,
  }));
}
