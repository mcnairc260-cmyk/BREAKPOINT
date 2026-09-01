import type {
  Investigation,
  PipelineStageId,
  Source,
  StageRecord,
  TimelineEvent,
} from '@/core/types';
import type { LLMProvider } from '@/core/llm';
import type { RetrievalResult, RetrievedSource } from '@/core/research/types';
import { deterministicId, newInvestigationId } from '@/core/id';
import { selectLLMProvider } from '@/core/llm';
import { demoCaseById, demoCaseClaim, retrieveSources } from '@/core/research';
import { buildClaim } from '@/core/pipeline/claim';
import { extractEntities } from '@/core/pipeline/entities';
import { adjustReliability, baselineReliability, classifyPrimacy, classifySourceType } from '@/core/pipeline/classify-sources';
import { buildRelationships, resolveCitations } from '@/core/pipeline/citations';
import { analyzeLineage, applyLineage } from '@/core/pipeline/lineage';
import { buildEvidence } from '@/core/pipeline/evidence';
import { detectContradictions } from '@/core/pipeline/contradictions';
import { analyzeMissingEvidence } from '@/core/pipeline/missing-evidence';
import { orderTimeline } from '@/core/pipeline/timeline';
import { scoreEvidence } from '@/core/pipeline/scoring';
import { synthesize } from '@/core/pipeline/synthesis';

/**
 * The investigation pipeline.
 *
 * Each stage is a pure-ish function in its own module; this file only sequences
 * them and records what each one did. Stage records drive the progress display,
 * so the UI reports work that actually happened rather than a timer.
 */

export const STAGE_LABELS: Record<PipelineStageId, string> = {
  parse_claim: 'Parsing claim',
  extract_entities: 'Identifying entities',
  retrieve_sources: 'Finding sources',
  classify_sources: 'Classifying sources',
  extract_citations: 'Tracing citations',
  trace_lineage: 'Detecting source families',
  classify_evidence: 'Comparing evidence',
  detect_contradictions: 'Checking contradictions',
  build_timeline: 'Building timeline',
  score_evidence: 'Calculating evidence strength',
  synthesize: 'Writing summary',
};

class StageLog {
  private readonly records: StageRecord[] = [];

  constructor(private readonly onStage?: (record: StageRecord) => void) {}

  private push(record: StageRecord): void {
    this.records.push(record);
    this.onStage?.(record);
  }

  run<T>(id: PipelineStageId, fn: () => T, describe: (value: T) => string): T {
    const started = Date.now();
    try {
      const value = fn();
      this.push({
        id,
        label: STAGE_LABELS[id],
        state: 'done',
        detail: describe(value),
        durationMs: Date.now() - started,
      });
      return value;
    } catch (error) {
      this.push({
        id,
        label: STAGE_LABELS[id],
        state: 'failed',
        detail: error instanceof Error ? error.message : 'Stage failed.',
        durationMs: Date.now() - started,
      });
      throw error;
    }
  }

  async runAsync<T>(id: PipelineStageId, fn: () => Promise<T>, describe: (value: T) => string): Promise<T> {
    const started = Date.now();
    const value = await fn();
    this.push({
      id,
      label: STAGE_LABELS[id],
      state: 'done',
      detail: describe(value),
      durationMs: Date.now() - started,
    });
    return value;
  }

  skip(id: PipelineStageId, detail: string): void {
    this.push({ id, label: STAGE_LABELS[id], state: 'skipped', detail, durationMs: 0 });
  }

  all(): StageRecord[] {
    return [...this.records];
  }
}

/** Turn adapter output into fully classified `Source` records. */
function materializeSources(retrieved: RetrievedSource[], mode: RetrievalResult['mode'], adapter: string): Source[] {
  const retrievedAt = new Date().toISOString();
  return retrieved.map((raw) => {
    const sourceType = classifySourceType(raw.url, raw.sourceType);
    const verification = raw.verification;
    const retracted = raw.retracted ?? false;
    const anonymousAttribution = raw.anonymousAttribution ?? false;
    const baseline = raw.reliabilityOverride ?? baselineReliability(sourceType, raw.url);

    return {
      id: raw.id,
      url: raw.url,
      title: raw.title,
      publisher: raw.publisher,
      author: raw.author,
      publicationDate: raw.publicationDate,
      sourceType,
      // Set properly once lineage depth is known.
      primaryOrSecondary: 'unknown',
      reliabilityScore: adjustReliability(baseline, { retracted, anonymousAttribution, verification }),
      independenceGroup: null,
      parentSourceIds: [],
      citations: (raw.cites ?? []).map((c) => ({
        text: c.text,
        url: c.url ?? null,
        resolvedSourceId: c.sourceId ?? null,
      })),
      supportsClaim: raw.evidence.some((e) => e.stance === 'supports'),
      contradictsClaim: raw.evidence.some((e) => e.stance === 'contradicts'),
      verification,
      retracted,
      anonymousAttribution,
      notes: raw.notes ?? '',
      retrieval: { mode, adapter, retrievedAt },
    } satisfies Source;
  });
}

