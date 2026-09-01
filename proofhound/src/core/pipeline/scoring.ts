import type {
  Contradiction,
  EvidenceBand,
  EvidenceItem,
  EvidenceScore,
  LineageAnalysis,
  MissingEvidenceItem,
  ScoreComponent,
  ScorePenalty,
  Source,
  TimelineEvent,
} from '@/core/types';

/**
 * Evidence scoring.
 *
 * The number is EVIDENCE STRENGTH, not a probability that the claim is true. A
 * true claim with no surviving documentation scores low; a false claim backed by
 * a large, well-documented, independently replicated record would score high
 * before being overturned. Every component is derived from data on the
 * investigation and carries the sentence that explains it, so a user can open
 * the breakdown and see exactly where each point came from.
 */

const DIRECTNESS_WEIGHT = { direct: 1, indirect: 0.6, circumstantial: 0.35, hearsay: 0.15 } as const;
const QUALITY_WEIGHT = { strong: 1, moderate: 0.65, weak: 0.3, unusable: 0 } as const;

const DOCUMENTED_TYPES = new Set<EvidenceItem['evidenceType']>([
  'documentary_record',
  'laboratory_result',
  'photograph',
  'video',
  'audio',
  'statistical_analysis',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

export interface ScoringInput {
  sources: Source[];
  evidence: EvidenceItem[];
  lineage: LineageAnalysis;
  contradictions: Contradiction[];
  timeline: TimelineEvent[];
  missingEvidence: MissingEvidenceItem[];
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** 0–20. How good is the best first-hand material actually on the record? */
function primarySourceQuality(input: ScoringInput): ScoreComponent {
  const max = 20;
  const verifiedPrimaries = input.sources.filter(
    (s) => s.primaryOrSecondary === 'primary' && s.verification === 'VERIFIED',
  );
  // This component measures the primary material *behind the claim*. A first-hand
  // document that only contradicts it is real evidence, but it is not evidence
  // for the claim, so it is counted in the contradiction findings instead.
  const stancesBySource = new Map<string, Set<EvidenceItem['stance']>>();
  for (const item of input.evidence) {
    const set = stancesBySource.get(item.sourceId) ?? new Set<EvidenceItem['stance']>();
    set.add(item.stance);
    stancesBySource.set(item.sourceId, set);
  }
  const contradictingOnly = new Set<string>();
  for (const [sourceId, stances] of stancesBySource) {
    if (stances.has('contradicts') && !stances.has('supports') && !stances.has('neutral')) {
      contradictingOnly.add(sourceId);
    }
  }
  const primaries = verifiedPrimaries.filter((s) => !contradictingOnly.has(s.id));

  if (primaries.length === 0) {
    return {
      key: 'primarySourceQuality',
      label: 'Primary source quality',
      points: 0,
      max,
      rationale:
        verifiedPrimaries.length > 0
          ? `The only verified primary sources (${verifiedPrimaries.length}) contradict the claim rather than support it.`
          : 'No verified primary source is on the record — every retrieved source relays someone else.',
    };
  }
  const best = primaries.reduce((a, b) => (b.reliabilityScore > a.reliabilityScore ? b : a));
  const breadth = clamp(primaries.length / 3, 0, 1);
  const points = round(max * (0.7 * best.reliabilityScore + 0.3 * breadth));
  return {
    key: 'primarySourceQuality',
    label: 'Primary source quality',
    points,
    max,
    rationale: `${primaries.length} verified primary source${primaries.length === 1 ? '' : 's'}; strongest is ${best.publisher ?? best.title} (reliability ${best.reliabilityScore.toFixed(2)}).`,
  };
}

/**
 * 0–20. The Source DNA component: how many genuinely separate origins support
 * the claim, not how many articles exist.
 */
function independentCorroboration(input: ScoringInput): ScoreComponent {
  const max = 20;
  const supportingSourceIds = new Set(
    input.evidence.filter((e) => e.stance === 'supports').map((e) => e.sourceId),
  );
  const supportingFamilies = input.lineage.families.filter((f) =>
    f.memberSourceIds.some((id) => supportingSourceIds.has(id)),
  );
  const count = supportingFamilies.length;
  const withDirect = supportingFamilies.filter((f) => f.carriesDirectEvidence).length;

  // One family is not corroboration — it is a single origin, however many
  // articles repeat it — so `count === 1` scores zero here by construction.
  // After that, returns diminish: the second independent origin is worth far
  // more than the fifth.
  const breadth = count === 0 ? 0 : clamp(Math.log2(count) / Math.log2(4), 0, 1);
  const depthBonus = count === 0 ? 0 : clamp(withDirect / count, 0, 1);
  const points = round(max * breadth * (0.75 + 0.25 * depthBonus));

  const rationale =
    count === 0
      ? 'No source family provides supporting evidence.'
      : count === 1
        ? `All ${supportingSourceIds.size} supporting source${supportingSourceIds.size === 1 ? '' : 's'} belong to a single source family, so nothing here corroborates anything else.`
        : `${supportingSourceIds.size} supporting sources resolve to ${count} independent source families; ${withDirect} of those carr${withDirect === 1 ? 'ies' : 'y'} first-hand material.`;

  return { key: 'independentCorroboration', label: 'Independent corroboration', points, max, rationale };
}

/** 0–15. Weighted by independence, so hearsay repeated ten times stays hearsay. */
function evidenceDirectness(input: ScoringInput): ScoreComponent {
  const max = 15;
  const supporting = input.evidence.filter((e) => e.stance === 'supports');
  if (supporting.length === 0) {
    return {
      key: 'evidenceDirectness',
      label: 'Evidence directness',
      points: 0,
      max,
      rationale: 'No supporting evidence items were classified.',
    };
  }
  let weighted = 0;
  let weight = 0;
  for (const item of supporting) {
    const w = Math.max(item.independence, 0.1);
    // Quality gates directness: a blurry "direct" photograph is not strong evidence.
    weighted += DIRECTNESS_WEIGHT[item.directness] * QUALITY_WEIGHT[item.quality] * w;
    weight += w;
  }
  const ratio = weight === 0 ? 0 : weighted / weight;
  const directCount = supporting.filter((e) => e.directness === 'direct').length;
  return {
    key: 'evidenceDirectness',
    label: 'Evidence directness',
    points: round(max * ratio),
    max,
    rationale: `${directCount} of ${supporting.length} supporting items are direct evidence; the rest are indirect, circumstantial or second-hand.`,
  };
}

/** 0–15. Has anyone independently re-run, re-tested or re-measured the thing? */
function reproducibility(input: ScoringInput): ScoreComponent {
  const max = 15;
  const testable = input.evidence.filter(
    (e) => e.evidenceType === 'laboratory_result' || e.evidenceType === 'statistical_analysis',
  );
  if (testable.length === 0) {
    return {
      key: 'reproducibility',
      label: 'Reproducibility',
      points: 0,
      max,
      rationale: 'No testable result is on the record, so nothing can be replicated.',
    };
  }
  const familyBySourceId = new Map<string, string>();
  for (const family of input.lineage.families) {
    for (const id of family.memberSourceIds) familyBySourceId.set(id, family.id);
  }
  const supportingFamilies = new Set(
    testable.filter((e) => e.stance === 'supports').map((e) => familyBySourceId.get(e.sourceId) ?? e.sourceId),
  );
  const failed = input.contradictions.filter((c) => c.kind === 'failed_replication').length;

  if (failed > 0) {
    return {
      key: 'reproducibility',
      label: 'Reproducibility',
      points: round(max * 0.1),
      max,
      rationale: `${failed} documented replication attempt${failed === 1 ? '' : 's'} failed to reproduce the result.`,
    };
  }
  if (supportingFamilies.size <= 1) {
    return {
      key: 'reproducibility',
      label: 'Reproducibility',
      points: round(max * 0.25),
      max,
      rationale: 'The testable result exists, but only within a single source family — no independent replication.',
    };
  }
  const points = round(max * clamp(0.45 + 0.25 * (supportingFamilies.size - 1), 0, 1));
  return {
    key: 'reproducibility',
    label: 'Reproducibility',
    points,
    max,
    rationale: `Testable results appear in ${supportingFamilies.size} independent source families.`,
  };
}

/** 0–10. Is there a paper trail — provenance, chain of custody, raw material? */
function documentation(input: ScoringInput): ScoreComponent {
  const max = 10;
  const documented = input.evidence.filter((e) => DOCUMENTED_TYPES.has(e.evidenceType) && e.excerpt !== null);
  const withDocs = input.evidence.filter((e) => DOCUMENTED_TYPES.has(e.evidenceType));
  const missingDocGaps = input.missingEvidence.filter((m) => m.impact === 'decisive').length;

  if (withDocs.length === 0) {
    return {
      key: 'documentation',
      label: 'Documentation & provenance',
      points: 0,
      max,
      rationale: 'No documentary, imaging or laboratory material is available for inspection.',
    };
  }
  const base = clamp(withDocs.length / 4, 0, 1) * 0.7 + clamp(documented.length / 3, 0, 1) * 0.3;
  const points = round(clamp(max * base - missingDocGaps * 1.5, 0, max));
  return {
    key: 'documentation',
    label: 'Documentation & provenance',
    points,
    max,
    rationale: `${withDocs.length} documentary item${withDocs.length === 1 ? '' : 's'} on the record${missingDocGaps > 0 ? `, but ${missingDocGaps} decisive document${missingDocGaps === 1 ? ' is' : 's are'} still missing` : ''}.`,
  };
}

/** 0–10. Average reliability of the outlets carrying the claim, weighted by independence. */
function sourceCredibility(input: ScoringInput): ScoreComponent {
  const max = 10;
  if (input.sources.length === 0) {
    return {
      key: 'sourceCredibility',
      label: 'Source credibility',
      points: 0,
      max,
      rationale: 'No sources were retrieved.',
    };
  }
  const independenceBySourceId = new Map(input.evidence.map((e) => [e.sourceId, e.independence]));
  let weighted = 0;
  let weight = 0;
  for (const source of input.sources) {
    const w = Math.max(independenceBySourceId.get(source.id) ?? 0.3, 0.1);
    weighted += source.reliabilityScore * w;
    weight += w;
  }
  const ratio = weight === 0 ? 0 : weighted / weight;
  return {
    key: 'sourceCredibility',
    label: 'Source credibility',
    points: round(max * ratio),
    max,
    rationale: `Independence-weighted mean outlet reliability across ${input.sources.length} sources is ${ratio.toFixed(2)}.`,
  };
}

/** 0–10. Do the dated events line up, or does the story contradict its own chronology? */
function timelineConsistency(input: ScoringInput): ScoreComponent {
  const max = 10;
  const dated = input.timeline.filter((e) => e.date !== null);
  const inconsistencies = input.contradictions.filter((c) => c.kind === 'timeline_inconsistency').length;
  if (dated.length === 0) {
    return {
      key: 'timelineConsistency',
      label: 'Timeline consistency',
      points: 0,
      max,
      rationale: 'No dated events could be established, so the chronology cannot be checked.',
    };
  }
  const coverage = clamp(dated.length / Math.max(1, input.timeline.length), 0, 1);
  const points = round(clamp(max * coverage - inconsistencies * 3.5, 0, max));
  return {
    key: 'timelineConsistency',
    label: 'Timeline consistency',
    points,
    max,
    rationale:
      inconsistencies > 0
        ? `${dated.length} dated events, but ${inconsistencies} chronological inconsistenc${inconsistencies === 1 ? 'y' : 'ies'} between sources.`
        : `${dated.length} of ${input.timeline.length} events are dated and mutually consistent.`,
  };
}

// ---------------------------------------------------------------------------
// Penalties
// ---------------------------------------------------------------------------

function penalties(input: ScoringInput): ScorePenalty[] {
  const out: ScorePenalty[] = [];

  const material = input.contradictions.filter((c) => c.severity !== 'minor');
  if (material.length > 0) {
    const decisive = material.filter((c) => c.severity === 'decisive').length;
    out.push({
      key: 'contradictions',
      label: 'Contradictions',
      // Kept modest on purpose: contradictions already suppress corroboration,
      // directness and reproducibility above, and they have their own panel in
      // the UI. A large penalty here would be counting the same fact three times.
      points: -round(clamp(material.length + decisive * 1.5, 0, 8)),
      rationale: `${material.length} material contradiction${material.length === 1 ? '' : 's'}${decisive > 0 ? `, ${decisive} of them decisive` : ''}.`,
    });
  }

  const anonymous = input.sources.filter((s) => s.anonymousAttribution).length;
  if (anonymous > 0) {
    out.push({
      key: 'anonymousSourcing',
      label: 'Anonymous sourcing',
      points: -round(clamp(anonymous * 1.5, 0, 6)),
      rationale: `${anonymous} source${anonymous === 1 ? '' : 's'} rest${anonymous === 1 ? 's' : ''} on unnamed witnesses or officials.`,
    });
  }

  if (input.lineage.circularCitationCount > 0) {
    out.push({
      key: 'circularCitation',
      label: 'Circular citation',
      points: -round(clamp(input.lineage.circularCitationCount * 3, 0, 9)),
      rationale: `${input.lineage.circularCitationCount} source famil${input.lineage.circularCitationCount === 1 ? 'y cites itself in a loop' : 'ies cite themselves in loops'}, inflating the apparent source count.`,
    });
  }

  const hasVerifiedPrimary = input.sources.some(
    (s) => s.primaryOrSecondary === 'primary' && s.verification === 'VERIFIED',
  );
  if (!hasVerifiedPrimary && input.sources.length > 0) {
    out.push({
      key: 'missingPrimaryEvidence',
      label: 'No verified primary evidence',
      points: -8,
      rationale: 'Nothing first-hand could be verified; the entire record is relayed.',
    });
  }

  const retracted = input.sources.filter((s) => s.retracted).length;
  if (retracted > 0) {
    out.push({
      key: 'retractions',
      label: 'Retractions or corrections',
      points: -round(clamp(retracted * 3, 0, 9)),
      rationale: `${retracted} source${retracted === 1 ? ' has' : 's have'} been retracted or materially corrected.`,
    });
  }

  const unreachable = input.sources.filter(
    (s) => s.verification === 'INACCESSIBLE' || s.verification === 'UNVERIFIED_SOURCE',
  ).length;
  if (unreachable > 0) {
    out.push({
      key: 'inaccessibleReferences',
      label: 'Unverifiable references',
      points: -round(clamp(unreachable * 1.5, 0, 8)),
      rationale: `${unreachable} referenced source${unreachable === 1 ? '' : 's'} could not be retrieved and read.`,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Banding & explanation
// ---------------------------------------------------------------------------

export function bandFor(value: number): EvidenceBand {
  if (value < 20) return 'INSUFFICIENT';
  if (value < 40) return 'WEAK';
  if (value < 62) return 'MODERATE';
  if (value < 82) return 'STRONG';
  return 'VERY STRONG';
}

const BAND_OPENER: Record<EvidenceBand, string> = {
  INSUFFICIENT: 'Insufficient evidence.',
  WEAK: 'Weak evidence.',
  MODERATE: 'Moderate evidence.',
  STRONG: 'Strong evidence.',
  'VERY STRONG': 'Very strong evidence.',
};

function buildExplanation(value: number, input: ScoringInput): string {
  const band = bandFor(value);
  const sourceCount = input.sources.length;
  const familyCount = input.lineage.independentFamilyCount;
  const parts: string[] = [BAND_OPENER[band]];

  if (sourceCount === 0) {
    parts.push('No sources were retrieved, so there is nothing to weigh.');
    return parts.join(' ');
  }

  parts.push(
    `${sourceCount} source${sourceCount === 1 ? '' : 's'} reduce to ${familyCount} independent source famil${familyCount === 1 ? 'y' : 'ies'}.`,
  );

  const hasPrimary = input.sources.some(
    (s) => s.primaryOrSecondary === 'primary' && s.verification === 'VERIFIED',
  );
  parts.push(
    hasPrimary
      ? 'First-hand material is available for inspection.'
      : 'No first-hand material could be verified — the record is entirely relayed.',
  );

  const material = input.contradictions.filter((c) => c.severity !== 'minor').length;
  if (material > 0) {
    parts.push(`${material} material contradiction${material === 1 ? '' : 's'} remain${material === 1 ? 's' : ''} unresolved.`);
  }

  const decisiveGaps = input.missingEvidence.filter((m) => m.impact === 'decisive').length;
  if (decisiveGaps > 0) {
    parts.push(
      `${decisiveGaps} piece${decisiveGaps === 1 ? '' : 's'} of evidence that would settle the question ${decisiveGaps === 1 ? 'is' : 'are'} still missing.`,
    );
  }

  return parts.join(' ');
}

// ---------------------------------------------------------------------------

export function scoreEvidence(input: ScoringInput): EvidenceScore {
  const components: ScoreComponent[] = [
    primarySourceQuality(input),
    independentCorroboration(input),
    evidenceDirectness(input),
    reproducibility(input),
    documentation(input),
    sourceCredibility(input),
    timelineConsistency(input),
  ];
  const applied = penalties(input);
  const gross = components.reduce((sum, c) => sum + c.points, 0);
  const deductions = applied.reduce((sum, p) => sum + p.points, 0);
  const value = Math.round(clamp(gross + deductions, 0, 100));

  return {
    value,
    band: bandFor(value),
    components,
    penalties: applied,
    explanation: buildExplanation(value, input),
  };
}

export const SCORE_MAXIMA: Record<string, number> = {
  primarySourceQuality: 20,
  independentCorroboration: 20,
  evidenceDirectness: 15,
  reproducibility: 15,
  documentation: 10,
  sourceCredibility: 10,
  timelineConsistency: 10,
};
