import type { Contradiction, EvidenceItem, LineageAnalysis, Source, TimelineEvent } from '@/core/types';
import { deterministicId } from '@/core/id';
import { findTimelineConflicts } from '@/core/pipeline/timeline';
import { ancestorSets } from '@/core/pipeline/lineage';

/**
 * Contradiction detection.
 *
 * Negative evidence is never buried. Everything here is *derived* from the
 * record rather than authored alongside it, so a contradiction always points at
 * the sources that produced it.
 */

export function detectContradictions(
  sources: Source[],
  evidence: EvidenceItem[],
  timeline: TimelineEvent[],
  lineage: LineageAnalysis,
): Contradiction[] {
  const out: Contradiction[] = [];
  const byId = new Map(sources.map((s) => [s.id, s]));
  const familyOf = new Map<string, string>();
  for (const family of lineage.families) {
    for (const id of family.memberSourceIds) familyOf.set(id, family.id);
  }

  // 1. Direct contradictory statements, strongest first.
  const contradicting = evidence
    .filter((e) => e.stance === 'contradicts')
    .sort((a, b) => b.independence - a.independence);

  for (const item of contradicting) {
    const source = byId.get(item.sourceId);
    if (!source) continue;

    const isFailedReplication =
      item.evidenceType === 'laboratory_result' || item.evidenceType === 'statistical_analysis';

    out.push({
      id: deterministicId('contra', item.id),
      kind: isFailedReplication ? 'failed_replication' : 'contradictory_statement',
      summary: item.summary,
      detail: `${source.publisher ?? source.title}${source.publicationDate ? ` (${source.publicationDate})` : ''} — ${item.directness} ${item.evidenceType.replace(/_/g, ' ')}, independence ${item.independence.toFixed(2)}.`,
      sourceIds: [source.id],
      severity: severityFor(item, source),
    });
  }

  // 2. Two independent families flatly disagreeing is a different problem from
  //    one outlet dissenting, so it gets its own entry.
  const stanceByFamily = new Map<string, Set<EvidenceItem['stance']>>();
  for (const item of evidence) {
    const family = familyOf.get(item.sourceId);
    if (!family || item.stance === 'neutral') continue;
    const set = stanceByFamily.get(family) ?? new Set();
    set.add(item.stance);
    stanceByFamily.set(family, set);
  }
  const supportingFamilies = [...stanceByFamily].filter(([, s]) => s.has('supports')).map(([f]) => f);
  const contradictingFamilies = [...stanceByFamily].filter(([, s]) => s.has('contradicts')).map(([f]) => f);
  if (supportingFamilies.length > 0 && contradictingFamilies.length > 0) {
    const involved = [...new Set([...supportingFamilies, ...contradictingFamilies])]
      .flatMap((id) => lineage.families.find((f) => f.id === id)?.memberSourceIds ?? [])
      .slice(0, 8);
    out.push({
      id: deterministicId('contra', 'family-disagreement'),
      kind: 'source_disagreement',
      summary: `Of ${lineage.independentFamilyCount} independent source famil${lineage.independentFamilyCount === 1 ? 'y' : 'ies'}, ${supportingFamilies.length} carr${supportingFamilies.length === 1 ? 'ies' : 'y'} supporting evidence and ${contradictingFamilies.length} carr${contradictingFamilies.length === 1 ? 'ies' : 'y'} contradicting evidence.`,
      detail:
        'A family can do both, so these counts can overlap. What matters is that the disagreement is between separate origins rather than between an origin and its own repetitions, so it cannot be settled by counting articles.',
      sourceIds: involved,
      severity: contradictingFamilies.length >= supportingFamilies.length ? 'decisive' : 'material',
    });
  }

  // 3. Retractions and corrections.
  for (const source of sources.filter((s) => s.retracted)) {
    out.push({
      id: deterministicId('contra', 'retraction', source.id),
      kind: 'retraction_or_correction',
      summary: `${source.publisher ?? source.title} retracted or materially corrected its account.`,
      detail: source.notes || 'The outlet withdrew or amended the reporting that carried this claim.',
      sourceIds: [source.id],
      severity: 'material',
    });
  }

  // 4. Chronology that cannot be right. "Draws on" is decided by the citation
  //    graph, so a later family's origin never counts as out of order simply
  //    because an earlier family published first.
  const ancestors = ancestorSets(sources);

  /**
   * Only an event that *is* a source's publication can be an antecedent.
   *
   * Later events about a source — a withdrawal, a correction — legitimately
   * postdate everything downstream of it, and treating them as antecedents
   * reported every derivative article as "dated too early".
   */
  const isPublication = (event: TimelineEvent): boolean => {
    if (event.sourceIds.length !== 1) return false;
    const source = byId.get(event.sourceIds[0] as string);
    return Boolean(source && source.publicationDate === event.date);
  };

  const dependsOn = (dependent: TimelineEvent, antecedent: TimelineEvent): boolean => {
    if (!isPublication(dependent) || !isPublication(antecedent)) return false;
    const childId = dependent.sourceIds[0] as string;
    const parentId = antecedent.sourceIds[0] as string;
    return childId !== parentId && (ancestors.get(childId)?.has(parentId) ?? false);
  };

  for (const conflict of findTimelineConflicts(timeline, dependsOn)) {
    const affected = new Set([conflict.earlierId, conflict.laterId, ...conflict.alsoAffectedIds]);
    const involved = timeline.filter((e) => affected.has(e.id)).flatMap((e) => e.sourceIds);
    out.push({
      id: deterministicId('contra', 'timeline', conflict.earlierId, conflict.laterId),
      kind: 'timeline_inconsistency',
      summary: 'Dated events are in an order that cannot be right.',
      detail: conflict.detail,
      sourceIds: [...new Set(involved)],
      severity: 'material',
    });
  }

  // 5. A record with no first-hand material is a documentation failure, and it
  //    belongs in front of the user rather than only inside the score.
  const hasVerifiedPrimary = sources.some(
    (s) => s.primaryOrSecondary === 'primary' && s.verification === 'VERIFIED',
  );
  if (sources.length > 0 && !hasVerifiedPrimary) {
    out.push({
      id: deterministicId('contra', 'no-primary'),
      kind: 'missing_documentation',
      summary: 'No primary document, recording or dataset could be verified.',
      detail: `All ${sources.length} retrieved sources relay the account rather than presenting it. The claim currently rests on description alone.`,
      sourceIds: sources.slice(0, 6).map((s) => s.id),
      severity: 'material',
    });
  }

  const order = { decisive: 0, material: 1, minor: 2 } as const;
  return out.sort((a, b) => order[a.severity] - order[b.severity]);
}

function severityFor(item: EvidenceItem, source: Source): Contradiction['severity'] {
  if (item.directness === 'direct' && item.quality === 'strong' && source.verification === 'VERIFIED') {
    return 'decisive';
  }
  if (item.directness === 'hearsay' || item.quality === 'weak' || item.quality === 'unusable') return 'minor';
  return 'material';
}