/** One timeline event per dated source, plus whatever the corpus described. */
function buildTimeline(
  sources: Source[],
  retrieval: RetrievalResult,
  originIds: Set<string>,
  investigationId: string,
): TimelineEvent[] {
  const fromSources = sources
    .filter((s) => s.publicationDate !== null)
    .map<TimelineEvent>((source) => {
      // A retracted source is not *published* as a correction — its publication
      // event is a publication. The withdrawal is its own later event.
      const kind: TimelineEvent['kind'] = originIds.has(source.id)
          ? 'origin'
          : source.contradictsClaim
            ? 'rebuttal'
            : source.sourceType === 'peer_reviewed' || source.sourceType === 'preprint'
              ? 'analysis'
              : source.sourceType === 'social_post' ||
                  source.sourceType === 'forum_thread' ||
                  source.sourceType === 'aggregator' ||
                  source.sourceType === 'video'
                ? 'amplification'
                : 'report';
      return {
        id: deterministicId('event', source.id),
        date: source.publicationDate,
        approximate: (source.publicationDate?.length ?? 0) < 10,
        // The publisher is already shown as the source chip under the event, and
        // many titles begin with it, so prefixing it again reads as a stutter.
        description: source.title,
        sourceIds: [source.id],
        confidence: source.verification === 'VERIFIED' ? 'HIGH' : 'LOW',
        kind,
      };
    });

  const fromCorpus = retrieval.events.map<TimelineEvent>((event, index) => ({
    ...event,
    id: deterministicId('event', investigationId, 'corpus', String(index)),
  }));

  return orderTimeline([...fromSources, ...fromCorpus]);
}

export interface RunOptions {
  llm?: LLMProvider;
  /** Force a specific demonstration corpus (the "View Demo Case" path). */
  demoId?: string;
  /**
   * Called as each stage finishes, so the UI can report work that actually
   * happened. There is no progress percentage because the pipeline has no way
   * to know one, and inventing it would be the same lie as inventing a source.
   */
  onStage?: (record: StageRecord) => void;
}

