import { describe, expect, it } from 'vitest';
import { parseClaimAnalysis } from '@/core/llm/parse';

const valid = {
  normalized: 'Three laboratories verified the sample.',
  assertions: ['Three laboratories verified the sample.'],
  category: 'Cryptid',
  epistemicStatus: 'CLAIM',
  entities: [{ name: 'Whitcombe Genomics', kind: 'institution', role: 'named laboratory' }],
};

describe('parseClaimAnalysis', () => {
  it('parses a well-formed response', () => {
    expect(parseClaimAnalysis(JSON.stringify(valid))?.normalized).toBe(valid.normalized);
  });

  it('tolerates fenced JSON and surrounding prose', () => {
    const wrapped = `Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\nHope that helps.`;
    expect(parseClaimAnalysis(wrapped)?.category).toBe('Cryptid');
  });

  it('rejects anything that is not parseable JSON', () => {
    expect(parseClaimAnalysis('I cannot help with that.')).toBeNull();
    expect(parseClaimAnalysis('')).toBeNull();
    expect(parseClaimAnalysis('[1,2,3]')).toBeNull();
  });

  it('rejects an unknown category or epistemic status rather than guessing', () => {
    expect(parseClaimAnalysis(JSON.stringify({ ...valid, category: 'Sports' }))).toBeNull();
    expect(parseClaimAnalysis(JSON.stringify({ ...valid, epistemicStatus: 'TRUE' }))).toBeNull();
  });

  it('rejects a response that upgrades the claim to FACT', () => {
    // Nothing may enter the pipeline already labelled a fact; evidence decides.
    expect(parseClaimAnalysis(JSON.stringify({ ...valid, epistemicStatus: 'FACT' }))).toBeNull();
  });

  it('rejects a missing or trivially short normalized claim', () => {
    expect(parseClaimAnalysis(JSON.stringify({ ...valid, normalized: 'no' }))).toBeNull();
    expect(parseClaimAnalysis(JSON.stringify({ ...valid, normalized: undefined }))).toBeNull();
  });

  it('falls back to the normalized claim when assertions are missing', () => {
    const result = parseClaimAnalysis(JSON.stringify({ ...valid, assertions: [] }));
    expect(result?.assertions).toEqual([valid.normalized]);
  });

  it('drops malformed entities instead of failing the whole response', () => {
    const result = parseClaimAnalysis(
      JSON.stringify({ ...valid, entities: [{ name: '' }, { name: 'Real Lab', kind: 'nonsense' }] }),
    );
    expect(result?.entities).toEqual([{ name: 'Real Lab', kind: 'organization', role: '' }]);
  });
});
