/**
 * ProofHound domain model.
 *
 * These types are the contract between the investigation pipeline, the storage
 * layer and the UI. They are deliberately provider-agnostic: nothing here knows
 * about a particular LLM vendor, search API or database.
 */

// ---------------------------------------------------------------------------
// Epistemic vocabulary
// ---------------------------------------------------------------------------

/**
 * The epistemic category of a statement. ProofHound never silently promotes a
 * statement from a weaker category to a stronger one — see `docs/EPISTEMICS.md`.
 */
export const EPISTEMIC_STATUSES = [
  'FACT',
  'CLAIM',
  'ALLEGATION',
  'INTERPRETATION',
  'SPECULATION',
  'UNVERIFIED_REPORT',
] as const;
export type EpistemicStatus = (typeof EPISTEMIC_STATUSES)[number];

/** Ordered weakest → strongest. Used to guard against category promotion. */
export const EPISTEMIC_RANK: Record<EpistemicStatus, number> = {
  SPECULATION: 0,
  UNVERIFIED_REPORT: 1,
  INTERPRETATION: 2,
  ALLEGATION: 3,
  CLAIM: 4,
  FACT: 5,
};

export const CONFIDENCE_LEVELS = ['LOW', 'MODERATE', 'HIGH'] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const CLAIM_CATEGORIES = [
  'UAP',
  'Cryptid',
  'Paranormal',
  'Science',
  'Conspiracy',
  'Viral Claim',
  'Other',
] as const;
export type ClaimCategory = (typeof CLAIM_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export const SOURCE_TYPES = [
  'news_article',
  'wire_service',
  'peer_reviewed',
  'preprint',
  'government_document',
  'court_record',
  'dataset',
  'book',
  'blog',
  'podcast',
  'video',
  'social_post',
  'forum_thread',
  'press_release',
  'eyewitness_statement',
  'aggregator',
  'unknown',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export type PrimaryOrSecondary = 'primary' | 'secondary' | 'tertiary' | 'unknown';

/** Whether a source could actually be retrieved and read. */
export type VerificationState = 'VERIFIED' | 'UNVERIFIED_SOURCE' | 'INACCESSIBLE';

export type Stance = 'supports' | 'contradicts' | 'neutral';

export interface Source {
  id: string;
  url: string | null;
  title: string;
  publisher: string | null;
  author: string | null;
  /** ISO-8601, possibly partial: `2019`, `2019-04` or `2019-04-11`. */
  publicationDate: string | null;
  sourceType: SourceType;
  primaryOrSecondary: PrimaryOrSecondary;
  /** 0–1. How much weight this outlet/document type earns before content is read. */
  reliabilityScore: number;
  /** Assigned by lineage analysis. Sources in the same family are not independent. */
  independenceGroup: string | null;
  /** Ids of sources this one demonstrably draws from. */
  parentSourceIds: string[];
  /** Raw citations extracted from the source body (may include unresolved ones). */
  citations: RawCitation[];
  supportsClaim: boolean;
  contradictsClaim: boolean;
  verification: VerificationState;
  /** True when the source retracted or materially corrected its account. */
  retracted: boolean;
  /** True when the source's central attribution is to an unnamed party. */
  anonymousAttribution: boolean;
  notes: string;
  /** Where this record came from. Never presented as live research when false. */
  retrieval: RetrievalProvenance;
}

export interface RawCitation {
  /** Text as it appeared in the source. */
  text: string;
  /** Resolved source id when the citation maps onto a retrieved source. */
  resolvedSourceId: string | null;
  url: string | null;
}

export interface RetrievalProvenance {
  mode: ResearchMode;
  /** Adapter that produced the record, e.g. `fixture-corpus`, `brave-search`. */
  adapter: string;
  retrievedAt: string;
}

export type ResearchMode = 'LIVE' | 'DEMONSTRATION' | 'NONE';

// ---------------------------------------------------------------------------
// Claim & entities
// ---------------------------------------------------------------------------

export const ENTITY_KINDS = [
  'person',
  'organization',
  'institution',
  'location',
  'publication',
  'artifact',
  'event',
  'dataset',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface Entity {
  id: string;
  name: string;
  kind: EntityKind;
  /** Free-text role in the claim, e.g. "laboratory said to have run the test". */
  role: string;
  mentionedInSourceIds: string[];
}

export interface Claim {
  id: string;
  /** Exactly what the user submitted. */
  rawInput: string;
  /** Single-sentence, checkable restatement. */
  normalized: string;
  /** The specific assertion(s) that would have to be true. */
  assertions: string[];
  category: ClaimCategory;
  epistemicStatus: EpistemicStatus;
  entityIds: string[];
  /** Dates the claim itself refers to. */
  referencedDates: string[];
  /** Set when the input was a URL rather than prose. */
  sourceUrl: string | null;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

export const EVIDENCE_TYPES = [
  'physical_evidence',
  'laboratory_result',
  'documentary_record',
  'photograph',
  'video',
  'audio',
  'eyewitness_testimony',
  'expert_opinion',
  'statistical_analysis',
  'secondhand_report',
  'absence_of_record',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** How close the evidence sits to the thing being claimed. */
export type Directness = 'direct' | 'indirect' | 'circumstantial' | 'hearsay';

export type QualityGrade = 'strong' | 'moderate' | 'weak' | 'unusable';

export interface EvidenceItem {
  id: string;
  claimId: string;
  sourceId: string;
  evidenceType: EvidenceType;
  directness: Directness;
  quality: QualityGrade;
  /** 0–1. Derived from lineage: 1 = an origin source, lower = derivative. */
  independence: number;
  stance: Stance;
  epistemicStatus: EpistemicStatus;
  confidence: ConfidenceLevel;
  summary: string;
  /** Verbatim excerpt when one was retrieved. Never invented. */
  excerpt: string | null;
}

// ---------------------------------------------------------------------------
// Lineage / Source DNA
// ---------------------------------------------------------------------------

export const CITATION_RELATIONS = [
  'CITES',
  'SUPPORTS',
  'CONTRADICTS',
  'REPEATS',
  'DERIVED_FROM',
  'AUTHORED_BY',
  'AFFILIATED_WITH',
  'TESTED_BY',
] as const;
export type CitationRelationKind = (typeof CITATION_RELATIONS)[number];

export interface CitationRelationship {
  id: string;
  fromId: string;
  toId: string;
  kind: CitationRelationKind;
  /** How confident the pipeline is that this link is real. */
  confidence: ConfidenceLevel;
  note: string;
}

export interface SourceFamily {
  id: string;
  /** Source id of the family's earliest traceable origin. */
  originSourceId: string;
  label: string;
  memberSourceIds: string[];
  /** Longest chain length from origin to a leaf, in hops. */
  depth: number;
  /** True when citations in this family form a loop (A→B→A). */
  circular: boolean;
  /** Does anything in this family provide direct evidence, or only repetition? */
  carriesDirectEvidence: boolean;
}

export interface LineageAnalysis {
  families: SourceFamily[];
  /** One entry per source: how far it sits from its family origin. */
  depthBySourceId: Record<string, number>;
  totalSources: number;
  independentFamilyCount: number;
  circularCitationCount: number;
  /** Sources with no traceable ancestry AND no first-hand material. */
  orphanSourceIds: string[];
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface ScoreComponent {
  key: ScoreComponentKey;
  label: string;
  points: number;
  max: number;
  rationale: string;
}

export type ScoreComponentKey =
  | 'primarySourceQuality'
  | 'independentCorroboration'
  | 'evidenceDirectness'
  | 'reproducibility'
  | 'documentation'
  | 'sourceCredibility'
  | 'timelineConsistency';

export type PenaltyKey =
  | 'contradictions'
  | 'anonymousSourcing'
  | 'circularCitation'
  | 'missingPrimaryEvidence'
  | 'retractions'
  | 'inaccessibleReferences';

export interface ScorePenalty {
  key: PenaltyKey;
  label: string;
  points: number;
  rationale: string;
}

export type EvidenceBand = 'INSUFFICIENT' | 'WEAK' | 'MODERATE' | 'STRONG' | 'VERY STRONG';

export interface EvidenceScore {
  /** 0–100. Strength of available evidence — NOT a probability the claim is true. */
  value: number;
  band: EvidenceBand;
  components: ScoreComponent[];
  penalties: ScorePenalty[];
  /** One-paragraph plain-language explanation shown under the score. */
  explanation: string;
}

// ---------------------------------------------------------------------------
// Contradictions, gaps, timeline
// ---------------------------------------------------------------------------

export const CONTRADICTION_KINDS = [
  'contradictory_statement',
  'timeline_inconsistency',
  'source_disagreement',
  'failed_replication',
  'missing_documentation',
  'retraction_or_correction',
] as const;
export type ContradictionKind = (typeof CONTRADICTION_KINDS)[number];

export interface Contradiction {
  id: string;
  kind: ContradictionKind;
  summary: string;
  detail: string;
  sourceIds: string[];
  severity: 'minor' | 'material' | 'decisive';
}

export const GAP_IMPACTS = ['decisive', 'high', 'moderate'] as const;
export type GapImpact = (typeof GAP_IMPACTS)[number];

export interface MissingEvidenceItem {
  id: string;
  title: string;
  why: string;
  impact: GapImpact;
  /** Concrete, checkable action that would close the gap. */
  howToObtain: string;
}

export interface TimelineEvent {
  id: string;
  /** ISO-8601, possibly partial. Null when the date is genuinely unknown. */
  date: string | null;
  /** Set when the source gives only an approximate date. */
  approximate: boolean;
  description: string;
  sourceIds: string[];
  confidence: ConfidenceLevel;
  kind: 'origin' | 'report' | 'analysis' | 'rebuttal' | 'amplification' | 'correction';
}

// ---------------------------------------------------------------------------
// Synthesis & investigation
// ---------------------------------------------------------------------------

export interface InvestigationSummary {
  strongestSupport: string;
  strongestContradiction: string;
  independenceAssessment: string;
  uncertainties: string[];
  bestNextStep: string;
  /** Restates the score in words. Never asserts truth or falsity. */
  bottomLine: string;
}

export const PIPELINE_STAGES = [
  'parse_claim',
  'extract_entities',
  'retrieve_sources',
  'classify_sources',
  'extract_citations',
  'trace_lineage',
  'classify_evidence',
  'detect_contradictions',
  'build_timeline',
  'score_evidence',
  'synthesize',
] as const;
export type PipelineStageId = (typeof PIPELINE_STAGES)[number];

export type StageState = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface StageRecord {
  id: PipelineStageId;
  label: string;
  state: StageState;
  detail: string;
  durationMs: number;
}

export type InvestigationStatus = 'queued' | 'running' | 'complete' | 'failed';

export interface Investigation {
  id: string;
  createdAt: string;
  completedAt: string | null;
  status: InvestigationStatus;
  /** How the evidence was obtained. Surfaced prominently in the UI. */
  researchMode: ResearchMode;
  /** Human-readable note about the research mode, e.g. why no live search ran. */
  researchModeNote: string;
  /** Which model provider answered, or `heuristic` when no key was configured. */
  analysisEngine: string;
  claim: Claim;
  entities: Entity[];
  sources: Source[];
  evidence: EvidenceItem[];
  relationships: CitationRelationship[];
  lineage: LineageAnalysis;
  contradictions: Contradiction[];
  missingEvidence: MissingEvidenceItem[];
  timeline: TimelineEvent[];
  score: EvidenceScore;
  summary: InvestigationSummary;
  stages: StageRecord[];
  /** True for the shipped demonstration cases. Drives the DEMONSTRATION banner. */
  isDemonstration: boolean;
}

/** Everything the pipeline needs to produce an investigation. */
export interface InvestigationRequest {
  input: string;
  /** Force a specific demo case (used by the "View Demo Case" CTA). */
  demoId?: string;
}