export async function runInvestigation(rawInput: string, options: RunOptions = {}): Promise<Investigation> {
  const investigationId = newInvestigationId();
  const createdAt = new Date().toISOString();
  const log = new StageLog(options.onStage);
  const llm = options.llm ?? selectLLMProvider();

  // 1. Claim -----------------------------------------------------------------
  const demoClaimText = options.demoId ? demoCaseClaim(options.demoId) : null;
  const input = demoClaimText ?? rawInput;
  let claim = log.run('parse_claim', () => buildClaim(input, investigationId), (c) => `Category ${c.category}; ${c.assertions.length} assertion${c.assertions.length === 1 ? '' : 's'}.`);

  let seededEntities: RetrievalResult['entities'] = [];
  let analysisEngine = llm.name;

  if (llm.name !== 'heuristic') {
    try {
      const refined = await llm.analyzeClaim({
        rawInput: input,
        draft: {
          normalized: claim.normalized,
          assertions: claim.assertions,
          category: claim.category,
          epistemicStatus: claim.epistemicStatus,
        },
      });
      if (refined) {
        claim = {
          ...claim,
          normalized: refined.normalized,
          assertions: refined.assertions,
          category: refined.category,
          epistemicStatus: refined.epistemicStatus,
        };
        seededEntities = refined.entities;
      } else {
        analysisEngine = `${llm.name} (fell back to rules)`;
      }
    } catch {
      analysisEngine = `${llm.name} (unavailable — rules engine used)`;
    }
  }

  // 2. Retrieval -------------------------------------------------------------
  const forced = options.demoId ? demoCaseById(options.demoId) : null;
  const retrieval = forced
    ? await log.runAsync('retrieve_sources', async () => forced, (r) => `${r.sources.length} sources from the ${options.demoId} demonstration corpus.`)
    : await log.runAsync(
        'retrieve_sources',
        async () => (await retrieveSources(claim.normalized, rawInput)).result,
        (r) => (r.sources.length === 0 ? 'No sources retrieved.' : `${r.sources.length} sources via ${r.adapter}.`),
      );

  if (retrieval.entities.length > 0) seededEntities = [...seededEntities, ...retrieval.entities];

  // 3. Classification --------------------------------------------------------
  const classified = log.run(
    'classify_sources',
    () => materializeSources(retrieval.sources, retrieval.mode, retrieval.adapter),
    (s) => (s.length === 0 ? 'Nothing to classify.' : `${new Set(s.map((x) => x.sourceType)).size} distinct source types.`),
  );

  // 4. Citations -------------------------------------------------------------
  const withCitations = log.run(
    'extract_citations',
    () =>
      resolveCitations(
        classified,
        retrieval.sources.filter((r) => r.independentOfParents).map((r) => r.id),
      ),
    (s) => {
      const links = s.reduce((n, x) => n + x.parentSourceIds.length, 0);
      return `${links} citation link${links === 1 ? '' : 's'} resolved.`;
    },
  );

  // 5. Lineage — Source DNA --------------------------------------------------
  const lineage = log.run(
    'trace_lineage',
    () => analyzeLineage(withCitations),
    (l) =>
      l.totalSources === 0
        ? 'No lineage to trace.'
        : `${l.totalSources} sources → ${l.independentFamilyCount} independent famil${l.independentFamilyCount === 1 ? 'y' : 'ies'}.`,
  );

  const sources = applyLineage(withCitations, lineage).map((source) => ({
    ...source,
    primaryOrSecondary: classifyPrimacy(source, lineage.depthBySourceId[source.id] ?? 0),
  }));

  // 6. Entities --------------------------------------------------------------
  const entities = log.run(
    'extract_entities',
    () => extractEntities(claim.normalized, sources, investigationId, seededEntities),
    (e) => `${e.length} entit${e.length === 1 ? 'y' : 'ies'}.`,
  );
  claim = { ...claim, entityIds: entities.map((e) => e.id) };

  // 7. Evidence --------------------------------------------------------------
  const evidence = log.run(
    'classify_evidence',
    () => buildEvidence(claim.id, sources, retrieval.sources, lineage),
    (items) => {
      const supports = items.filter((i) => i.stance === 'supports').length;
      const contradicts = items.filter((i) => i.stance === 'contradicts').length;
      return `${items.length} items — ${supports} supporting, ${contradicts} contradicting.`;
    },
  );

  // 8. Timeline --------------------------------------------------------------
  const originIds = new Set(lineage.families.map((f) => f.originSourceId));
  const timeline = log.run(
    'build_timeline',
    () => buildTimeline(sources, retrieval, originIds, investigationId),
    (t) => `${t.length} event${t.length === 1 ? '' : 's'}.`,
  );

  // 9. Contradictions --------------------------------------------------------
  const contradictions = log.run(
    'detect_contradictions',
    () => detectContradictions(sources, evidence, timeline, lineage),
    (c) => (c.length === 0 ? 'None detected.' : `${c.length} recorded.`),
  );

  const missingEvidence = analyzeMissingEvidence({ claim, sources, evidence, lineage, contradictions });

  // 10. Score ----------------------------------------------------------------
  const score = log.run(
    'score_evidence',
    () => scoreEvidence({ sources, evidence, lineage, contradictions, timeline, missingEvidence }),
    (s) => `${s.value}/100 — ${s.band}.`,
  );

  // 11. Synthesis ------------------------------------------------------------
  const summary = log.run(
    'synthesize',
    () => synthesize({ sources, evidence, lineage, contradictions, missingEvidence, score }),
    () => 'Summary written from the retrieved record.',
  );

  const relationships = buildRelationships(sources, claim.id, []);

  return {
    id: investigationId,
    createdAt,
    completedAt: new Date().toISOString(),
    status: 'complete',
    researchMode: retrieval.mode,
    researchModeNote: retrieval.note,
    analysisEngine,
    claim,
    entities,
    sources,
    evidence,
    relationships,
    lineage,
    contradictions,
    missingEvidence,
    timeline,
    score,
    summary,
    stages: log.all(),
    isDemonstration: retrieval.isDemonstration,
  };
}
