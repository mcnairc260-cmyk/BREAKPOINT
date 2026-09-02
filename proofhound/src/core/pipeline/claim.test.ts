import { describe, expect, it } from 'vitest';
import {
  buildClaim,
  categorizeClaim,
  classifyEpistemicStatus,
  extractReferencedDates,
  isUrlInput,
  normalizeClaimText,
  splitAssertions,
} from '@/core/pipeline/claim';

describe('normalizeClaimText', () => {
  it('strips question framing to leave the checkable assertion', () => {
    expect(normalizeClaimText('Is it true that the sample was verified by three labs?')).toBe(
      'The sample was verified by three labs?',
    );
  });

  it('strips a fact-check request prefix', () => {
    expect(normalizeClaimText('Please fact-check this: the alloy is not from Earth')).toBe(
      'The alloy is not from Earth.',
    );
  });

  it('strips stacked framing', () => {
    expect(normalizeClaimText('So I heard that the report was suppressed')).toBe('The report was suppressed.');
  });

  it('unwraps a fully quoted claim', () => {
    expect(normalizeClaimText('"Three laboratories confirmed the result"')).toBe(
      'Three laboratories confirmed the result.',
    );
  });

  it('collapses whitespace and terminates the sentence', () => {
    expect(normalizeClaimText('  the   lab   confirmed   it  ')).toBe('The lab confirmed it.');
  });

  it('leaves an already-clean claim alone', () => {
    const claim = 'A DNA sample was independently verified by three laboratories.';
    expect(normalizeClaimText(claim)).toBe(claim);
  });

  it('returns the input rather than an empty string when framing is all there is', () => {
    // Stripping the frame leaves nothing, so the original stands rather than
    // the pipeline inventing a claim.
    expect(normalizeClaimText('Fact-check this:')).toBe('Fact-check this:');
    expect(normalizeClaimText('   ')).toBe('');
  });
});

describe('categorizeClaim', () => {
  it.each([
    ['A Bigfoot hair sample was tested', 'Cryptid'],
    ['Navy pilots recorded a UAP off the coast', 'UAP'],
    ['The house is haunted by a poltergeist', 'Paranormal'],
    ['A peer-reviewed study found a new effect', 'Science'],
    ['The agency ran a secret program as a cover-up', 'Conspiracy'],
    ['This TikTok video went viral last week', 'Viral Claim'],
    ['The council approved the new bypass', 'Other'],
  ])('categorises %s as %s', (text, expected) => {
    expect(categorizeClaim(text)).toBe(expected);
  });

  it('prefers the more specific niche when several keywords appear', () => {
    // "DNA" would match Science, but the cryptid rule is more specific.
    expect(categorizeClaim('Unknown primate DNA was sequenced by researchers')).toBe('Cryptid');
  });
});

describe('classifyEpistemicStatus', () => {
  it.each([
    ['The witness alleged that the sample was swapped', 'ALLEGATION'],
    ['Unconfirmed reports say the lab was closed', 'UNVERIFIED_REPORT'],
    ['The fragment might be of unknown origin', 'SPECULATION'],
    ['The result indicates a new species', 'INTERPRETATION'],
    ['The laboratory ran the test on Tuesday', 'CLAIM'],
  ])('classifies %s as %s', (text, expected) => {
    expect(classifyEpistemicStatus(text)).toBe(expected);
  });

  it('never returns FACT from wording alone', () => {
    const inputs = ['It is a fact that the lab confirmed it', 'This is definitely true', 'Proven beyond doubt'];
    for (const input of inputs) expect(classifyEpistemicStatus(input)).not.toBe('FACT');
  });
});

describe('extractReferencedDates', () => {
  it('finds full, month-name and bare-year dates', () => {
    const dates = extractReferencedDates('Filed 2024-05-02, reported on 14 February 2024, first seen in 1998.');
    expect(dates).toContain('2024-05-02');
    expect(dates).toContain('14 February 2024');
    expect(dates).toContain('1998');
  });

  it('drops a bare year already covered by a fuller date', () => {
    expect(extractReferencedDates('Published 2024-05-02.')).toEqual(['2024-05-02']);
  });
});

describe('splitAssertions', () => {
  it('splits a conjunction into separately checkable assertions', () => {
    const parts = splitAssertions('The sample was collected in Oregon, and three laboratories confirmed it.');
    expect(parts).toHaveLength(2);
    expect(parts[1]).toMatch(/^Three laboratories/);
  });

  it('leaves a single assertion intact', () => {
    expect(splitAssertions('The lab confirmed the result.')).toEqual(['The lab confirmed the result.']);
  });

  it('does not split on a conjunction joining two short fragments', () => {
    expect(splitAssertions('It ran and it failed.')).toEqual(['It ran and it failed.']);
  });
});

describe('isUrlInput / buildClaim', () => {
  it('recognises a bare URL', () => {
    expect(isUrlInput('https://example.com/story')).toBe(true);
    expect(isUrlInput('Read https://example.com/story for more')).toBe(false);
  });

  it('keeps a URL verbatim and records it as the source', () => {
    const claim = buildClaim('https://example.com/story', 'inv1');
    expect(claim.sourceUrl).toBe('https://example.com/story');
    expect(claim.normalized).toBe('https://example.com/story');
  });

  it('derives stable ids from the investigation id', () => {
    expect(buildClaim('The lab confirmed it.', 'inv1').id).toBe(buildClaim('Something else.', 'inv1').id);
  });
});
