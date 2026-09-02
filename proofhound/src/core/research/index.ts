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
  /** True when a live adapter was configured and run. */
  liveAttempted: boolean;
  /** Every live adapter that was tried and did not deliver, and why. */
  failures: AdapterFailure[];
}

const EMPTY_NOTE_NO_ADAPTER =
  'No web-search provider is configured, and this claim does not match a built-in demonstration case, so no sources were retrieved. ProofHound will not invent sources: set BRAVE_SEARCH_API_KEY or TAVILY_API_KEY to run live research.';

const EMPTY_NOTE_LIVE_EMPTY =
  'A live web-search provider ran and returned no usable results for this claim. No sources were retrieved, and none have been substituted.';

/** One sentence naming each provider that was tried and how it failed. */
function describeFailures(failures: AdapterFailure[]): string {
  const detail = failures.map((f) => `${f.adapter} (${f.reason})`).join('; ');
  return `Live web research was attempted and failed: ${detail}.`;
}

interface AdapterFailure {
  adapter: string;
  reason: string;
}

function failureReason(error: unknown): string {
  if (!(error instanceof Error)) return 'unknown error';
  // Abort means the request hit the adapter timeout rather than being refused.
  if (error.name === 'AbortError') return 'timed out';
  return error.message.slice(0, 120);
}

export async function retrieveSources(claim: string, rawInput: string): Promise<RetrievalOutcome> {
  const live = liveAdapters();
  const failures: AdapterFailure[] = [];

  for (const adapter of live) {
    try {
      const result = await adapter.retrieve(claim, rawInput);
      if (result && result.sources.length > 0) return { result, liveAttempted: true, failures };
      failures.push({ adapter: adapter.name, reason: 'returned no results' });
    } catch (error) {
      // A provider outage is not a reason to fabricate a record — but it is also
      // not something to hide. It is recorded and surfaced to the user, because
      // "your search provider is broken" and "no provider is configured" lead to
      // very different next steps.
      failures.push({ adapter: adapter.name, reason: failureReason(error) });
    }
  }

  const errored = failures.filter((f) => f.reason !== 'returned no results');

  const fixture = await new FixtureAdapter().retrieve(claim, rawInput);
  if (fixture) {
    return {
      result: {
        ...fixture,
        // Demonstration data must never quietly stand in for research that was
        // supposed to run. If a live adapter was tried, the note says so first.
        note: failures.length > 0 ? `${describeFailures(failures)} ${fixture.note}` : fixture.note,
      },
      liveAttempted: live.length > 0,
      failures,
    };
  }

  const note =
    errored.length > 0
      ? `${describeFailures(failures)} No sources were retrieved, and none have been substituted.`
      : live.length > 0
        ? EMPTY_NOTE_LIVE_EMPTY
        : EMPTY_NOTE_NO_ADAPTER;

  return {
    result: {
      mode: 'NONE',
      adapter: live.length > 0 ? 'live-search (no results)' : 'none',
      note,
      sources: [],
      entities: [],
      events: [],
      isDemonstration: false,
    },
    liveAttempted: live.length > 0,
    failures,
  };
}
