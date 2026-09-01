import type { RetrievalResult, SearchAdapter } from '@/core/research/types';
import { FixtureAdapter } from '@/core/research/fixture-adapter';
import { BraveSearchAdapter, TavilySearchAdapter } from '@/core/research/live-adapters';

export * from '@/core/research/types';
export { FixtureAdapter, DEMO_CASE_IDS, FEATURED_DEMO_ID, demoCaseById, demoCaseClaim } from '@/core/research/fixture-adapter';
export { BraveSearchAdapter, TavilySearchAdapter };

/**
 * Retrieval strategy.
 *
 * Live adapters are tried first and always win when one is configured — a demo
 * corpus must never stand in for research that could actually have been done.
 * The fixture corpus is the fallback, and anything it returns is labelled
 * DEMONSTRATION everywhere it is shown.
 */
export function liveAdapters(): SearchAdapter[] {
  return [new BraveSearchAdapter(), new TavilySearchAdapter()].filter((a) => a.isConfigured());
}

export interface RetrievalOutcome {
  result: RetrievalResult;
  /** True when a live adapter was configured but returned nothing usable. */
  liveAttempted: boolean;
}

const EMPTY_NOTE_NO_ADAPTER =
  'No web-search provider is configured, and this claim does not match a built-in demonstration case, so no sources were retrieved. ProofHound will not invent sources: set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY to run live research.';

const EMPTY_NOTE_LIVE_EMPTY =
  'A live web-search provider ran and returned no usable results for this claim. No sources were retrieved, and none have been substituted.';

export async function retrieveSources(claim: string, rawInput: string): Promise<RetrievalOutcome> {
  const live = liveAdapters();
  for (const adapter of live) {
    try {
      const result = await adapter.retrieve(claim, rawInput);
      if (result && result.sources.length > 0) return { result, liveAttempted: true };
    } catch {
      // Fall through to the next adapter; a provider outage is not a reason to
      // fabricate a record.
    }
  }

  const fixture = await new FixtureAdapter().retrieve(claim, rawInput);
  if (fixture) return { result: fixture, liveAttempted: live.length > 0 };

  return {
    result: {
      mode: 'NONE',
      adapter: live.length > 0 ? 'live-search (no results)' : 'none',
      note: live.length > 0 ? EMPTY_NOTE_LIVE_EMPTY : EMPTY_NOTE_NO_ADAPTER,
      sources: [],
      entities: [],
      events: [],
      isDemonstration: false,
    },
    liveAttempted: live.length > 0,
  };
}
