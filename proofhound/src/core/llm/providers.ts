import type { ClaimAnalysisRequest, ClaimAnalysisResult, LLMProvider } from '@/core/llm/types';
import { CLAIM_ANALYSIS_SYSTEM, claimAnalysisUserPrompt } from '@/core/llm/prompts';
import { parseClaimAnalysis } from '@/core/llm/parse';

/**
 * Concrete providers.
 *
 * Each is a thin HTTP adapter — no vendor SDKs, so adding a provider is one
 * small file and no dependency churn. Keys are read from `process.env` at call
 * time and never leave the server.
 */

const REQUEST_TIMEOUT_MS = 20_000;

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The engine used when no provider key is configured. Fully deterministic. */
export class HeuristicProvider implements LLMProvider {
  readonly name = 'heuristic';

  isConfigured(): boolean {
    return true;
  }

  async analyzeClaim(): Promise<ClaimAnalysisResult | null> {
    // Null means "keep the deterministic draft" — the rules engine is the answer.
    return null;
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  constructor(
    private readonly apiKey = process.env.ANTHROPIC_API_KEY,
    private readonly model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async analyzeClaim(request: ClaimAnalysisRequest): Promise<ClaimAnalysisResult | null> {
    if (!this.apiKey) return null;
    const data = (await postJson(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: this.model,
        max_tokens: 1024,
        system: CLAIM_ANALYSIS_SYSTEM,
        messages: [{ role: 'user', content: claimAnalysisUserPrompt(request) }],
      },
    )) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find((block) => block.type === 'text')?.text;
    return text ? parseClaimAnalysis(text) : null;
  }
}

export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai';

  constructor(
    private readonly apiKey = process.env.OPENAI_API_KEY,
    private readonly model = process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async analyzeClaim(request: ClaimAnalysisRequest): Promise<ClaimAnalysisResult | null> {
    if (!this.apiKey) return null;
    const data = (await postJson(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${this.apiKey}` },
      {
        model: this.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CLAIM_ANALYSIS_SYSTEM },
          { role: 'user', content: claimAnalysisUserPrompt(request) },
        ],
      },
    )) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content;
    return text ? parseClaimAnalysis(text) : null;
  }
}

export class GeminiProvider implements LLMProvider {
  readonly name = 'gemini';

  constructor(
    private readonly apiKey = process.env.GEMINI_API_KEY,
    private readonly model = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
  ) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async analyzeClaim(request: ClaimAnalysisRequest): Promise<ClaimAnalysisResult | null> {
    if (!this.apiKey) return null;
    const data = (await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`,
      { 'x-goog-api-key': this.apiKey },
      {
        systemInstruction: { parts: [{ text: CLAIM_ANALYSIS_SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: claimAnalysisUserPrompt(request) }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      },
    )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    return text ? parseClaimAnalysis(text) : null;
  }
}
