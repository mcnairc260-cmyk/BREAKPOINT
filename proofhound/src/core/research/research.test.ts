import { afterEach, describe, expect, it, vi } from 'vitest';
import { retrieveSources } from '@/core/research';

/**
 * Retrieval honesty.
 *
 * The banner above every investigation states where its evidence came from, so
 * these tests exist to stop that statement drifting away from what happened.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CRYPTID_CLAIM =
  'A researcher claims a DNA sample from an unknown primate was independently verified by three laboratories.';

describe('retrieveSources', () => {
  it('uses the demonstration corpus when no provider is configured', async () => {
    const outcome = await retrieveSources(CRYPTID_CLAIM, CRYPTID_CLAIM);
    expect(outcome.result.mode).toBe('DEMONSTRATION');
    expect(outcome.liveAttempted).toBe(false);
    expect(outcome.failures).toEqual([]);
    expect(outcome.result.note).not.toMatch(/attempted and failed/i);
  });

  it('says so when a configured provider fails and a demo corpus stands in', async () => {
    // Regression: a failed live search used to fall through to demonstration
    // data silently. The data was labelled, but the user had no way to tell a
    // broken provider from an unconfigured one.
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNRESET api.search.brave.com');
    }));

    const outcome = await retrieveSources(CRYPTID_CLAIM, CRYPTID_CLAIM);

    expect(outcome.result.mode).toBe('DEMONSTRATION');
    expect(outcome.liveAttempted).toBe(true);
    expect(outcome.failures).toEqual([{ adapter: 'brave-search', reason: 'ECONNRESET api.search.brave.com' }]);
    expect(outcome.result.note).toMatch(/Live web research was attempted and failed/);
    expect(outcome.result.note).toMatch(/brave-search/);
    // The failure is stated before the demonstration wording, not after it.
    expect(outcome.result.note.indexOf('failed')).toBeLessThan(
      outcome.result.note.indexOf('demonstration case'),
    );
  });

  it('reports the failure when nothing at all can be retrieved', async () => {
    vi.stubEnv('TAVILY_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('503 Service Unavailable');
    }));

    const outcome = await retrieveSources('The parish council repainted the bandstand.', 'x');

    expect(outcome.result.mode).toBe('NONE');
    expect(outcome.result.sources).toEqual([]);
    expect(outcome.result.note).toMatch(/attempted and failed/i);
    expect(outcome.result.note).toMatch(/none have been substituted/);
  });

  it('distinguishes a timeout from a refusal', async () => {
    vi.stubEnv('BRAVE_SEARCH_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => {
      const error = new Error('The operation was aborted.');
      error.name = 'AbortError';
      throw error;
    }));

    const outcome = await retrieveSources('The parish council repainted the bandstand.', 'x');
    expect(outcome.failures[0]?.reason).toBe('timed out');
  });

  it('never reports a provider failure when none was configured', async () => {
    const outcome = await retrieveSources('The parish council repainted the bandstand.', 'x');
    expect(outcome.result.mode).toBe('NONE');
    expect(outcome.result.note).toMatch(/No web-search provider is configured/);
    expect(outcome.result.note).not.toMatch(/failed/i);
  });
});
