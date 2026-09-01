import type {
  Contradiction,
  EvidenceItem,
  EvidenceScore,
  InvestigationSummary,
  LineageAnalysis,
  MissingEvidenceItem,
  Source,
} from '@/core/types';

/**
 * Investigation synthesis.
 *
 * Written from the record only. No sensational wording, no verdict, and no
 * certainty the evidence does not carry — the summary describes the *state of
 * the evidence*, which is the thing ProofHound can actually speak to.
 */

export interface SynthesisInput {
  sources: Source[];
  evidence: EvidenceItem[];
  lineage: LineageAnalysis;
  contradictions: Contradiction[];
  missingEvidence: MissingEvidenceItem[];
  score: EvidenceScore;
}

const NOTHING_ON_RECORD = 'Nothing on the record.';

function describeItem(item: EvidenceItem | undefined, sources: Source[]): string {
  if (!item) return NOTHING_ON_RECORD;
  const source = sources.find((s) => s.id === item.sourceId);
  const outlet = source?.publisher ?? source?.title ?? 'an unidentified source';
  const kind = item.evidenceType.replace(/_/g, ' ');
  return `${item.summary} (${outlet} — ${item.directness} ${kind}, ${item.quality} quality, independence ${item.independence.toFixed(2)}).`;
}

/** Rank by how much weight an item actually carries, not by how loud it is. */
function weight(item: EvidenceItem): number {
  const directness = { direct: 1, indirect: 0.6, circumstantial: 0.35, hearsay: 0.15 }[item.directness];
  const quality = { strong: 1, moderate: 0.65, weak: 0.3, unusable: 0 }[item.quality];
  return directness * quality * item.independence;
}

export function synthesize(input: SynthesisInput): InvestigationSummary {
  const { sources, evidence, lineage, contradictions, missingEvidence, score } = input;

  const supporting = evidence.filter((e) => e.stance === 'supports').sort((a, b) => weight(b) - weight(a));
  const contradicting = evidence.filter((e) => e.stance === 'contradicts').sort((a, b) => weight(b) - weight(a));

  const supportingFamilies = new Set(
    supporting
      .map((e) => lineage.families.find((f) => f.memberSourceIds.includes(e.sourceId))?.id)
      .filter(Boolean),
  );

  const independenceAssessment =
    sources.length === 0
      ? 'No sources were retrieved, so independence cannot be assessed.'
      : `${sources.length} source${sources.length === 1 ? '' : 's'} resolve to ${lineage.independentFamilyCount} independent source famil${lineage.independentFamilyCount === 1 ? 'y' : 'ies'}; ${supportingFamilies.size} of those carr${supportingFamilies.size === 1 ? 'ies' : 'y'} supporting evidence.` +
        (lineage.circularCitationCount > 0
          ? ` ${lineage.circularCitationCount} famil${lineage.circularCitationCount === 1 ? 'y contains a citation loop' : 'ies contain citation loops'}, which inflates the apparent source count.`
          : '') +
        (lineage.families.some((f) => f.memberSourceIds.length >= 4)
          ? ' The largest family accounts for most of the visible coverage.'
          : '');

  const uncertainties: string[] = [];
  for (const gap of missingEvidence.filter((m) => m.impact === 'decisive').slice(0, 3)) {
    uncertainties.push(`${gap.title} — ${gap.why}`);
  }
  for (const contradiction of contradictions.filter((c) => c.severity !== 'minor').slice(0, 2)) {
    uncertainties.push(contradiction.summary);
  }
  const unverified = sources.filter((s) => s.verification !== 'VERIFIED').length;
  if (unverified > 0) {
    uncertainties.push(
      `${unverified} referenced source${unverified === 1 ? '' : 's'} could not be retrieved and read, so ${unverified === 1 ? 'its' : 'their'} content is taken on description.`,
    );
  }
  if (uncertainties.length === 0) uncertainties.push('No material uncertainty was identified in the retrieved record.');

  const bestNextStep =
    missingEvidence.find((m) => m.impact === 'decisive')?.howToObtain ??
    missingEvidence[0]?.howToObtain ??
    'Retrieve and read the primary sources directly rather than relying on reporting about them.';

  return {
    strongestSupport: describeItem(supporting[0], sources),
    strongestContradiction: describeItem(contradicting[0], sources),
    independenceAssessment,
    uncertainties: uncertainties.slice(0, 5),
    bestNextStep,
    bottomLine: buildBottomLine(score, lineage, supportingFamilies.size),
  };
}

function buildBottomLine(score: EvidenceScore, lineage: LineageAnalysis, supportingFamilies: number): string {
  if (lineage.totalSources === 0) {
    return 'No evidence was retrieved, so no assessment of evidence strength is possible. This is a statement about the search, not about the claim.';
  }
  const repetition =
    lineage.totalSources > lineage.independentFamilyCount
      ? `${lineage.totalSources} apparent sources reduce to ${lineage.independentFamilyCount} independent origin${lineage.independentFamilyCount === 1 ? '' : 's'}. `
      : '';
  const support =
    supportingFamilies === 0
      ? 'No independent origin currently supports the claim.'
      : supportingFamilies === 1
        ? 'Support rests on a single origin.'
        : `Support comes from ${supportingFamilies} separate origins.`;
  return `${repetition}${support} Evidence strength is ${score.value}/100 (${score.band.toLowerCase()}). This measures the strength of the available evidence, not the probability that the claim is true.`;
}
