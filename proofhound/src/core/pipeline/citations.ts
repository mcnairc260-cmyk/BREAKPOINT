import type { CitationRelationship, ConfidenceLevel, Source } from '@/core/types';
import { deterministicId } from '@/core/id';

/**
 * Citation extraction.
 *
 * Turns the raw citations a source declares into resolved parent links, which
 * is what lineage analysis consumes. Two resolution routes:
 *
 *  1. **URL match** — the citation points at a URL we also retrieved.
 *  2. **Publisher/title match** — the citation names an outlet or headline that
 *     matches a retrieved source ("as first reported by the Cascade Herald").
 *
 * A citation that resolves to neither is kept, unresolved, so the UI can say
 * "this source cites something we could not retrieve" instead of dropping it.
 */

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.hostname.replace(/^www\./i, '').toLowerCase()}${path.toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

function tokenize(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/** Jaccard overlap between two token sets. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

const TITLE_MATCH_THRESHOLD = 0.6;

/**
 * Resolve each source's declared citations against the retrieved set and write
 * the resulting `parentSourceIds` back onto the sources.
 */
export function resolveCitations(sources: Source[], nonDerivativeIds: Iterable<string> = []): Source[] {
  const NON_DERIVATIVE = new Set(nonDerivativeIds);
  const byUrl = new Map<string, string>();
  const byPublisher = new Map<string, string[]>();
  const titleTokens = new Map<string, Set<string>>();

  for (const source of sources) {
    if (source.url) byUrl.set(normalizeUrl(source.url), source.id);
    if (source.publisher) {
      const key = source.publisher.toLowerCase();
      const bucket = byPublisher.get(key);
      if (bucket) bucket.push(source.id);
      else byPublisher.set(key, [source.id]);
    }
    titleTokens.set(source.id, tokenize(source.title));
  }

  return sources.map((source) => {
    const derives = !NON_DERIVATIVE.has(source.id);
    const parents = new Set(source.parentSourceIds);
    const citations = source.citations.map((citation) => {
      if (citation.resolvedSourceId) {
        if (citation.resolvedSourceId !== source.id) parents.add(citation.resolvedSourceId);
        return citation;
      }

      if (citation.url) {
        const hit = byUrl.get(normalizeUrl(citation.url));
        if (hit && hit !== source.id) {
          parents.add(hit);
          return { ...citation, resolvedSourceId: hit };
        }
      }

      const text = citation.text.toLowerCase();
      for (const [publisher, ids] of byPublisher) {
        if (!text.includes(publisher)) continue;
        const hit = ids.find((id) => id !== source.id);
        if (hit) {
          parents.add(hit);
          return { ...citation, resolvedSourceId: hit };
        }
      }

      const tokens = tokenize(citation.text);
      let best: { id: string; score: number } | null = null;
      for (const [id, candidate] of titleTokens) {
        if (id === source.id) continue;
        const score = overlap(tokens, candidate);
        if (score >= TITLE_MATCH_THRESHOLD && (!best || score > best.score)) best = { id, score };
      }
      if (best) {
        parents.add(best.id);
        return { ...citation, resolvedSourceId: best.id };
      }

      return citation;
    });

    parents.delete(source.id);
    // A citing-but-not-derived source keeps every resolved citation — the map
    // still draws the CITES edge — but contributes no derivation edge, so it
    // forms its own source family.
    return { ...source, citations, parentSourceIds: derives ? [...parents] : [] };
  });
}

/** Count of citations that pointed at something we could not retrieve. */
export function unresolvedCitationCount(sources: Source[]): number {
  return sources.reduce((sum, s) => sum + s.citations.filter((c) => c.resolvedSourceId === null).length, 0);
}

/**
 * Build the edge list for the evidence map.
 *
 * Edges come from three places: the resolved citation graph, each source's
 * stance on the claim, and authorship/affiliation links to entities.
 */
export function buildRelationships(
  sources: Source[],
  claimId: string,
  entityLinks: Array<{ entityId: string; sourceId: string; kind: 'AUTHORED_BY' | 'AFFILIATED_WITH' | 'TESTED_BY' }>,
): CitationRelationship[] {
  const relationships: CitationRelationship[] = [];
  const byId = new Map(sources.map((s) => [s.id, s]));

  for (const source of sources) {
    // A source that cites without deriving still gets its edges drawn — the map
    // must show the reference — but as CITES rather than DERIVED_FROM/REPEATS.
    if (source.parentSourceIds.length === 0) {
      for (const citation of source.citations) {
        const target = citation.resolvedSourceId ? byId.get(citation.resolvedSourceId) : undefined;
        if (!target || target.id === source.id) continue;
        relationships.push({
          id: deterministicId('rel', source.id, 'CITES', target.id),
          fromId: source.id,
          toId: target.id,
          kind: 'CITES',
          confidence: 'HIGH',
          note: `${source.publisher ?? source.title} references ${target.publisher ?? target.title} without drawing its findings from it.`,
        });
      }
    }
    for (const parentId of source.parentSourceIds) {
      const parent = byId.get(parentId);
      if (!parent) continue;
      // A source that adds nothing of its own is REPEATS; one that builds on the
      // parent is DERIVED_FROM; an academic-style reference is CITES.
      const kind =
        source.sourceType === 'social_post' || source.sourceType === 'forum_thread' || source.sourceType === 'aggregator'
          ? 'REPEATS'
          : source.sourceType === 'peer_reviewed' || source.sourceType === 'preprint'
            ? 'CITES'
            : 'DERIVED_FROM';
      const confidence: ConfidenceLevel = source.citations.some((c) => c.resolvedSourceId === parentId)
        ? 'HIGH'
        : 'MODERATE';
      relationships.push({
        id: deterministicId('rel', source.id, kind, parentId),
        fromId: source.id,
        toId: parentId,
        kind,
        confidence,
        note: `${source.publisher ?? source.title} draws on ${parent.publisher ?? parent.title}.`,
      });
    }

    if (source.supportsClaim || source.contradictsClaim) {
      const kind = source.contradictsClaim ? 'CONTRADICTS' : 'SUPPORTS';
      relationships.push({
        id: deterministicId('rel', source.id, kind, claimId),
        fromId: source.id,
        toId: claimId,
        kind,
        confidence: source.verification === 'VERIFIED' ? 'HIGH' : 'LOW',
        note: `${source.publisher ?? source.title} ${source.contradictsClaim ? 'contradicts' : 'supports'} the claim.`,
      });
    }
  }

  for (const link of entityLinks) {
    relationships.push({
      id: deterministicId('rel', link.sourceId, link.kind, link.entityId),
      fromId: link.sourceId,
      toId: link.entityId,
      kind: link.kind,
      confidence: 'MODERATE',
      note: '',
    });
  }

  return relationships;
}
