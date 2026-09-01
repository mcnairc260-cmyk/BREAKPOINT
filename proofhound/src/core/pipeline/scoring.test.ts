import { describe, expect, it } from 'vitest';
import { bandFor, scoreEvidence, type ScoringInput } from '@/core/pipeline/scoring';
import { analyzeLineage } from '@/core/pipeline/lineage';
import { makeEvent, makeEvidence, makeSource } from '@/core/test-support';
import type { Contradiction, MissingEvidenceItem, Source } from '@/core/types';

function input(overrides: Partial<ScoringInput> = {}): ScoringInput {
  const sources: Source[] = overrides.sources ?? [];
  return {
    sources,
    evidence: [],
    lineage: analyzeLineage(sources),
    contradictions: [],
    timeline: [],
    missingEvidence: [],
    ...overrides,
  };
}

const contradiction = (over: Partial<Contradiction> = {}): Contradiction => ({
  id: 'c1',
  kind: 'contradictory_statement',
  summary: 's',
  detail: 'd',
  sourceIds: [],
  severity: 'material',
  ...over,
});

const gap = (over: Partial<MissingEvidenceItem> = {}): MissingEvidenceItem => ({
  id: 'g1',
  title: 't',
  why: 'w',
  impact: 'decisive',
  howToObtain: 'h',
  ...over,
});

describe('bandFor', () => {
  it('maps the score onto the published bands', () => {
    expect(bandFor(0)).toBe('INSUFFICIENT');
    expect(bandFor(19)).toBe('INSUFFICIENT');
    expect(bandFor(20)).toBe('WEAK');
    expect(bandFor(40)).toBe('MODERATE');
    expect(bandFor(62)).toBe('STRONG');
    expect(bandFor(82)).toBe('VERY STRONG');
    expect(bandFor(100)).toBe('VERY STRONG');
  });
});

