/**
 * Skipper - OpenAI-Compatible LLM Client
 * Communicates with any OpenAI-compatible /v1/chat/completions endpoint using native fetch.
 */

import { ChatMessage, LLMCompletionOptions, LLMCompletionResult } from './types';

export interface LLMClientConfig {
  baseUrl: string;
  apiKey: string;
  defaultModel?: string;
  defaultTimeoutMs?: number;
  timeoutMs?: number;
}

export class LLMClient {
  private baseUrl: string;
  private apiKey: string;
  private defaultModel: string;
  private defaultTimeoutMs: number;

  constructor(config: LLMClientConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel || 'deepseek-v4-flash';
    this.defaultTimeoutMs = config.timeoutMs || config.defaultTimeoutMs || 30000;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  public getModel(): string {
    return this.defaultModel;
  }

  public updateConfig(config: Partial<LLMClientConfig>): void {
    if (config.baseUrl !== undefined) this.baseUrl = config.baseUrl;
    if (config.apiKey !== undefined) this.apiKey = config.apiKey;
    if (config.defaultModel !== undefined) this.defaultModel = config.defaultModel;
    if (config.defaultTimeoutMs !== undefined) this.defaultTimeoutMs = config.defaultTimeoutMs;
  }

  /**
   * Sends a chat completion request to the OpenAI-compatible endpoint.
   *
   * @param messages Array of chat messages ({ role, content })
   * @param options Execution options (model, temperature, jsonMode, timeoutMs)
   * @returns Completion result containing response text content and token usage stats
   */
  public async chatCompletion(
    messages: Array<{ role: string; content: string }>,
    options?: LLMCompletionOptions
  ): Promise<LLMCompletionResult> {
    const cleanBase = this.baseUrl.replace(/\/+$/, '');
    const endpoint = `${cleanBase}/chat/completions`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const payload: Record<string, any> = {
      model: options?.model || this.defaultModel,
      messages,
      temperature: options?.temperature ?? 0.1,
    };

    if (options?.jsonMode) {
      payload['response_format'] = { type: 'json_object' };
    }

    const maxRetries = options?.maxRetries ?? 3;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => {
        controller.abort();
      }, timeoutMs);

      let response: Response | null = null;
      let networkError: any = null;

      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (err: any) {
        networkError = err;
      } finally {
        clearTimeout(timeoutHandle);
      }

      if (networkError) {
        const isAbort = networkError.name === 'AbortError';
        if (attempt < maxRetries) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
          console.warn(
            `[LLMClient] ${isAbort ? 'Timeout' : 'Network error'}: ${networkError.message}. Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        if (isAbort) {
          throw new Error(`[LLMClient] Request timed out after ${timeoutMs}ms`);
        }
        throw new Error(`[LLMClient] Network request failed: ${networkError?.message || String(networkError)}`);
      }

      if (!response!.ok) {
        let errorBody = '';
        try {
          errorBody = await response!.text();
        } catch {}

        const status = response!.status;
        const isRetryable = status === 429 || status === 502 || status === 503 || status === 504;

        if (isRetryable && attempt < maxRetries) {
          const delayMs = Math.min(1200 * Math.pow(2, attempt), 5000);
          console.warn(
            `[LLMClient] Upstream status ${status} (${response!.statusText}). Retrying in ${delayMs}ms... (attempt ${attempt + 1}/${maxRetries})`
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        throw new Error(
          `[LLMClient] API error (${status} ${response!.statusText}): ${errorBody || 'No response body'}`
        );
      }

      let parsed: any;
      try {
        parsed = await response!.json();
      } catch (err: any) {
        throw new Error(`[LLMClient] Failed to parse JSON response: ${err?.message || String(err)}`);
      }

      const choice = parsed.choices?.[0];
      const content = choice?.message?.content ?? '';

      return {
        content,
        usage: parsed.usage,
      };
    }

    throw new Error('[LLMClient] Max retries reached without response');
  }
}
