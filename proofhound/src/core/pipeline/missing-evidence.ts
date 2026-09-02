import type {
  Claim,
  Contradiction,
  EvidenceItem,
  LineageAnalysis,
  MissingEvidenceItem,
  Source,
} from '@/core/types';
import { deterministicId } from '@/core/id';

/**
 * Missing-evidence analysis — "what would materially strengthen this case?"
 *
 * Rules fire off the *shape* of the record, not off the topic, so the section
 * stays useful when ProofHound later covers scams, product claims or finance.
 * Category templates add domain-specific items on top.
 */

interface Rule {
  id: string;
  title: string;
  why: string;
  impact: MissingEvidenceItem['impact'];
  howToObtain: string;
  applies(ctx: GapContext): boolean;
}

export interface GapContext {
  claim: Claim;
  sources: Source[];
  evidence: EvidenceItem[];
  lineage: LineageAnalysis;
  contradictions: Contradiction[];
}

const has = (evidence: EvidenceItem[], type: EvidenceItem['evidenceType']): boolean =>
  evidence.some((e) => e.evidenceType === type);

const STRUCTURAL_RULES: Rule[] = [
  {
    id: 'primary-document',
    title: 'The original document, in full',
    why: 'Every retrieved source describes the material rather than presenting it, so nothing can be checked independently.',
    impact: 'decisive',
    howToObtain: 'Request the underlying report, filing or recording from the party that produced it, and publish it unedited.',
    applies: (ctx) =>
      ctx.sources.length > 0 &&
      !ctx.sources.some((s) => s.primaryOrSecondary === 'primary' && s.verification === 'VERIFIED'),
  },
  {
    id: 'independent-replication',
    title: 'Independent replication by an unaffiliated group',
    why: 'A testable result exists but has only been produced inside one source family, so the finding and its only check share an origin.',
    impact: 'decisive',
    howToObtain: 'Have a laboratory or team with no connection to the original run the same procedure on a split of the same material.',
    applies: (ctx) =>
      (has(ctx.evidence, 'laboratory_result') || has(ctx.evidence, 'statistical_analysis')) &&
      new Set(
        ctx.evidence
          .filter((e) => e.stance === 'supports')
          .map((e) => ctx.lineage.families.find((f) => f.memberSourceIds.includes(e.sourceId))?.id ?? e.sourceId),
      ).size <= 1,
  },
  {
    id: 'chain-of-custody',
    title: 'Chain-of-custody documentation',
    why: 'Physical or laboratory material is central to the claim, but there is no record of who held the sample and when.',
    impact: 'decisive',
    howToObtain: 'Obtain the collection log, transfer records and laboratory intake forms covering every handover.',
    applies: (ctx) => has(ctx.evidence, 'physical_evidence') || has(ctx.evidence, 'laboratory_result'),
  },
  {
    id: 'raw-data',
    title: 'Raw underlying data',
    why: 'Conclusions are reported without the measurements they rest on, so the analysis cannot be re-run.',
    impact: 'high',
    howToObtain: 'Ask for the raw readings, sequence files or spreadsheets, and a description of how they were processed.',
    applies: (ctx) => has(ctx.evidence, 'statistical_analysis') || has(ctx.evidence, 'laboratory_result'),
  },
  {
    id: 'unedited-original',
    title: 'The unedited original file, with metadata intact',
    why: 'Only re-encoded or cropped copies of the imagery are in circulation, which destroys the information needed to authenticate it.',
    impact: 'decisive',
    howToObtain: 'Get the camera-original file from the person who recorded it, with EXIF/container metadata unstripped.',
    applies: (ctx) => has(ctx.evidence, 'video') || has(ctx.evidence, 'photograph'),
  },
  {
    id: 'named-witnesses',
    title: 'Named, contactable witnesses',
    why: 'Central testimony is attributed to unnamed people, so it cannot be corroborated or challenged.',
    impact: 'high',
    howToObtain: 'Identify the witnesses on the record, or publish the reasoning for anonymity plus what was done to verify them.',
    applies: (ctx) => ctx.sources.some((s) => s.anonymousAttribution),
  },
  {
    id: 'contemporaneous-record',
    title: 'Contemporaneous documentation',
    why: 'The account was recorded well after the events it describes, leaving no record made at the time.',
    impact: 'high',
    howToObtain: 'Look for logs, dispatch records, messages or filings created on the day, from an office that keeps them routinely.',
    applies: (ctx) => ctx.sources.length > 0 && !ctx.sources.some((s) => s.sourceType === 'government_document' || s.sourceType === 'court_record'),
  },
  {
    id: 'second-origin',
    title: 'A second, genuinely independent origin',
    why: 'Every supporting source traces back to the same starting point, so the volume of coverage adds no new information.',
    impact: 'decisive',
    howToObtain: 'Find a witness, document or measurement that reached the same conclusion without contact with the original source.',
    applies: (ctx) => {
      const supportingFamilies = new Set(
        ctx.evidence
          .filter((e) => e.stance === 'supports')
          .map((e) => ctx.lineage.families.find((f) => f.memberSourceIds.includes(e.sourceId))?.id)
          .filter(Boolean),
      );
      return ctx.sources.length >= 3 && supportingFamilies.size <= 1;
    },
  },
  {
    id: 'response-from-named-party',
    title: 'An on-the-record response from the party named',
    why: 'Institutions named in the claim have not been shown to confirm or deny it.',
    impact: 'moderate',
    howToObtain: 'Put the specific assertion to the named institution in writing and publish the response, or the refusal to give one.',
    applies: (ctx) => ctx.claim.entityIds.length > 0,
  },
];

