import { describe, expect, it } from 'vitest';
import { buildRelationships, resolveCitations, unresolvedCitationCount } from '@/core/pipeline/citations';
import { makeSource } from '@/core/test-support';

describe('resolveCitations', () => {
  it('resolves a citation by URL, ignoring www and trailing slashes', () => {
    const [child] = resolveCitations([
      makeSource({
        id: 'child',
        citations: [{ text: 'see the original', url: 'https://www.origin.test/story/', resolvedSourceId: null }],
      }),
      makeSource({ id: 'origin', url: 'https://origin.test/story' }),
    ]);
    expect(child?.parentSourceIds).toEqual(['origin']);
    expect(child?.citations[0]?.resolvedSourceId).toBe('origin');
  });

  it('resolves a citation that names the publisher', () => {
    const [child] = resolveCitations([
      makeSource({
        id: 'child',
        citations: [{ text: 'as first reported by the Cascade Herald', url: null, resolvedSourceId: null }],
      }),
      makeSource({ id: 'herald', publisher: 'Cascade Herald' }),
    ]);
    expect(child?.parentSourceIds).toEqual(['herald']);
  });

  it('resolves a citation that quotes the headline', () => {
    const [child] = resolveCitations([
      makeSource({
        id: 'child',
        citations: [
          { text: 'Researcher says unknown primate confirmed by three labs', url: null, resolvedSourceId: null },
        ],
      }),
      makeSource({
        id: 'article',
        publisher: null,
        title: 'Researcher says unknown primate DNA confirmed by three labs',
      }),
    ]);
    expect(child?.parentSourceIds).toEqual(['article']);
  });

  it('keeps an unresolvable citation instead of dropping it', () => {
    const sources = resolveCitations([
      makeSource({
        id: 'only',
        citations: [{ text: 'an internal memo nobody has seen', url: null, resolvedSourceId: null }],
      }),
    ]);
    expect(sources[0]?.parentSourceIds).toEqual([]);
    expect(unresolvedCitationCount(sources)).toBe(1);
  });

  it('never makes a source its own parent', () => {
    const sources = resolveCitations([
      makeSource({ id: 'self', citations: [{ text: 'self', url: null, resolvedSourceId: 'self' }] }),
    ]);
    expect(sources[0]?.parentSourceIds).toEqual([]);
  });

  it('records a citation without derivation for a source declared independent', () => {
    const [replication] = resolveCitations(
      [
        makeSource({
          id: 'replication',
          citations: [{ text: 'the original study', url: null, resolvedSourceId: 'original' }],
        }),
        makeSource({ id: 'original' }),
      ],
      ['replication'],
    );
    // The citation is still recorded, so the map draws it...
    expect(replication?.citations[0]?.resolvedSourceId).toBe('original');
    // ...but it forms no derivation edge, so it starts its own source family.
    expect(replication?.parentSourceIds).toEqual([]);
  });
});

describe('buildRelationships', () => {
  it('labels an echo as REPEATS and a news derivation as DERIVED_FROM', () => {
    const relationships = buildRelationships(
      [
        makeSource({ id: 'origin' }),
        makeSource({ id: 'post', sourceType: 'social_post', parentSourceIds: ['origin'] }),
        makeSource({ id: 'news', sourceType: 'news_article', parentSourceIds: ['origin'] }),
      ],
      'claim_1',
      [],
    );
    expect(relationships.find((r) => r.fromId === 'post')?.kind).toBe('REPEATS');
    expect(relationships.find((r) => r.fromId === 'news')?.kind).toBe('DERIVED_FROM');
  });

  it('draws a CITES edge for a source that references without deriving', () => {
    const relationships = buildRelationships(
      [
        makeSource({ id: 'original' }),
        makeSource({
          id: 'replication',
          sourceType: 'peer_reviewed',
          citations: [{ text: 'original', url: null, resolvedSourceId: 'original' }],
        }),
      ],
      'claim_1',
      [],
    );
    const edge = relationships.find((r) => r.fromId === 'replication' && r.toId === 'original');
    expect(edge?.kind).toBe('CITES');
  });

  it('links stance to the claim node', () => {
    const relationships = buildRelationships(
      [makeSource({ id: 'a', contradictsClaim: true }), makeSource({ id: 'b', supportsClaim: true })],
      'claim_1',
      [],
    );
    expect(relationships.find((r) => r.fromId === 'a' && r.toId === 'claim_1')?.kind).toBe('CONTRADICTS');
    expect(relationships.find((r) => r.fromId === 'b' && r.toId === 'claim_1')?.kind).toBe('SUPPORTS');
  });

  it('drops an edge to a source that was never retrieved', () => {
    const relationships = buildRelationships([makeSource({ id: 'a', parentSourceIds: ['ghost'] })], 'claim_1', []);
    expect(relationships.filter((r) => r.toId === 'ghost')).toEqual([]);
  });
});