describe('scoreEvidence', () => {
  it('scores an empty record at zero and says why', () => {
    const score = scoreEvidence(input());
    expect(score.value).toBe(0);
    expect(score.band).toBe('INSUFFICIENT');
    expect(score.explanation).toContain('No sources were retrieved');
    expect(score.penalties).toEqual([]);
  });

  it('always reports all seven components, even at zero', () => {
    const score = scoreEvidence(input());
    expect(score.components.map((c) => c.key)).toEqual([
      'primarySourceQuality',
      'independentCorroboration',
      'evidenceDirectness',
      'reproducibility',
      'documentation',
      'sourceCredibility',
      'timelineConsistency',
    ]);
    expect(score.components.reduce((sum, c) => sum + c.max, 0)).toBe(100);
  });

  it('gives no corroboration credit when every supporting source is one family', () => {
    const sources = [
      makeSource({ id: 'origin', sourceType: 'peer_reviewed' }),
      makeSource({ id: 'echo1', parentSourceIds: ['origin'] }),
      makeSource({ id: 'echo2', parentSourceIds: ['echo1'] }),
      makeSource({ id: 'echo3', parentSourceIds: ['echo2'] }),
    ];
    const lineage = analyzeLineage(sources);
    const score = scoreEvidence(
      input({
        sources,
        lineage,
        evidence: sources.map((s, i) =>
          makeEvidence({ id: `e${i}`, sourceId: s.id, stance: 'supports', independence: 1 }),
        ),
      }),
    );
    const corroboration = score.components.find((c) => c.key === 'independentCorroboration');
    expect(corroboration?.points).toBe(0);
    expect(corroboration?.rationale).toContain('single source family');
  });

  it('rewards genuinely separate origins over repetition', () => {
    const many = [makeSource({ id: 'a' }), makeSource({ id: 'b' }), makeSource({ id: 'c' })];
    const scoreMany = scoreEvidence(
      input({
        sources: many,
        lineage: analyzeLineage(many),
        evidence: many.map((s, i) => makeEvidence({ id: `e${i}`, sourceId: s.id, stance: 'supports' })),
      }),
    );
    const chain = [
      makeSource({ id: 'a' }),
      makeSource({ id: 'b', parentSourceIds: ['a'] }),
      makeSource({ id: 'c', parentSourceIds: ['b'] }),
    ];
    const scoreChain = scoreEvidence(
      input({
        sources: chain,
        lineage: analyzeLineage(chain),
        evidence: chain.map((s, i) => makeEvidence({ id: `e${i}`, sourceId: s.id, stance: 'supports' })),
      }),
    );
    const points = (s: typeof scoreMany): number =>
      s.components.find((c) => c.key === 'independentCorroboration')?.points ?? 0;
    expect(points(scoreMany)).toBeGreaterThan(points(scoreChain));
  });

  it('treats a first-hand source that only contradicts as not supporting the claim', () => {
    const sources = [makeSource({ id: 'paper', sourceType: 'peer_reviewed', primaryOrSecondary: 'primary' })];
    const score = scoreEvidence(
      input({
        sources,
        evidence: [makeEvidence({ id: 'e', sourceId: 'paper', stance: 'contradicts' })],
      }),
    );
    const component = score.components.find((c) => c.key === 'primarySourceQuality');
    expect(component?.points).toBe(0);
    expect(component?.rationale).toContain('contradict the claim');
  });

  it('collapses reproducibility when replication has failed', () => {
    const sources = [makeSource({ id: 'lab', sourceType: 'peer_reviewed' })];
    const score = scoreEvidence(
      input({
        sources,
        evidence: [
          makeEvidence({ id: 'e', sourceId: 'lab', evidenceType: 'laboratory_result', stance: 'supports' }),
        ],
        contradictions: [contradiction({ kind: 'failed_replication', severity: 'decisive' })],
      }),
    );
    const component = score.components.find((c) => c.key === 'reproducibility');
    expect(component?.points).toBeLessThan(2);
    expect(component?.rationale).toContain('failed');
  });

  it('penalises the structural pathologies it detects', () => {
    const sources = [
      makeSource({ id: 'a', anonymousAttribution: true, parentSourceIds: ['b'] }),
      makeSource({ id: 'b', retracted: true, parentSourceIds: ['a'] }),
      makeSource({ id: 'c', verification: 'INACCESSIBLE' }),
    ];
    const score = scoreEvidence(
      input({ sources, lineage: analyzeLineage(sources), contradictions: [contradiction()] }),
    );
    const keys = score.penalties.map((p) => p.key);
    expect(keys).toContain('contradictions');
    expect(keys).toContain('anonymousSourcing');
    expect(keys).toContain('circularCitation');
    expect(keys).toContain('retractions');
    expect(keys).toContain('inaccessibleReferences');
    expect(keys).toContain('missingPrimaryEvidence');
    expect(score.penalties.every((p) => p.points < 0)).toBe(true);
  });

  it('does not penalise a minor contradiction', () => {
    const sources = [makeSource({ id: 'a', primaryOrSecondary: 'primary' })];
    const score = scoreEvidence(
      input({ sources, contradictions: [contradiction({ severity: 'minor' })] }),
    );
    expect(score.penalties.map((p) => p.key)).not.toContain('contradictions');
  });

  it('never falls below zero or rises above one hundred', () => {
    const sources = Array.from({ length: 8 }, (_, i) =>
      makeSource({ id: `s${i}`, retracted: true, anonymousAttribution: true, verification: 'INACCESSIBLE' }),
    );
    const floor = scoreEvidence(
      input({
        sources,
        lineage: analyzeLineage(sources),
        contradictions: Array.from({ length: 12 }, (_, i) =>
          contradiction({ id: `c${i}`, severity: 'decisive' }),
        ),
        missingEvidence: [gap()],
      }),
    );
    expect(floor.value).toBeGreaterThanOrEqual(0);
    expect(floor.value).toBeLessThanOrEqual(100);
  });

  it('reports the arithmetic it used, so the number can be checked by hand', () => {
    const sources = [makeSource({ id: 'a', primaryOrSecondary: 'primary' })];
    const score = scoreEvidence(
      input({
        sources,
        evidence: [makeEvidence({ id: 'e', sourceId: 'a', stance: 'supports' })],
        timeline: [makeEvent({ id: 't', date: '2024-01-01' })],
      }),
    );
    const gross = score.components.reduce((sum, c) => sum + c.points, 0);
    const deductions = score.penalties.reduce((sum, p) => sum + p.points, 0);
    expect(score.value).toBe(Math.round(Math.max(0, Math.min(100, gross + deductions))));
  });

  it('docks timeline consistency when the chronology is impossible', () => {
    const sources = [makeSource({ id: 'a' })];
    const clean = scoreEvidence(input({ sources, timeline: [makeEvent({ id: 't', date: '2024-01-01' })] }));
    const conflicted = scoreEvidence(
      input({
        sources,
        timeline: [makeEvent({ id: 't', date: '2024-01-01' })],
        contradictions: [contradiction({ kind: 'timeline_inconsistency' })],
      }),
    );
    const points = (s: typeof clean): number =>
      s.components.find((c) => c.key === 'timelineConsistency')?.points ?? 0;
    expect(points(conflicted)).toBeLessThan(points(clean));
  });
});
