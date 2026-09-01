import type {
  Directness,
  EntityKind,
  EpistemicStatus,
  EvidenceType,
  QualityGrade,
  ResearchMode,
  SourceType,
  Stance,
  TimelineEvent,
  VerificationState,
} from '@/core/types';

/**
 * The retrieval boundary.
 *
 * Everything upstream of this interface is "how do we find material about a
 * claim"; everything downstream is "what do we conclude from it". Swapping a
 * fixture corpus for a live search API changes only which adapter is selected.
 */

export interface EvidenceSeed {
  evidenceType: EvidenceType;
  directness: Directness;
  quality: QualityGrade;
  stance: Stance;
  epistemicStatus: EpistemicStatus;
  summary: string;
  /** Verbatim text from the source. Null when nothing was quotable. */
  excerpt: string | null;
}

/** A source as an adapter hands it over, before classification and lineage. */
export interface RetrievedSource {
  id: string;
  url: string | null;
  title: string;
  publisher: string | null;
  author: string | null;
  publicationDate: string | null;
  sourceType?: SourceType;
  /** Citations declared by the source, resolved or not. */
  cites?: Array<{ text: string; url?: string | null; sourceId?: string | null }>;
  /**
   * True when the source references other work without drawing its content from
   * it — a replication that cites the study it re-tests is *not* downstream of
   * it. Such a source keeps its citations (the map still draws them) but starts
   * its own source family.
   */
  independentOfParents?: boolean;
  verification: VerificationState;
  retracted?: boolean;
  anonymousAttribution?: boolean;
  notes?: string;
  evidence: EvidenceSeed[];
  /** Reliability override when the adapter knows better than the domain prior. */
  reliabilityOverride?: number;
}

export interface RetrievalResult {
  mode: ResearchMode;
  adapter: string;
  /** Shown to the user verbatim. Explains where this material came from. */
  note: string;
  sources: RetrievedSource[];
  entities: Array<{ name: string; kind: EntityKind; role: string }>;
  /** Events the sources describe that are not simply "source X published". */
  events: Array<Omit<TimelineEvent, 'id'>>;
  /** Set for shipped demonstration corpora. Drives the DEMONSTRATION badge. */
  isDemonstration: boolean;
  /** Present when the corpus is a curated demo case. */
  demoId?: string;
}

export interface SearchAdapter {
  readonly name: string;
  readonly mode: ResearchMode;
  /** True when the adapter has everything it needs (keys, network) to run. */
  isConfigured(): boolean;
  retrieve(claim: string, rawInput: string): Promise<RetrievalResult | null>;
}
