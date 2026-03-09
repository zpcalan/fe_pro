// ============================================================
// embeddingClient.ts  —  OpenAI-compatible embedding API client
// ============================================================

import { EmbeddingRequest, EmbeddingResponse } from './types';
import { getConfig } from './config';

export class EmbeddingClient {
  /**
   * Embed a single text string.
   * Returns null if the embedding service is disabled or unavailable.
   */
  async embed(text: string): Promise<number[] | null> {
    const cfg = getConfig();
    if (!cfg.embeddingEnabled) return null;

    const results = await this.embedBatch([text]);
    return results?.[0] ?? null;
  }

  /**
   * Embed multiple texts in a single API call (more efficient).
   */
  async embedBatch(texts: string[]): Promise<number[][] | null> {
    const cfg = getConfig();
    if (!cfg.embeddingEnabled || texts.length === 0) return null;

    const url = `${cfg.embeddingApiUrl.replace(/\/$/, '')}/v1/embeddings`;
    const body: EmbeddingRequest = {
      model: cfg.embeddingModel,
      input: texts,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (cfg.embeddingApiKey) {
      headers['Authorization'] = `Bearer ${cfg.embeddingApiKey}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => 'unknown error');
        console.error(`[CuePro] Embedding API error ${response.status}: ${errText}`);
        return null;
      }

      const data = (await response.json()) as EmbeddingResponse;
      // Sort by index to maintain order
      return data.data
        .sort((a, b) => a.index - b.index)
        .map(item => item.embedding);
    } catch (err) {
      console.error('[CuePro] Embedding request failed:', err);
      return null;
    }
  }

  /** Cosine similarity between two vectors */
  static cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
}
