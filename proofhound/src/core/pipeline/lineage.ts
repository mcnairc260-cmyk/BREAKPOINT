import type { LineageAnalysis, Source, SourceFamily } from '@/core/types';

/**
 * Source DNA — source-family detection.
 *
 * The product's core insight: a pile of apparent sources is often one source
 * wearing twelve hats. This module takes the citation graph produced by
 * citation extraction and answers "how many *independent* origins are there?"
 *
 * A **source family** is an origin plus everything that descends from it. Every
 * member of a family ultimately draws on that one origin, so a family counts
 * once, no matter how many members it has.
 *
 * A family is deliberately *not* a connected component of the citation graph.
 * One aggregator citing five independent studies makes those studies one
 * component, and reporting that as a single family would say five separate
 * origins corroborate nothing — the precise opposite of what happened.
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

/**
 * The nodes that lie on a citation cycle within `members`.
 *
 * Returns the participating nodes rather than a boolean because families are
 * split by origin below: a loop can straddle two families, and a per-family
 * boolean would miss it.
 */
function nodesOnCycles(members: string[], children: Map<string, string[]>): Set<string> {
  const scope = new Set(members);
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const onCycle = new Set<string>();

  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const child of children.get(id) ?? []) {
      if (!scope.has(child)) continue;
      const childState = state.get(child) ?? 0;
      if (childState === 1) {
        // Back edge: everything from `child` to the top of the stack is on a loop.
        const from = stack.lastIndexOf(child);
        if (from >= 0) for (const node of stack.slice(from)) onCycle.add(node);
      } else if (childState === 0) {
        visit(child);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of members) if ((state.get(id) ?? 0) === 0) visit(id);
  return onCycle;
}

/**
 * Ordering used wherever an origin has to be picked.
 *
 * Prefer a source that can hold first-hand material, then the earliest-dated,
 * then the id — so the choice is deterministic rather than input-order
 * dependent.
 */
function byOriginPreference(byId: Map<string, Source>) {
  return (a: string, b: string): number => {
    const sa = byId.get(a);
    const sb = byId.get(b);
    const directA = sa && DIRECT_EVIDENCE_TYPES.has(sa.sourceType) ? 0 : 1;
    const directB = sb && DIRECT_EVIDENCE_TYPES.has(sb.sourceType) ? 0 : 1;
    if (directA !== directB) return directA - directB;
    const dateA = sa?.publicationDate ?? '9999';
    const dateB = sb?.publicationDate ?? '9999';
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    return a.localeCompare(b);
  };
}

/**
 * Pick an origin for a set of members that has no root of its own — a fully
 * circular family. Falls back to the earliest-dated member so the family still
 * has something to hang its lineage on.
 */
function chooseOrigin(members: string[], byId: Map<string, Source>, parents: Map<string, string[]>): string {
  const roots = members.filter((id) => (parents.get(id) ?? []).length === 0);
  const pool = roots.length > 0 ? roots : members;
  return [...pool].sort(byOriginPreference(byId))[0] as string;
}

/**
 * Shortest number of citation hops from `origin` to each member it can reach.
 *
 * Members the origin cannot reach are absent from the result rather than
 * defaulted to zero: not being downstream of an origin is what makes a source
 * an origin of its own, and silently filing it under someone else's lineage is
 * how independent sources disappear.
 */
function depthsFrom(origin: string, members: string[], children: Map<string, string[]>): Map<string, number> {
  const scope = new Set(members);
  if (!scope.has(origin)) return new Map();
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
    const onCycle = nodesOnCycles(members, graph.children);
    if (onCycle.size > 0) circularCitationCount += 1;

    // A component is not the same thing as an origin. Two genuinely independent
    // origins get pulled into one component the moment a single aggregator
    // cites both — and counting components would then report five independent
    // studies plus one roundup as "one source family, nothing corroborates
    // anything else", which is the exact opposite of the truth. So families are
    // built per origin, and each member is attached to the nearest one.
    const roots = members.filter((id) => (graph.parents.get(id) ?? []).length === 0);

    const assignment = new Map<string, { root: string; depth: number }>();
    // Roots are walked in preference order and a node is only reassigned to a
    // strictly closer root, so ties settle on the preferred origin and the
    // result does not depend on input ordering.
    for (const root of [...roots].sort(byOriginPreference(byId))) {
      for (const [id, depth] of depthsFrom(root, members, graph.children)) {
        const current = assignment.get(id);
        if (!current || depth < current.depth) assignment.set(id, { root, depth });
      }
    }

    // Anything a root cannot reach sits inside a loop that no origin feeds.
    // Those members still need a family, so they fall back to the earliest
    // datable member of what is left.
    const stranded = members.filter((id) => !assignment.has(id));
    if (stranded.length > 0) {
      const origin = chooseOrigin(stranded, byId, graph.parents);
      for (const [id, depth] of depthsFrom(origin, stranded, graph.children)) {
        if (!assignment.has(id)) assignment.set(id, { root: origin, depth });
      }
      for (const id of stranded) if (!assignment.has(id)) assignment.set(id, { root: origin, depth: 0 });
    }

    const byRoot = new Map<string, string[]>();
    for (const [id, { root, depth }] of assignment) {
      depthBySourceId[id] = depth;
      const bucket = byRoot.get(root);
      if (bucket) bucket.push(id);
      else byRoot.set(root, [id]);
    }

    for (const [origin, familyMembers] of byRoot) {
      families.push({
        id: `family_${origin}`,
        originSourceId: origin,
        label: labelFor(byId.get(origin), origin),
        memberSourceIds: [...familyMembers].sort(
          (a, b) => (depthBySourceId[a] ?? 0) - (depthBySourceId[b] ?? 0) || a.localeCompare(b),
        ),
        depth: familyMembers.reduce((max, id) => Math.max(max, depthBySourceId[id] ?? 0), 0),
        circular: familyMembers.some((id) => onCycle.has(id)),
        carriesDirectEvidence: familyMembers.some((id) => {
          const source = byId.get(id);
          return Boolean(source && DIRECT_EVIDENCE_TYPES.has(source.sourceType));
        }),
      });
    }
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
