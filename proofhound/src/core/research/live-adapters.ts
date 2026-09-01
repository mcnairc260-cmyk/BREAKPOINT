import type { RetrievalResult, RetrievedSource, SearchAdapter } from '@/core/research/types';
import { shortHash } from '@/core/id';

/**
 * Live web research.
 *
 * These adapters are real: given a key they issue a real query and return real
 * URLs. What they deliberately do **not** do is guess at stance, evidence type
 * or citation structure — a search result gives a title, a URL and a snippet,
 * and that is exactly what is recorded.
 *
 * Everything a live result cannot establish is marked as such: stance is
 * `neutral`, evidence is a `secondhand_report` of `unverifiable` provenance, and
 * verification is `UNVERIFIED_SOURCE` until the page itself has been fetched and
 * read. Downstream scoring then penalises exactly that uncertainty, which is the
 * honest outcome. Turning search hits into classified evidence is the next
 * milestone (see README, "Known limitations").
 */

const SEARCH_TIMEOUT_MS = 15_000;

interface RawHit {
  url: string;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  snippet: string | null;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Only the date part of an ISO timestamp; anything unparseable becomes null. */
function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 4) return null;
  const match = value.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
  if (!match) return null;
  const [, y, m, d] = match;
  if (y && m && d) return `${y}-${m}-${d}`;
  if (y && m) return `${y}-${m}`;
  return y ?? null;
}

function toSource(hit: RawHit, adapter: string): RetrievedSource {
  let publisher = hit.publisher;
  if (!publisher) {
    try {
      publisher = new URL(hit.url).hostname.replace(/^www\./i, '');
    } catch {
      publisher = null;
    }
  }
  return {
    id: `src_${shortHash(hit.url)}`,
    url: hit.url,
    title: hit.title,
    publisher,
    author: null,
    publicationDate: hit.publishedAt,
    // The page has not been fetched and read, so nothing about it is verified.
    verification: 'UNVERIFIED_SOURCE',
    notes: `Returned by ${adapter}. The page itself has not been retrieved, so its content, citations and stance are unassessed.`,
    evidence: [
      {
        evidenceType: 'secondhand_report',
        directness: 'hearsay',
        quality: 'weak',
        stance: 'neutral',
        epistemicStatus: 'UNVERIFIED_REPORT',
        summary: hit.snippet?.trim() || 'Search result; page content not yet retrieved.',
        excerpt: null,
      },
    ],
  };
}

function buildResult(adapter: string, hits: RawHit[]): RetrievalResult {
  return {
    mode: 'LIVE',
    adapter,
    note: `${hits.length} live search result${hits.length === 1 ? '' : 's'} from ${adapter}. Result pages have not yet been fetched and read, so stance, citations and source lineage are unassessed and every source is marked UNVERIFIED.`,
    sources: hits.map((hit) => toSource(hit, adapter)),
    entities: [],
    events: [],
    isDemonstration: false,
  };
}

export class BraveSearchAdapter implements SearchAdapter {
  readonly name = 'brave-search';
  readonly mode = 'LIVE' as const;

  constructor(private readonly apiKey = process.env.BRAVE_SEARCH_API_KEY) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async retrieve(claim: string): Promise<RetrievalResult | null> {
    if (!this.apiKey) return null;
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(claim)}&count=20`;
    const data = (await getJson(url, { accept: 'application/json', 'x-subscription-token': this.apiKey })) as {
      web?: { results?: Array<{ url?: string; title?: string; age?: string; page_age?: string; description?: string; profile?: { name?: string } }> };
    };
    const hits = (data.web?.results ?? [])
      .filter((r): r is { url: string; title: string } & typeof r => Boolean(r.url && r.title))
      .map<RawHit>((r) => ({
        url: r.url,
        title: r.title,
        publisher: r.profile?.name ?? null,
        publishedAt: isoDate(r.page_age ?? r.age),
        snippet: r.description ?? null,
      }));
    return hits.length > 0 ? buildResult(this.name, hits) : null;
  }
}

export class TavilySearchAdapter implements SearchAdapter {
  readonly name = 'tavily-search';
  readonly mode = 'LIVE' as const;

  constructor(private readonly apiKey = process.env.TAVILY_API_KEY) {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async retrieve(claim: string): Promise<RetrievalResult | null> {
    if (!this.apiKey) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ query: claim, max_results: 20, search_depth: 'advanced' }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const data = (await response.json()) as {
        results?: Array<{ url?: string; title?: string; content?: string; published_date?: string }>;
      };
      const hits = (data.results ?? [])
        .filter((r): r is { url: string; title: string } & typeof r => Boolean(r.url && r.title))
        .map<RawHit>((r) => ({
          url: r.url,
          title: r.title,
          publisher: null,
          publishedAt: isoDate(r.published_date),
          snippet: r.content ?? null,
        }));
      return hits.length > 0 ? buildResult(this.name, hits) : null;
    } finally {
      clearTimeout(timer);
    }
  }
}
