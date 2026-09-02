import { describe, expect, it } from 'vitest';
import { runInvestigation } from '@/core/pipeline';
import { HeuristicProvider } from '@/core/llm';
import type { LLMProvider } from '@/core/llm';

const heuristic = new HeuristicProvider();

describe('runInvestigation — demonstration corpora', () => {
  it('collapses the cryptid case from many apparent sources to few real origins', async () => {
    const investigation = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });

    expect(investigation.researchMode).toBe('DEMONSTRATION');
    expect(investigation.isDemonstration).toBe(true);
    expect(investigation.sources.length).toBeGreaterThanOrEqual(10);
    // The headline the product exists to deliver.
    expect(investigation.lineage.independentFamilyCount).toBe(3);
    expect(investigation.lineage.independentFamilyCount).toBeLessThan(investigation.sources.length);

    const largest = investigation.lineage.families[0];
    expect(largest?.memberSourceIds.length).toBeGreaterThanOrEqual(8);
    // The origin of the dominant family is the document nobody can obtain.
    expect(largest?.originSourceId).toBe('src_lab_report_4471');
    expect(investigation.sources.find((s) => s.id === 'src_lab_report_4471')?.verification).toBe('INACCESSIBLE');
  });

  it('finds the circular citation, the retraction and the impossible chronology', async () => {
    const investigation = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    const kinds = new Set(investigation.contradictions.map((c) => c.kind));

    expect(investigation.lineage.circularCitationCount).toBe(1);
    expect(kinds).toContain('retraction_or_correction');
    expect(kinds).toContain('timeline_inconsistency');
    expect(kinds).toContain('failed_replication');
    expect(kinds).toContain('source_disagreement');
  });

  it('does not report the same chronological problem once per affected source', async () => {
    const investigation = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    const timelineFindings = investigation.contradictions.filter((c) => c.kind === 'timeline_inconsistency');
    expect(timelineFindings.length).toBeLessThanOrEqual(4);
  });

  it('scores a refuted claim low and a well-evidenced one high', async () => {
    const refuted = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    const supported = await runInvestigation('', { demoId: 'uap-alloy', llm: heuristic });

    expect(refuted.score.value).toBeLessThan(25);
    expect(supported.score.value).toBeGreaterThan(60);
    expect(supported.score.band === 'STRONG' || supported.score.band === 'VERY STRONG').toBe(true);
    // ProofHound is not a debunking machine: given good evidence it says so.
    expect(supported.lineage.independentFamilyCount).toBeGreaterThan(1);
  });

  it('produces every workspace section from the same run', async () => {
    const investigation = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    expect(investigation.claim.normalized.length).toBeGreaterThan(20);
    expect(investigation.claim.category).toBe('Cryptid');
    expect(investigation.entities.length).toBeGreaterThan(0);
    expect(investigation.evidence.length).toBeGreaterThan(0);
    expect(investigation.relationships.length).toBeGreaterThan(0);
    expect(investigation.timeline.length).toBeGreaterThan(0);
    expect(investigation.missingEvidence.length).toBeGreaterThan(0);
    expect(investigation.summary.bestNextStep.length).toBeGreaterThan(20);
    expect(investigation.stages.every((s) => s.state === 'done')).toBe(true);
    expect(investigation.status).toBe('complete');
  });

  it('orders the timeline oldest first', async () => {
    const { timeline } = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    const dated = timeline.filter((e) => e.date !== null).map((e) => e.date as string);
    const sorted = [...dated].sort();
    expect(dated).toEqual(sorted);
  });

  it('never states the score as a probability of truth', async () => {
    const { summary } = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    expect(summary.bottomLine).toContain('not the probability that the claim is true');
  });

  it('only ever cites sources that are in the retrieved set', async () => {
    const investigation = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    const ids = new Set(investigation.sources.map((s) => s.id));
    for (const item of investigation.evidence) expect(ids.has(item.sourceId)).toBe(true);
    for (const contradiction of investigation.contradictions) {
      for (const id of contradiction.sourceIds) expect(ids.has(id)).toBe(true);
    }
    for (const event of investigation.timeline) {
      for (const id of event.sourceIds) expect(ids.has(id)).toBe(true);
    }
  });

  it('matches a demonstration corpus from a free-text claim, not only from the demo button', async () => {
    const investigation = await runInvestigation(
      'Is it true that an unknown primate DNA sample was independently verified by three laboratories?',
      { llm: heuristic },
    );
    expect(investigation.researchMode).toBe('DEMONSTRATION');
    expect(investigation.sources.length).toBeGreaterThan(0);
  });
});

