import type { PrimaryOrSecondary, Source, SourceType } from '@/core/types';

/**
 * Source classification.
 *
 * A source's *type* is structural (what kind of document is it) and drives a
 * baseline reliability. Baselines are priors, not verdicts: lineage, stance and
 * verification all adjust the weight a source ends up carrying.
 */

interface DomainRule {
  test: RegExp;
  type: SourceType;
  /** Baseline reliability, 0–1, before any content is read. */
  reliability: number;
}

const DOMAIN_RULES: DomainRule[] = [
  { test: /(^|\.)(reuters|apnews|afp)\.com$/i, type: 'wire_service', reliability: 0.86 },
  { test: /(^|\.)(nature|science|cell|thelancet|nejm|pnas)\.(com|org)$/i, type: 'peer_reviewed', reliability: 0.92 },
  { test: /(^|\.)(arxiv|biorxiv|medrxiv|ssrn)\.org$/i, type: 'preprint', reliability: 0.62 },
  { test: /(^|\.)(doi|pubmed\.ncbi\.nlm\.nih)\.(org|gov)$/i, type: 'peer_reviewed', reliability: 0.88 },
  { test: /\.gov(\.[a-z]{2})?$/i, type: 'government_document', reliability: 0.82 },
  { test: /(^|\.)courtlistener\.com$|\.uscourts\.gov$/i, type: 'court_record', reliability: 0.9 },
  { test: /(^|\.)(youtube|youtu|vimeo|rumble)\.(com|be)$/i, type: 'video', reliability: 0.4 },
  { test: /(^|\.)(x|twitter|tiktok|instagram|facebook|threads|bsky)\.(com|app|social)$/i, type: 'social_post', reliability: 0.22 },
  { test: /(^|\.)reddit\.com$/i, type: 'forum_thread', reliability: 0.2 },
  { test: /(^|\.)(substack|medium|wordpress|blogspot)\.com$/i, type: 'blog', reliability: 0.35 },
  { test: /(^|\.)(prnewswire|businesswire|globenewswire)\.com$/i, type: 'press_release', reliability: 0.4 },
  { test: /(^|\.)(kaggle|zenodo|figshare|data\.world)\.(com|org)$/i, type: 'dataset', reliability: 0.7 },
  { test: /(^|\.)(nytimes|washingtonpost|bbc|theguardian|wsj|ft|npr|economist)\.(com|co\.uk|org)$/i, type: 'news_article', reliability: 0.78 },
  { test: /(^|\.)(news|times|post|herald|tribune|gazette|observer)[a-z-]*\.(com|org|net|co\.uk)$/i, type: 'news_article', reliability: 0.55 },
];

const BASELINE_RELIABILITY: Record<SourceType, number> = {
  peer_reviewed: 0.9,
  court_record: 0.88,
  government_document: 0.8,
  wire_service: 0.84,
  dataset: 0.72,
  book: 0.6,
  preprint: 0.6,
  news_article: 0.6,
  press_release: 0.4,
  eyewitness_statement: 0.38,
  podcast: 0.32,
  video: 0.38,
  blog: 0.32,
  aggregator: 0.28,
  social_post: 0.22,
  forum_thread: 0.2,
  unknown: 0.25,
};

/** Document kinds that can carry first-hand material rather than repeat it. */
const INHERENTLY_PRIMARY: SourceType[] = [
  'peer_reviewed',
  'preprint',
  'government_document',
  'court_record',
  'dataset',
  'eyewitness_statement',
];

export function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Infer a source type from a URL. Returns `unknown` when the URL says nothing. */
export function classifySourceType(url: string | null, hint?: SourceType): SourceType {
  if (hint && hint !== 'unknown') return hint;
  const domain = domainOf(url);
  if (!domain) return 'unknown';
  for (const rule of DOMAIN_RULES) {
    if (rule.test.test(domain)) return rule.type;
  }
  return 'unknown';
}

export function baselineReliability(type: SourceType, url: string | null): number {
  const domain = domainOf(url);
  if (domain) {
    for (const rule of DOMAIN_RULES) {
      if (rule.test.test(domain)) return rule.reliability;
    }
  }
  return BASELINE_RELIABILITY[type];
}

/**
 * Primary means the source contains the material itself (the lab report, the
 * footage, the witness speaking). Anything that only relays another source is
 * secondary; a source that relays a relay is tertiary.
 */
export function classifyPrimacy(source: Pick<Source, 'sourceType' | 'parentSourceIds'>, depth: number): PrimaryOrSecondary {
  // A document that holds its own first-hand material stays primary however many
  // other things it happens to cite: a paper reporting its own laboratory work is
  // primary evidence for that work, whatever sits in its reference list.
  if (INHERENTLY_PRIMARY.includes(source.sourceType)) return 'primary';
  if (source.parentSourceIds.length === 0) return depth === 0 ? 'primary' : 'secondary';
  if (depth >= 2) return 'tertiary';
  return 'secondary';
}

/**
 * Adjust a baseline reliability for facts we learn later.
 *
 * Kept separate from the baseline so the UI can show both numbers and explain
 * the delta.
 */
export function adjustReliability(
  baseline: number,
  flags: { retracted: boolean; anonymousAttribution: boolean; verification: Source['verification'] },
): number {
  let value = baseline;
  if (flags.retracted) value -= 0.3;
  if (flags.anonymousAttribution) value -= 0.12;
  if (flags.verification === 'UNVERIFIED_SOURCE') value -= 0.2;
  if (flags.verification === 'INACCESSIBLE') value -= 0.35;
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
