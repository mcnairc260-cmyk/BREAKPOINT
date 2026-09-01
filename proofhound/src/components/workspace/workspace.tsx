'use client';

import * as React from 'react';
import Link from 'next/link';
import type { Investigation } from '@/core/types';
import { Badge, Panel } from '@/components/ui/primitives';
import { Wordmark } from '@/components/landing/wordmark';
import { ResearchBanner } from '@/components/workspace/research-banner';
import { ClaimCard } from '@/components/workspace/claim-card';
import { EvidenceScorePanel } from '@/components/workspace/evidence-score';
import { SourceDNA } from '@/components/workspace/source-dna';
import { EvidenceMap } from '@/components/workspace/evidence-map';
import { EvidenceLedger } from '@/components/workspace/evidence-ledger';
import {
  Contradictions,
  InvestigationSummaryPanel,
  MissingEvidence,
  Timeline,
} from '@/components/workspace/findings';
import { SourceDetail } from '@/components/workspace/source-detail';
import { InvestigationTrace } from '@/components/workspace/trace';
import { useWideLayout } from '@/lib/use-wide-layout';

/**
 * The workspace.
 *
 * Section order is deliberate and differs slightly from a naive reading of the
 * spec: Source DNA sits directly under the score, *above* the map. The headline
 * "15 sources → 3 families" is the insight the product exists to deliver, and it
 * has to land before the reader starts exploring a graph.
 *
 * One piece of state is shared across every panel — the selected source — so
 * clicking a node, a ledger row, a timeline entry or a contradiction all focus
 * the same inspector.
 */
export function Workspace({ investigation }: { investigation: Investigation }): React.ReactElement {
  const [selectedSourceId, setSelectedSourceId] = React.useState<string | null>(null);
  const detailRef = React.useRef<HTMLDivElement>(null);
  const wide = useWideLayout();

  const selectSource = React.useCallback((id: string) => {
    setSelectedSourceId((current) => (current === id ? null : id));
  }, []);

  // On narrow screens the inspector renders inline, far from whatever was
  // clicked, so bring it into view rather than leaving the user to hunt.
  React.useEffect(() => {
    if (!selectedSourceId) return;
    if (wide) return;
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [selectedSourceId, wide]);

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelectedSourceId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const detail = selectedSourceId ? (
    <div ref={detailRef} className="ph-rise">
      <SourceDetail
        investigation={investigation}
        sourceId={selectedSourceId}
        onClose={() => setSelectedSourceId(null)}
        onSelectSource={selectSource}
      />
    </div>
  ) : null;

  return (
    <div className="mx-auto w-full max-w-[1500px] px-4 pb-20 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 py-5">
        <Link href="/" className="rounded">
          <Wordmark />
        </Link>
        <span aria-hidden className="text-faint">
          /
        </span>
        <span className="ph-label">Case {investigation.id}</span>
        <div className="ml-auto flex items-center gap-2">
          {investigation.isDemonstration ? <Badge tone="brass">Demonstration case</Badge> : null}
          <Link
            href="/investigations"
            className="ph-label -mx-2 inline-flex min-h-[32px] items-center px-2 transition-colors hover:text-signal"
          >
            Case history
          </Link>
        </div>
      </header>

      <main id="main" className="space-y-4">
        <ResearchBanner investigation={investigation} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
          <div className="space-y-4">
            <ClaimCard investigation={investigation} />

            {/* The score and inspector live in the rail on wide screens and
                here, in reading order, on narrow ones — rendered once either
                way rather than twice with one copy hidden. */}
            {wide ? null : (
              <div className="space-y-4">
                <EvidenceScorePanel score={investigation.score} />
                {detail}
              </div>
            )}

            <SourceDNA
              investigation={investigation}
              selectedSourceId={selectedSourceId}
              onSelectSource={selectSource}
            />
            <EvidenceMap
              investigation={investigation}
              selectedSourceId={selectedSourceId}
              onSelectSource={selectSource}
            />
            <EvidenceLedger investigation={investigation} onSelectSource={selectSource} />
            <Contradictions investigation={investigation} onSelectSource={selectSource} />
            <MissingEvidence items={investigation.missingEvidence} />
            <Timeline investigation={investigation} onSelectSource={selectSource} />
            <InvestigationSummaryPanel investigation={investigation} />
          </div>

          {wide ? (
            <aside className="space-y-4 xl:sticky xl:top-4" aria-label="Score and source inspector">
              <EvidenceScorePanel score={investigation.score} />
              {detail ?? (
                <Panel className="px-4 py-5">
                  <p className="ph-label">Source inspector</p>
                  <p className="mt-2 text-xs leading-relaxed text-faint">
                    Select any source — in the map, the lineage, the ledger or the timeline — to see where it
                    came from, what it actually says and who repeats it.
                  </p>
                </Panel>
              )}
              <InvestigationTrace investigation={investigation} />
            </aside>
          ) : null}
        </div>

        {wide ? null : <InvestigationTrace investigation={investigation} />}
      </main>
    </div>
  );
}