describe('runInvestigation — nothing retrieved', () => {
  it('returns an honest empty record rather than inventing sources', async () => {
    const investigation = await runInvestigation(
      'The borough council approved a new cycle lane on Fenwick Street last Tuesday.',
      { llm: heuristic },
    );

    expect(investigation.researchMode).toBe('NONE');
    expect(investigation.sources).toEqual([]);
    expect(investigation.evidence).toEqual([]);
    expect(investigation.score.value).toBe(0);
    expect(investigation.researchModeNote).toMatch(/will not invent sources|no usable results/i);
    // The parts that do not need sources still do their job.
    expect(investigation.claim.normalized.length).toBeGreaterThan(10);
    expect(investigation.claim.category).toBe('Other');
    expect(investigation.missingEvidence.length).toBeGreaterThan(0);
    expect(investigation.summary.bottomLine).toContain('statement about the search');
  });
});

describe('runInvestigation — model provider isolation', () => {
  it('uses a provider result when it is well formed', async () => {
    const provider: LLMProvider = {
      name: 'stub',
      isConfigured: () => true,
      analyzeClaim: async () => ({
        normalized: 'Three laboratories verified an unknown primate sequence.',
        assertions: ['Three laboratories verified an unknown primate sequence.'],
        category: 'Cryptid',
        epistemicStatus: 'ALLEGATION',
        entities: [{ name: 'Whitcombe Genomics', kind: 'institution', role: 'named laboratory' }],
      }),
    };
    const investigation = await runInvestigation('unknown primate dna verified by labs', { llm: provider });
    expect(investigation.analysisEngine).toBe('stub');
    expect(investigation.claim.epistemicStatus).toBe('ALLEGATION');
    expect(investigation.entities.some((e) => e.name === 'Whitcombe Genomics')).toBe(true);
  });

  it('falls back to the rules engine when the provider throws, and says so', async () => {
    const provider: LLMProvider = {
      name: 'broken',
      isConfigured: () => true,
      analyzeClaim: async () => {
        throw new Error('502 Bad Gateway');
      },
    };
    const investigation = await runInvestigation('unknown primate dna verified by three labs', {
      llm: provider,
    });
    expect(investigation.analysisEngine).toContain('unavailable');
    expect(investigation.claim.normalized.length).toBeGreaterThan(10);
    expect(investigation.sources.length).toBeGreaterThan(0);
  });

  it('says when a provider declined to improve on the rules', async () => {
    const provider: LLMProvider = {
      name: 'quiet',
      isConfigured: () => true,
      analyzeClaim: async () => null,
    };
    const investigation = await runInvestigation('a claim about nothing in particular at all', {
      llm: provider,
    });
    expect(investigation.analysisEngine).toContain('fell back to rules');
  });
});

describe('runInvestigation — chronology findings are specific', () => {
  it('reports only genuine ancestry violations, not every downstream article', async () => {
    const investigation = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    const timelineFindings = investigation.contradictions.filter((c) => c.kind === 'timeline_inconsistency');

    // Two real problems: the origin document postdates everything citing it, and
    // the circular pair is out of order. A later withdrawal legitimately
    // postdates the articles that drew on the withdrawn piece, and must not be
    // reported as an inconsistency.
    expect(timelineFindings).toHaveLength(2);
    expect(timelineFindings.some((c) => c.detail.includes('Sample Analysis Report 4471'))).toBe(true);
    expect(timelineFindings.some((c) => c.detail.includes('withdraws its article'))).toBe(false);
  });

  it('does not describe more contradicting families than exist', async () => {
    const investigation = await runInvestigation('', { demoId: 'cryptid-dna', llm: heuristic });
    const disagreement = investigation.contradictions.find((c) => c.kind === 'source_disagreement');
    expect(disagreement?.summary).toContain(`Of ${investigation.lineage.independentFamilyCount} independent`);
  });
});
