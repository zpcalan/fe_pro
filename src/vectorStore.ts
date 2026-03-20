// ============================================================
// vectorStore.ts  —  In-memory vector store for semantic search
// Indexes workspace files and performs cosine similarity search
// ============================================================

import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { VectorChunk, SemanticSearchResult } from './types';
import { EmbeddingClient } from './embeddingClient';
import { getConfig } from './config';

const CHUNK_SIZE_LINES = 50;
const CHUNK_OVERLAP_LINES = 10;

export class VectorStore {
  private chunks: VectorChunk[] = [];
  private readonly embeddingClient: EmbeddingClient;
  private indexing = false;

  readonly onProgressEmitter = new vscode.EventEmitter<{ indexed: number; total: number }>();
  readonly onProgress = this.onProgressEmitter.event;

  constructor(embeddingClient: EmbeddingClient) {
    this.embeddingClient = embeddingClient;
  }

  /** Index all workspace files matching the configured extensions */
  async indexWorkspace(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    this.chunks = [];

    const cfg = getConfig();
    const extensions = cfg.indexingExtensions;
    const excludePatterns = cfg.indexingExcludePatterns.join(',');

    // Build glob pattern for all supported extensions
    const globPattern = `**/*{${extensions.join(',')}}`;

    let files: vscode.Uri[] = [];
    try {
      files = await vscode.workspace.findFiles(globPattern, `{${excludePatterns}}`);
      // Glob exclude is sometimes unreliable for oh_modules — filter explicitly
      files = files.filter(uri => {
        const p = uri.fsPath.replace(/\\/g, '/');
        return !p.includes('/oh_modules/') && !p.includes('/.ohpm/');
      });
    } catch (err) {
      console.error('[CuePro] Failed to find files for indexing:', err);
      this.indexing = false;
      return;
    }

    const total = files.length;
    let indexed = 0;

    for (const fileUri of files) {
      try {
        await this.indexFile(fileUri);
      } catch {
        // Skip files that can't be read
      }
      indexed++;
      this.onProgressEmitter.fire({ indexed, total });
    }

    console.log(`[CuePro] Indexed ${this.chunks.length} chunks from ${total} files`);
    this.indexing = false;
  }

  /** Index or re-index a single file */
  async indexFile(uri: vscode.Uri): Promise<void> {
    // Remove existing chunks for this file
    const uriStr = uri.toString();
    this.chunks = this.chunks.filter(c => c.uri !== uriStr);

    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }

    const content = doc.getText();
    const lines = content.split('\n');
    const newChunks = this.chunkLines(lines, uri, doc);

    if (newChunks.length === 0) return;

    // Batch embed all chunks for this file
    const texts = newChunks.map(c => c.content);
    const vectors = await this.embeddingClient.embedBatch(texts);
    if (!vectors) {
      // Embedding disabled or failed — store without vectors (text-only fallback)
      this.chunks.push(...newChunks);
      return;
    }

    for (let i = 0; i < newChunks.length; i++) {
      newChunks[i].vector = vectors[i] ?? [];
    }
    this.chunks.push(...newChunks);
  }

  /**
   * Find the top-K most semantically similar chunks to a query text.
   * Falls back to keyword matching if no vectors are available.
   */
  async search(queryText: string, topK: number): Promise<SemanticSearchResult[]> {
    if (this.chunks.length === 0) {
      console.log('[CuePro VectorStore] search called but store is empty (not indexed yet)');
      return [];
    }

    const chunksWithVectors = this.chunks.filter(c => c.vector.length > 0);
    console.log(`[CuePro VectorStore] search: ${this.chunks.length} total chunks, ${chunksWithVectors.length} with vectors`);

    // Try vector-based search if we have indexed vectors
    if (chunksWithVectors.length > 0) {
      const queryVector = await this.embeddingClient.embed(queryText);
      if (queryVector && queryVector.length > 0) {
        return this.vectorSearch(queryVector, topK);
      }
    }

    // Fallback: keyword search (covers both "no embedding API" and "indexed without vectors")
    console.log('[CuePro VectorStore] falling back to keyword search');
    return this.keywordSearch(queryText, topK);
  }

  private vectorSearch(queryVector: number[], topK: number): SemanticSearchResult[] {
    const scoredChunks = this.chunks
      .filter(c => c.vector.length > 0)
      .map(c => ({
        chunk: c,
        similarity: EmbeddingClient.cosineSimilarity(queryVector, c.vector),
      }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    return scoredChunks;
  }

  private keywordSearch(query: string, topK: number): SemanticSearchResult[] {
    const keywords = query
      .toLowerCase()
      .split(/\W+/)
      .filter(k => k.length > 3);

    const scoredChunks = this.chunks.map(c => {
      const content = c.content.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (content.includes(kw)) score++;
      }
      return { chunk: c, similarity: score / Math.max(keywords.length, 1) };
    });

    return scoredChunks
      .filter(r => r.similarity > 0)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  private chunkLines(
    lines: string[],
    uri: vscode.Uri,
    doc: vscode.TextDocument
  ): VectorChunk[] {
    const cfg = getConfig();
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
    const relativeFile = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath)
      : uri.fsPath;

    const chunks: VectorChunk[] = [];
    const totalLines = lines.length;

    let start = 0;
    while (start < totalLines) {
      const end = Math.min(start + CHUNK_SIZE_LINES - 1, totalLines - 1);
      const content = lines.slice(start, end + 1).join('\n').trim();

      if (content.length > 10) {
        const id = crypto
          .createHash('md5')
          .update(`${uri.toString()}:${start}`)
          .digest('hex');

        chunks.push({
          id,
          file: relativeFile,
          uri: uri.toString(),
          startLine: start,
          endLine: end,
          content,
          vector: [],
          lastModified: Date.now(),
        });
      }

      if (end >= totalLines - 1) break;
      start += CHUNK_SIZE_LINES - CHUNK_OVERLAP_LINES;
    }

    return chunks;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  get isIndexing(): boolean {
    return this.indexing;
  }

  dispose(): void {
    this.onProgressEmitter.dispose();
  }
}
