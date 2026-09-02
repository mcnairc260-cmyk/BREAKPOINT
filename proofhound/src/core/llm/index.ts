import type { LLMProvider } from '@/core/llm/types';
import { AnthropicProvider, GeminiProvider, HeuristicProvider, OpenAIProvider } from '@/core/llm/providers';

export type { ClaimAnalysisRequest, ClaimAnalysisResult, LLMProvider } from '@/core/llm/types';

/**
 * Provider selection.
 *
 * `PROOFHOUND_LLM_PROVIDER` pins a provider explicitly; otherwise the first
 * configured provider wins. With no keys at all, the heuristic engine runs and
 * the UI says so — it does not pretend a model was consulted.
 */
export function selectLLMProvider(): LLMProvider {
  const providers: LLMProvider[] = [new AnthropicProvider(), new OpenAIProvider(), new GeminiProvider()];
  const pinned = process.env.PROOFHOUND_LLM_PROVIDER?.trim().toLowerCase();

  if (pinned && pinned !== 'heuristic') {
    const match = providers.find((p) => p.name === pinned);
    if (match?.isConfigured()) return match;
  }
  if (pinned === 'heuristic') return new HeuristicProvider();

  return providers.find((p) => p.isConfigured()) ?? new HeuristicProvider();
}

export { AnthropicProvider, GeminiProvider, HeuristicProvider, OpenAIProvider };
