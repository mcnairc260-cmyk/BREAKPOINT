import { describe, expect, it } from 'vitest';
import { analyzeLineage, ancestorSets, ancestryChain, applyLineage, independenceForDepth } from '@/core/pipeline/lineage';
import { makeSource } from '@/core/test-support';

describe('independenceForDepth', () => {
  it('treats an origin as fully independent and drops sharply on the first hop', () => {
    expect(independenceForDepth(0)).toBe(1);
    expect(independenceForDepth(1)).toBe(0.45);
    expect(independenceForDepth(2)).toBe(0.25);
    // Every hop past the second adds nothing, so they share a floor.
    expect(independenceForDepth(3)).toBe(0.15);
    expect(independenceForDepth(9)).toBe(0.15);
  });
});

describe('analyzeLineage', () => {
  it('reports nothing for an empty source set', () => {
    const lineage = analyzeLineage([]);
    expect(lineage.independentFamilyCount).toBe(0);
    expect(lineage.families).toEqual([]);
    expect(lineage.totalSources).toBe(0);
  });

  it('collapses a chain of repeats into one family', () => {
    const sources = [
      makeSource({ id: 'origin' }),
      makeSource({ id: 'a', parentSourceIds: ['origin'] }),
      makeSource({ id: 'b', parentSourceIds: ['a'] }),
      makeSource({ id: 'c', parentSourceIds: ['b'] }),
    ];
    const lineage = analyzeLineage(sources);

    expect(lineage.totalSources).toBe(4);
    expect(lineage.independentFamilyCount).toBe(1);
    expect(lineage.families[0]?.originSourceId).toBe('origin');
    expect(lineage.depthBySourceId).toEqual({ origin: 0, a: 1, b: 2, c: 3 });
    expect(lineage.families[0]?.depth).toBe(3);
  });

  it('keeps unrelated sources in separate families', () => {
    const lineage = analyzeLineage([
      makeSource({ id: 'x' }),
      makeSource({ id: 'y', parentSourceIds: ['x'] }),
      makeSource({ id: 'p', sourceType: 'peer_reviewed' }),
      makeSource({ id: 'q', parentSourceIds: ['p'] }),
    ]);
    expect(lineage.independentFamilyCount).toBe(2);
    expect(lineage.families.map((f) => f.originSourceId).sort()).toEqual(['p', 'x']);
  });

  it('merges two roots that share a descendant, because the descendant is not a new origin', () => {
    const lineage = analyzeLineage([
      makeSource({ id: 'r1' }),
      makeSource({ id: 'r2' }),
      makeSource({ id: 'child', parentSourceIds: ['r1', 'r2'] }),
    ]);
    expect(lineage.independentFamilyCount).toBe(1);
    expect(lineage.families[0]?.memberSourceIds).toHaveLength(3);
  });

  it('detects a citation loop and still produces an origin', () => {
    const lineage = analyzeLineage([
      makeSource({ id: 'loop_a', parentSourceIds: ['loop_b'], publicationDate: '2024-01-01' }),
      makeSource({ id: 'loop_b', parentSourceIds: ['loop_a'], publicationDate: '2024-02-01' }),
    ]);
    expect(lineage.circularCitationCount).toBe(1);
    expect(lineage.families[0]?.circular).toBe(true);
    // With no root available, the earliest-dated member anchors the family.
    expect(lineage.families[0]?.originSourceId).toBe('loop_a');
  });

  it('prefers a root that can hold first-hand material as the origin', () => {
    const lineage = analyzeLineage([
      makeSource({ id: 'blog_root', sourceType: 'blog', publicationDate: '2020-01-01' }),
      makeSource({ id: 'paper_root', sourceType: 'peer_reviewed', publicationDate: '2023-01-01' }),
      makeSource({ id: 'child', parentSourceIds: ['blog_root', 'paper_root'] }),
    ]);
    expect(lineage.families[0]?.originSourceId).toBe('paper_root');
  });

  it('ignores a parent reference to a source that was never retrieved', () => {
    const lineage = analyzeLineage([makeSource({ id: 'only', parentSourceIds: ['ghost'] })]);
    expect(lineage.independentFamilyCount).toBe(1);
    expect(lineage.depthBySourceId).toEqual({ only: 0 });
  });

  it('flags an isolated source that carries no first-hand material as an orphan', () => {
    const lineage = analyzeLineage([
      makeSource({ id: 'lonely_blog', sourceType: 'blog' }),
      makeSource({ id: 'lonely_paper', sourceType: 'peer_reviewed' }),
    ]);
    expect(lineage.orphanSourceIds).toEqual(['lonely_blog']);
  });

  it('marks a family as repetition-only when nothing in it can hold first-hand material', () => {
    const lineage = analyzeLineage([
      makeSource({ id: 'agg', sourceType: 'aggregator' }),
      makeSource({ id: 'post', sourceType: 'social_post', parentSourceIds: ['agg'] }),
    ]);
    expect(lineage.families[0]?.carriesDirectEvidence).toBe(false);
  });
});

describe('applyLineage', () => {
  it('stamps every source with the family it belongs to', () => {
    const sources = [makeSource({ id: 'o' }), makeSource({ id: 'd', parentSourceIds: ['o'] })];
    const applied = applyLineage(sources, analyzeLineage(sources));
    expect(applied[0]?.independenceGroup).toBe('family_o');
    expect(applied[1]?.independenceGroup).toBe('family_o');
  });
});

describe('ancestorSets', () => {
  it('resolves transitive ancestry', () => {
    const sets = ancestorSets([
      makeSource({ id: 'a' }),
      makeSource({ id: 'b', parentSourceIds: ['a'] }),
      makeSource({ id: 'c', parentSourceIds: ['b'] }),
    ]);
    expect([...(sets.get('c') ?? [])].sort()).toEqual(['a', 'b']);
    expect(sets.get('a')?.size).toBe(0);
  });

  it('terminates on a cycle', () => {
    const sets = ancestorSets([
      makeSource({ id: 'a', parentSourceIds: ['b'] }),
      makeSource({ id: 'b', parentSourceIds: ['a'] }),
    ]);
    expect(sets.get('a')?.has('b')).toBe(true);
  });
});

describe('ancestryChain', () => {
  it('walks back to the origin without looping forever', () => {
    const sources = [
      makeSource({ id: 'root' }),
      makeSource({ id: 'mid', parentSourceIds: ['root'] }),
      makeSource({ id: 'leaf', parentSourceIds: ['mid'] }),
    ];
    expect(ancestryChain('leaf', sources)).toEqual(['leaf', 'mid', 'root']);
  });

  it('stops when ancestry is circular', () => {
    const sources = [
      makeSource({ id: 'a', parentSourceIds: ['b'] }),
      makeSource({ id: 'b', parentSourceIds: ['a'] }),
    ];
    expect(ancestryChain('a', sources)).toEqual(['a', 'b']);
  });
});

describe('family labels', () => {
  it('disambiguates two families that share a publisher', () => {
    const lineage = analyzeLineage([
      makeSource({ id: 'study', publisher: 'Journal of X', title: 'The original measurement' }),
      makeSource({ id: 'redo', publisher: 'Journal of X', title: 'An independent re-measurement' }),
    ]);
    const labels = lineage.families.map((f) => f.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels).toContain('The original measurement');
  });

  it('uses the publisher when it is unambiguous', () => {
    const lineage = analyzeLineage([makeSource({ id: 'a', publisher: 'Journal of X', title: 'Some title' })]);
    expect(lineage.families[0]?.label).toBe('Journal of X');
  });
});
