import { describe, expect, it } from 'vitest';
import {
  adjustReliability,
  baselineReliability,
  classifyPrimacy,
  classifySourceType,
  domainOf,
} from '@/core/pipeline/classify-sources';

describe('domainOf', () => {
  it('strips the www prefix and lower-cases', () => {
    expect(domainOf('https://WWW.Example.COM/path')).toBe('example.com');
  });

  it('returns null for a missing or malformed URL', () => {
    expect(domainOf(null)).toBeNull();
    expect(domainOf('not a url')).toBeNull();
  });
});

describe('classifySourceType', () => {
  it.each([
    ['https://www.reuters.com/world/story', 'wire_service'],
    ['https://www.nature.com/articles/s41586', 'peer_reviewed'],
    ['https://arxiv.org/abs/2401.00001', 'preprint'],
    ['https://oversight.house.gov/report', 'government_document'],
    ['https://www.youtube.com/watch?v=abc', 'video'],
    ['https://x.com/user/status/1', 'social_post'],
    ['https://www.reddit.com/r/x/comments/y', 'forum_thread'],
    ['https://someone.substack.com/p/post', 'blog'],
    ['https://zenodo.org/record/1', 'dataset'],
    ['https://www.bbc.co.uk/news/story', 'news_article'],
  ])('classifies %s as %s', (url, expected) => {
    expect(classifySourceType(url)).toBe(expected);
  });

  it('falls back to unknown rather than guessing', () => {
    expect(classifySourceType('https://some-unknown-host.example/page')).toBe('unknown');
    expect(classifySourceType(null)).toBe('unknown');
  });

  it('honours an explicit hint over the domain', () => {
    expect(classifySourceType('https://www.youtube.com/watch?v=a', 'podcast')).toBe('podcast');
    // An `unknown` hint is not a hint; the domain still wins.
    expect(classifySourceType('https://www.reuters.com/x', 'unknown')).toBe('wire_service');
  });
});

describe('baselineReliability', () => {
  it('rates a peer-reviewed journal above a forum thread', () => {
    expect(baselineReliability('peer_reviewed', null)).toBeGreaterThan(baselineReliability('forum_thread', null));
  });

  it('prefers the domain-specific prior when there is one', () => {
    expect(baselineReliability('news_article', 'https://www.reuters.com/x')).toBe(0.86);
  });
});

describe('classifyPrimacy', () => {
  it('keeps a document with its own first-hand material primary, whatever it cites', () => {
    expect(classifyPrimacy({ sourceType: 'peer_reviewed', parentSourceIds: ['a', 'b'] }, 3)).toBe('primary');
    expect(classifyPrimacy({ sourceType: 'court_record', parentSourceIds: ['a'] }, 1)).toBe('primary');
  });

  it('treats a rootless relay as primary and a derived one as secondary', () => {
    expect(classifyPrimacy({ sourceType: 'news_article', parentSourceIds: [] }, 0)).toBe('primary');
    expect(classifyPrimacy({ sourceType: 'news_article', parentSourceIds: ['a'] }, 1)).toBe('secondary');
  });

  it('calls a relay of a relay tertiary', () => {
    expect(classifyPrimacy({ sourceType: 'blog', parentSourceIds: ['a'] }, 2)).toBe('tertiary');
  });
});

describe('adjustReliability', () => {
  const clean = { retracted: false, anonymousAttribution: false, verification: 'VERIFIED' } as const;

  it('leaves a clean source alone', () => {
    expect(adjustReliability(0.8, clean)).toBe(0.8);
  });

  it('docks a retraction, anonymity and unverifiability, and never leaves the 0–1 range', () => {
    expect(adjustReliability(0.8, { ...clean, retracted: true })).toBeCloseTo(0.5, 5);
    expect(adjustReliability(0.8, { ...clean, anonymousAttribution: true })).toBeCloseTo(0.68, 5);
    expect(adjustReliability(0.8, { ...clean, verification: 'INACCESSIBLE' })).toBeCloseTo(0.45, 5);
    expect(
      adjustReliability(0.2, { retracted: true, anonymousAttribution: true, verification: 'INACCESSIBLE' }),
    ).toBe(0);
    expect(adjustReliability(1, clean)).toBe(1);
  });
});
