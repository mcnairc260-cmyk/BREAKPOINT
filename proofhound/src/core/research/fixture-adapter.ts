import type { RetrievalResult, SearchAdapter } from '@/core/research/types';
import { CRYPTID_DNA_CASE } from '@/core/fixtures/cryptid-dna';
import { UAP_ALLOY_CASE } from '@/core/fixtures/uap-alloy';

/**
 * The demonstration corpus.
 *
 * This adapter never touches the network and never pretends to. It matches an
 * incoming claim against the shipped demonstration cases and, if nothing
 * matches, returns null — at which point the pipeline reports honestly that no
 * sources were retrieved rather than inventing any.
 */

interface DemoCase {
  id: string;
  result: RetrievalResult;
  /** Terms that must appear for the case to be considered a match. */
  required: RegExp[];
  /** Any one of these strengthens the match. */
  supporting: RegExp[];
}

const CASES: DemoCase[] = [
  {
    id: 'cryptid-dna',
    result: CRYPTID_DNA_CASE,
    required: [/\bdna\b|\bgenom|\bsequenc|\bprimate\b|\bbigfoot\b|\bsasquatch\b/i],
    supporting: [/\blab(oratory|oratories|s)?\b/i, /\bverif/i, /\bindependent/i, /\bunknown\b/i, /\bsample\b/i],
  },
  {
    id: 'uap-alloy',
    result: UAP_ALLOY_CASE,
    required: [/\buap\b|\bufo\b|\balloy\b|\bfragment\b|\bnon-?terrestrial\b|\bmaterial\b/i],
    supporting: [/\bisotop/i, /\bmetal/i, /\bgovernment\b/i, /\bfiling\b|\bdocument\b/i, /\bcraft\b/i],
  },
];

export const DEMO_CASE_IDS = CASES.map((c) => c.id);

/** The demo case the landing page's "View Demo Case" button opens. */
export const FEATURED_DEMO_ID = 'cryptid-dna';

export function demoCaseById(id: string): RetrievalResult | null {
  return CASES.find((c) => c.id === id)?.result ?? null;
}

export function demoCaseClaim(id: string): string | null {
  switch (id) {
    case 'cryptid-dna':
      return 'A researcher claims a DNA sample from an unknown primate was independently verified by three laboratories.';
    case 'uap-alloy':
      return 'A metal fragment held in government custody was analysed by two independent laboratories, which found its composition to be ordinary.';
    default:
      return null;
  }
}

/** Matches only on a clear signal, so unrelated claims never pick up a demo corpus. */
function scoreCase(demo: DemoCase, text: string): number {
  if (!demo.required.every((p) => p.test(text))) return 0;
  return 1 + demo.supporting.filter((p) => p.test(text)).length;
}

export class FixtureAdapter implements SearchAdapter {
  readonly name = 'fixture-corpus';
  readonly mode = 'DEMONSTRATION' as const;

  isConfigured(): boolean {
    return true;
  }

  async retrieve(claim: string, rawInput: string): Promise<RetrievalResult | null> {
    const text = `${claim} ${rawInput}`;
    let best: { demo: DemoCase; score: number } | null = null;
    for (const demo of CASES) {
      const score = scoreCase(demo, text);
      // Two signals minimum: one keyword is not enough to claim a case matches.
      if (score >= 2 && (!best || score > best.score)) best = { demo, score };
    }
    return best ? best.demo.result : null;
  }
}