const CATEGORY_RULES: Partial<Record<Claim['category'], Rule[]>> = {
  UAP: [
    {
      id: 'sensor-data',
      title: 'Calibrated sensor data, not just video',
      why: 'Optical footage alone cannot establish size, distance or speed, which is where most UAP cases turn.',
      impact: 'decisive',
      howToObtain: 'Request radar tracks, infrared telemetry or range data with the sensor calibration record attached.',
      applies: () => true,
    },
  ],
  Cryptid: [
    {
      id: 'voucher-specimen',
      title: 'A voucher specimen or accessioned sample',
      why: 'A new animal is established by material a museum or herbarium holds and other researchers can re-examine.',
      impact: 'decisive',
      howToObtain: 'Deposit the physical material with an accredited collection and publish the accession number.',
      applies: () => true,
    },
    {
      id: 'contamination-controls',
      title: 'Contamination controls for the genetic work',
      why: 'Environmental DNA work returns spurious results without negative controls, and those controls are what reviewers check first.',
      impact: 'high',
      howToObtain: 'Publish the blanks, extraction controls and the full laboratory protocol alongside the result.',
      applies: (ctx) => has(ctx.evidence, 'laboratory_result'),
    },
  ],
  Paranormal: [
    {
      id: 'controlled-conditions',
      title: 'Observation under controlled conditions',
      why: 'Uncontrolled settings admit ordinary explanations that no amount of testimony can rule out afterwards.',
      impact: 'decisive',
      howToObtain: 'Repeat the observation with a pre-registered protocol and an independent observer present.',
      applies: () => true,
    },
  ],
  Conspiracy: [
    {
      id: 'document-provenance',
      title: 'Provenance for the leaked material',
      why: 'A document only carries weight once it is clear who produced it, how it was obtained and that it is unaltered.',
      impact: 'decisive',
      howToObtain: 'Establish the custody trail from source to publication, and have a forensic examination of the file itself.',
      applies: () => true,
    },
  ],
  Science: [
    {
      id: 'peer-review',
      title: 'Peer review, or the reviewers’ objections',
      why: 'The result has not been through the check designed to catch exactly this kind of error.',
      impact: 'high',
      howToObtain: 'Submit to a journal in the field, or publish the review reports if it was already rejected.',
      applies: (ctx) => !ctx.sources.some((s) => s.sourceType === 'peer_reviewed'),
    },
  ],
  'Viral Claim': [
    {
      id: 'earliest-upload',
      title: 'The earliest known upload of the material',
      why: 'Viral material is usually older than the post that spread it, and the original context often changes the meaning.',
      impact: 'high',
      howToObtain: 'Run a reverse-image or audio search back through re-uploads and record the earliest verifiable timestamp.',
      applies: () => true,
    },
  ],
};

const IMPACT_ORDER = { decisive: 0, high: 1, moderate: 2 } as const;

export function analyzeMissingEvidence(ctx: GapContext): MissingEvidenceItem[] {
  const rules = [...STRUCTURAL_RULES, ...(CATEGORY_RULES[ctx.claim.category] ?? [])];
  const items = rules
    .filter((rule) => {
      try {
        return rule.applies(ctx);
      } catch {
        return false;
      }
    })
    .map<MissingEvidenceItem>((rule) => ({
      id: deterministicId('gap', rule.id),
      title: rule.title,
      why: rule.why,
      impact: rule.impact,
      howToObtain: rule.howToObtain,
    }));

  return items.sort((a, b) => IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact] || a.title.localeCompare(b.title));
}
