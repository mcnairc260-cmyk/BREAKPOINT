import type { LineageAnalysis, Source, SourceFamily } from '@/core/types';

/**
 * Source DNA — source-family detection.
 *
 * The product's core insight: a pile of apparent sources is often one source
 * wearing twelve hats. This module takes the citation graph produced by
 * citation extraction and answers "how many *independent* origins are there?"
 *
 * A **source family** is a weakly-connected component of the citation graph.
 * Every member of a family ultimately draws on the same origin, so a family
 * counts once, no matter how many members it has.
 */

/** Document kinds that can hold first-hand material rather than relay it. */
const DIRECT_EVIDENCE_TYPES = new Set<Source['sourceType']>([
  'peer_reviewed',
  'preprint',
  'government_document',
  'court_record',
  'dataset',
  'eyewitness_statement',
]);

/**
 * Independence weight for a source at a given distance from its family origin.
 *
 * Not 1/(1+depth): the drop from "the origin" to "someone repeating the origin"
 * is the big one, and every hop after that adds little new information.
 */
export function independenceForDepth(depth: number): number {
  if (depth <= 0) return 1;
  if (depth === 1) return 0.45;
  if (depth === 2) return 0.25;
  return 0.15;
}

interface Graph {
  ids: string[];
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
}

function buildGraph(sources: Source[]): Graph {
  const ids = sources.map((s) => s.id);
  const known = new Set(ids);
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const id of ids) {
    parents.set(id, []);
    children.set(id, []);
  }
  for (const source of sources) {
    for (const parentId of source.parentSourceIds) {
      // Dangling parent references are dropped rather than inventing a node.
      if (!known.has(parentId) || parentId === source.id) continue;
      parents.get(source.id)?.push(parentId);
      children.get(parentId)?.push(source.id);
    }
  }
  return { ids, parents, children };
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  constructor(ids: string[]) {
    for (const id of ids) this.parent.set(id, id);
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root) as string;
    let cursor = id;
    while (this.parent.get(cursor) !== root) {
      const next = this.parent.get(cursor) as string;
      this.parent.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** True when the directed citation graph contains a cycle among `members`. */
function hasCycle(members: string[], children: Map<string, string[]>): boolean {
  const scope = new Set(members);
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const current = state.get(id) ?? 0;
    if (current === 1) return true;
    if (current === 2) return false;
    state.set(id, 1);
    for (const child of children.get(id) ?? []) {
      if (scope.has(child) && visit(child)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return members.some((id) => visit(id));
}

/**
 * Pick the family's origin.
 *
 * Preference order: a root (no parents) that can hold first-hand material, then
 * any root, then — for a fully circular family with no root — the earliest-dated
 * member, so the family still has something to hang the lineage on.
 */
function chooseOrigin(members: string[], byId: Map<string, Source>, parents: Map<string, string[]>): string {
  const roots = members.filter((id) => (parents.get(id) ?? []).length === 0);
  const pool = roots.length > 0 ? roots : members;
  const sorted = [...pool].sort((a, b) => {
    const sa = byId.get(a);
    const sb = byId.get(b);
    const directA = sa && DIRECT_EVIDENCE_TYPES.has(sa.sourceType) ? 0 : 1;
    const directB = sb && DIRECT_EVIDENCE_TYPES.has(sb.sourceType) ? 0 : 1;
    if (directA !== directB) return directA - directB;
    const dateA = sa?.publicationDate ?? '9999';
    const dateB = sb?.publicationDate ?? '9999';
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    return a.localeCompare(b);
  });
  return sorted[0] as string;
}

/** Shortest number of citation hops from an origin to every member. */
function depthsFromOrigin(origin: string, members: string[], children: Map<string, string[]>): Map<string, number> {
  const scope = new Set(members);
  const depth = new Map<string, number>([[origin, 0]]);
  const queue: string[] = [origin];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const d = depth.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      if (!scope.has(child) || depth.has(child)) continue;
      depth.set(child, d + 1);
      queue.push(child);
    }
  }
  // Members not reachable downstream from the origin (e.g. a sibling root inside
  // a family merged by a shared descendant) still belong to the family. Treat
  // them as depth 0: they are their own origin, they simply are not independent
  // of the family as a whole.
  for (const id of members) if (!depth.has(id)) depth.set(id, 0);
  return depth;
}

function labelFor(source: Source | undefined, fallback: string): string {
  if (!source) return fallback;
  const base = source.publisher ?? source.title;
  return base.length > 48 ? `${base.slice(0, 45)}…` : base;
}

/**
 * Group sources into independent families and measure how far each source sits
 * from its family's origin.
 */
export function analyzeLineage(sources: Source[]): LineageAnalysis {
  if (sources.length === 0) {
    return {
      families: [],
      depthBySourceId: {},
      totalSources: 0,
      independentFamilyCount: 0,
      circularCitationCount: 0,
      orphanSourceIds: [],
    };
  }

  const graph = buildGraph(sources);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const dsu = new DisjointSet(graph.ids);
  for (const id of graph.ids) {
    for (const parentId of graph.parents.get(id) ?? []) dsu.union(id, parentId);
  }

  const grouped = new Map<string, string[]>();
  for (const id of graph.ids) {
    const root = dsu.find(id);
    const bucket = grouped.get(root);
    if (bucket) bucket.push(id);
    else grouped.set(root, [id]);
  }

  const families: SourceFamily[] = [];
  const depthBySourceId: Record<string, number> = {};
  let circularCitationCount = 0;

  const components = [...grouped.values()].sort((a, b) => b.length - a.length);
  for (const members of components) {
    const origin = chooseOrigin(members, byId, graph.parents);
    const depths = depthsFromOrigin(origin, members, graph.children);
    let maxDepth = 0;
    for (const id of members) {
      const d = depths.get(id) ?? 0;
      depthBySourceId[id] = d;
      if (d > maxDepth) maxDepth = d;
    }
    const circular = hasCycle(members, graph.children);
    if (circular) circularCitationCount += 1;

    families.push({
      id: `family_${origin}`,
      originSourceId: origin,
      label: labelFor(byId.get(origin), origin),
      memberSourceIds: [...members].sort(
        (a, b) => (depths.get(a) ?? 0) - (depths.get(b) ?? 0) || a.localeCompare(b),
      ),
      depth: maxDepth,
      circular,
      carriesDirectEvidence: members.some((id) => {
        const source = byId.get(id);
        return Boolean(source && DIRECT_EVIDENCE_TYPES.has(source.sourceType));
      }),
    });
  }

  // Two families can share a publisher — a journal that published both the
  // original study and an independent re-measurement. Identical labels in the
  // legend read as a bug, so disambiguate with the origin's own title.
  const labelCounts = new Map<string, number>();
  for (const family of families) labelCounts.set(family.label, (labelCounts.get(family.label) ?? 0) + 1);
  for (const family of families) {
    if ((labelCounts.get(family.label) ?? 0) < 2) continue;
    const origin = byId.get(family.originSourceId);
    if (origin) family.label = labelFor({ ...origin, publisher: null }, family.originSourceId);
  }

  // Order families largest-first so the dominant origin leads the UI.
  families.sort((a, b) => b.memberSourceIds.length - a.memberSourceIds.length || a.id.localeCompare(b.id));

  const orphanSourceIds = graph.ids.filter((id) => {
    const source = byId.get(id);
    if (!source) return false;
    const isolated =
      (graph.parents.get(id) ?? []).length === 0 && (graph.children.get(id) ?? []).length === 0;
    return isolated && !DIRECT_EVIDENCE_TYPES.has(source.sourceType);
  });

  return {
    families,
    depthBySourceId,
    totalSources: sources.length,
    independentFamilyCount: families.length,
    circularCitationCount,
    orphanSourceIds,
  };
}

/** Write the family id and independence-derived fields back onto each source. */
export function applyLineage(sources: Source[], lineage: LineageAnalysis): Source[] {
  const familyBySourceId = new Map<string, string>();
  for (const family of lineage.families) {
    for (const id of family.memberSourceIds) familyBySourceId.set(id, family.id);
  }
  return sources.map((source) => ({
    ...source,
    independenceGroup: familyBySourceId.get(source.id) ?? null,
  }));
}

/**
 * Transitive ancestors of every source, following derivation edges only.
 *
 * Cycles are handled: a source inside a citation loop ends up as its own
 * ancestor, which is exactly what a loop means.
 */
export function ancestorSets(sources: Source[]): Map<string, Set<string>> {
  const parents = new Map(sources.map((s) => [s.id, s.parentSourceIds.filter((id) => id !== s.id)]));
  const cache = new Map<string, Set<string>>();

  const resolve = (id: string, seen: Set<string>): Set<string> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const out = new Set<string>();
    for (const parentId of parents.get(id) ?? []) {
      if (!parents.has(parentId)) continue;
      out.add(parentId);
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      for (const grandparent of resolve(parentId, seen)) out.add(grandparent);
    }
    cache.set(id, out);
    return out;
  };

  const result = new Map<string, Set<string>>();
  for (const source of sources) result.set(source.id, resolve(source.id, new Set([source.id])));
  return result;
}

/** The ancestry chain from a source back to its family origin. */
export function ancestryChain(sourceId: string, sources: Source[]): string[] {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const chain: string[] = [sourceId];
  const seen = new Set<string>([sourceId]);
  let cursor = byId.get(sourceId);
  while (cursor && cursor.parentSourceIds.length > 0) {
    // Follow the first resolvable parent; branching ancestry is shown in the map.
    const nextId = cursor.parentSourceIds.find((id) => byId.has(id) && !seen.has(id));
    if (!nextId) break;
    chain.push(nextId);
    seen.add(nextId);
    cursor = byId.get(nextId);
  }
  return chain;
}
