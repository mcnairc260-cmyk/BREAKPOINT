import type { EvidenceItem, Source, TimelineEvent } from '@/core/types';

/** Minimal, explicit fixtures for tests. Only the fields a test cares about are set. */
export function makeSource(overrides: Partial<Source> & { id: string }): Source {
  return {
    url: `https://example.test/${overrides.id}`,
    title: overrides.id,
    publisher: overrides.id,
    author: null,
    publicationDate: null,
    sourceType: 'news_article',
    primaryOrSecondary: 'secondary',
    reliabilityScore: 0.5,
    independenceGroup: null,
    parentSourceIds: [],
    citations: [],
    supportsClaim: false,
    contradictsClaim: false,
    verification: 'VERIFIED',
    retracted: false,
    anonymousAttribution: false,
    notes: '',
    retrieval: { mode: 'DEMONSTRATION', adapter: 'test', retrievedAt: '2024-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

export function makeEvidence(overrides: Partial<EvidenceItem> & { id: string; sourceId: string }): EvidenceItem {
  return {
    claimId: 'claim_test',
    evidenceType: 'secondhand_report',
    directness: 'hearsay',
    quality: 'weak',
    independence: 1,
    stance: 'supports',
    epistemicStatus: 'CLAIM',
    confidence: 'MODERATE',
    summary: 'summary',
    excerpt: null,
    ...overrides,
  };
}

export function makeEvent(overrides: Partial<TimelineEvent> & { id: string }): TimelineEvent {
  return {
    date: null,
    approximate: false,
    description: overrides.id,
    sourceIds: [],
    confidence: 'MODERATE',
    kind: 'report',
    ...overrides,
  };
}
