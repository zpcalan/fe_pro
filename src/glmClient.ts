// ============================================================
// glmClient.ts  —  GLM-5 / OpenAI-compatible LLM API client
// ============================================================

import { ChatMessage, ChatCompletionResponse } from './types';
import { getConfig, requireConfig } from './config';

export interface LLMCallOptions {
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'json_object' | 'text';
}

export class GlmClient {
  /**
   * Send a chat completion request to GLM.
   * Returns the parsed JSON object if responseFormat is 'json_object',
   * or the raw text string otherwise.
   */
  async chat(messages: ChatMessage[], options: LLMCallOptions = {}): Promise<string> {
    const cfg = requireConfig();

    const url = `${cfg.glmApiUrl.replace(/\/$/, '')}/chat/completions`;

    const body: Record<string, unknown> = {
      model: cfg.glmModel,
      messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.maxTokens ?? 4096,
    };
    body['thinking'] = {
      "type": "disabled"
    };

    // if (options.responseFormat === 'json_object') {
    //   body['response_format'] = { type: 'json_object' };
    // }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.glmApiKey}`,
    };

    let lastError: Error | null = null;
    
    console.log("Try to call GLM-4-7 to generate patches")
    console.log((body['messages'] as any[])?.[1]?.['content']); 
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(1200_000), // 2 min timeout
        });

        const responseText = await response.text();

        if (!response.ok) {
          throw new Error(`GLM API error ${response.status}: ${responseText}`);
        }
        const data = JSON.parse(responseText) as ChatCompletionResponse;
        const content = data.choices?.[0]?.message?.content ?? '';
        console.log(content)
        return content;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 2) {
          await delay(1000 * (attempt + 1)); // exponential backoff: 1s, 2s
        }
      }
    }

    throw lastError ?? new Error('GLM API call failed after 3 attempts');
  }

  /**
   * Chat and parse response as JSON.
   * Strips markdown code fences if present.
   */
  async chatJson<T>(messages: ChatMessage[], options: LLMCallOptions = {}): Promise<T> {
    const raw = await this.chat(messages, { ...options, responseFormat: 'json_object' });
    return parseJsonSafe<T>(raw);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Parse JSON from LLM output, stripping markdown code fences if present.
 */
export function parseJsonSafe<T>(raw: string): T {
  let text = raw.trim();

  // Strip markdown code fences: ```json ... ``` or ``` ... ```
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Find first { or [ to handle leading text
  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace >= 0 && firstBracket >= 0) {
    start = Math.min(firstBrace, firstBracket);
  } else {
    start = Math.max(firstBrace, firstBracket);
  }

  if (start > 0) {
    text = text.slice(start);
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Failed to parse LLM JSON response: ${err}\n\nRaw output:\n${raw.slice(0, 500)}`);
  }
}
