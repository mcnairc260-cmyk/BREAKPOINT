import type { EvidenceItem, LineageAnalysis, Source } from '@/core/types';
import type { RetrievedSource } from '@/core/research/types';
import { deterministicId } from '@/core/id';
import { independenceForDepth } from '@/core/pipeline/lineage';

/**
 * Evidence classification.
 *
 * Each retrieved source contributes zero or more evidence items. The item's
 * *independence* is not a property of the source in isolation — it comes from
 * how far the source sits from its family origin, which is why this stage runs
 * after lineage.
 */

/** Evidence types that are only ever as good as the person relaying them. */
const RELAYED_TYPES = new Set(['secondhand_report', 'eyewitness_testimony', 'expert_opinion']);

export function buildEvidence(
  claimId: string,
  sources: Source[],
  retrieved: RetrievedSource[],
  lineage: LineageAnalysis,
): EvidenceItem[] {
  const seedsBySourceId = new Map(retrieved.map((r) => [r.id, r.evidence]));
  const items: EvidenceItem[] = [];

  for (const source of sources) {
    const seeds = seedsBySourceId.get(source.id) ?? [];
    const depth = lineage.depthBySourceId[source.id] ?? 0;
    const independence = independenceForDepth(depth);

    for (const [index, seed] of seeds.entries()) {
      items.push({
        id: deterministicId('ev', source.id, String(index)),
        claimId,
        sourceId: source.id,
        evidenceType: seed.evidenceType,
        directness: seed.directness,
        quality: downgradeForDistance(seed.quality, depth, seed.evidenceType),
        independence,
        stance: seed.stance,
        epistemicStatus: seed.epistemicStatus,
        confidence: confidenceFor(source, depth),
        summary: seed.summary,
        excerpt: seed.excerpt,
      });
    }
  }

  return items;
}

/**
 * A relayed account loses quality with every hop; a document does not — a PDF
 * quoted by a blog is still the same PDF, so long as we could verify it.
 */
function downgradeForDistance(
  quality: EvidenceItem['quality'],
  depth: number,
  type: EvidenceItem['evidenceType'],
): EvidenceItem['quality'] {
  if (depth === 0 || !RELAYED_TYPES.has(type)) return quality;
  const ladder: EvidenceItem['quality'][] = ['strong', 'moderate', 'weak', 'unusable'];
  const index = ladder.indexOf(quality);
  return ladder[Math.min(ladder.length - 1, index + Math.min(depth, 2))] ?? quality;
}

function confidenceFor(source: Source, depth: number): EvidenceItem['confidence'] {
  if (source.verification !== 'VERIFIED') return 'LOW';
  if (source.retracted) return 'LOW';
  if (depth === 0 && source.reliabilityScore >= 0.7) return 'HIGH';
  if (depth <= 1 && source.reliabilityScore >= 0.5) return 'MODERATE';
  return 'LOW';
}

/** Evidence grouped by the family it belongs to — the ledger's independence column. */
export function familyOfSource(sourceId: string, lineage: LineageAnalysis): string | null {
  return lineage.families.find((f) => f.memberSourceIds.includes(sourceId))?.id ?? null;
}
