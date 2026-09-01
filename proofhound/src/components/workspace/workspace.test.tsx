import { describe, expect, it, beforeAll, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { Investigation } from '@/core/types';
import { runInvestigation } from '@/core/pipeline';
import { HeuristicProvider } from '@/core/llm';
import { TooltipProvider } from '@/components/ui/primitives';
import { SourceDNA } from '@/components/workspace/source-dna';
import { EvidenceLedger } from '@/components/workspace/evidence-ledger';
import { EvidenceScorePanel } from '@/components/workspace/evidence-score';
import { ResearchBanner } from '@/components/workspace/research-banner';
import { Contradictions } from '@/components/workspace/findings';

let demo: Investigation;
let empty: Investigation;

beforeAll(async () => {
  demo = await runInvestigation('', { demoId: 'cryptid-dna', llm: new HeuristicProvider() });
  empty = await runInvestigation('The parish council repainted the bandstand in April.', {
    llm: new HeuristicProvider(),
  });
});

function renderIn(ui: React.ReactElement) {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('SourceDNA', () => {
  it('leads with the sources-to-families comparison', () => {
    renderIn(<SourceDNA investigation={demo} selectedSourceId={null} onSelectSource={() => {}} />);

    const sourcesStat = screen.getByText('Sources found').parentElement;
    const familiesStat = screen.getByText('Independent source families').parentElement;
    expect(within(sourcesStat as HTMLElement).getByText(String(demo.sources.length))).toBeInTheDocument();
    expect(
      within(familiesStat as HTMLElement).getByText(String(demo.lineage.independentFamilyCount)),
    ).toBeInTheDocument();
  });

  it('marks each family origin and flags the circular one', () => {
    renderIn(<SourceDNA investigation={demo} selectedSourceId={null} onSelectSource={() => {}} />);
    expect(screen.getAllByText('Origin')).toHaveLength(demo.lineage.independentFamilyCount);
    expect(screen.getAllByText('Circular citation').length).toBe(demo.lineage.circularCitationCount);
  });

  it('selects a source when its row is activated', () => {
    const onSelect = vi.fn();
    renderIn(<SourceDNA investigation={demo} selectedSourceId={null} onSelectSource={onSelect} />);
    fireEvent.click(screen.getAllByRole('button', { pressed: false })[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalled();
  });

  it('says plainly when there is no lineage to trace', () => {
    renderIn(<SourceDNA investigation={empty} selectedSourceId={null} onSelectSource={() => {}} />);
    expect(screen.getByText(/no sources were retrieved/i)).toBeInTheDocument();
  });
});

describe('EvidenceScorePanel', () => {
  it('labels the number as evidence strength, not a probability', () => {
    renderIn(<EvidenceScorePanel score={demo.score} />);
    expect(screen.getByText('Evidence strength')).toBeInTheDocument();
    expect(screen.getByText(String(demo.score.value))).toBeInTheDocument();
    expect(screen.getByText(demo.score.band)).toBeInTheDocument();
  });

  it('keeps the breakdown collapsed until asked, then shows every component', () => {
    renderIn(<EvidenceScorePanel score={demo.score} />);
    expect(screen.queryByText('Primary source quality')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /show how this score was reached/i }));
    for (const component of demo.score.components) {
      expect(screen.getByText(component.label)).toBeInTheDocument();
    }
    for (const penalty of demo.score.penalties) {
      expect(screen.getByText(penalty.label)).toBeInTheDocument();
    }
  });
});

describe('EvidenceLedger', () => {
  it('filters to contradicting evidence only', () => {
    renderIn(<EvidenceLedger investigation={demo} onSelectSource={() => {}} />);
    const before = screen.getByText(new RegExp(`${demo.evidence.length} items shown`));
    expect(before).toBeInTheDocument();

    fireEvent.click(within(screen.getByRole('group', { name: 'Stance' })).getByText('Contradicts'));

    const contradicting = demo.evidence.filter((e) => e.stance === 'contradicts').length;
    expect(screen.getByText(new RegExp(`${contradicting} of ${demo.evidence.length} items shown`))).toBeInTheDocument();
  });

  it('filters to origins only', () => {
    renderIn(<EvidenceLedger investigation={demo} onSelectSource={() => {}} />);
    fireEvent.click(within(screen.getByRole('group', { name: 'Independence' })).getByText('Origins only'));
    const origins = demo.evidence.filter((e) => e.independence >= 0.99).length;
    expect(screen.getByText(new RegExp(`${origins} of ${demo.evidence.length} items shown`))).toBeInTheDocument();
  });

  it('explains an empty ledger rather than showing a blank table', () => {
    renderIn(<EvidenceLedger investigation={empty} onSelectSource={() => {}} />);
    expect(screen.getByText(/no sources were retrieved/i)).toBeInTheDocument();
  });
});

describe('ResearchBanner', () => {
  it('labels demonstration data as demonstration data', () => {
    renderIn(<ResearchBanner investigation={demo} />);
    expect(screen.getByText('Demonstration data')).toBeInTheDocument();
    expect(screen.getByText(/fictional/i)).toBeInTheDocument();
  });

  it('states when nothing was retrieved', () => {
    renderIn(<ResearchBanner investigation={empty} />);
    expect(screen.getByText('No sources retrieved')).toBeInTheDocument();
  });

  it('names the analysis engine that ran', () => {
    renderIn(<ResearchBanner investigation={demo} />);
    expect(screen.getByText(/Analysis engine: heuristic/)).toBeInTheDocument();
  });
});

describe('Contradictions', () => {
  it('shows disconfirming evidence without hiding it behind a toggle', () => {
    renderIn(<Contradictions investigation={demo} onSelectSource={() => {}} />);
    expect(screen.getAllByText('decisive').length).toBeGreaterThan(0);
    expect(screen.getByText(demo.contradictions[0]?.summary ?? '')).toBeInTheDocument();
  });
});
