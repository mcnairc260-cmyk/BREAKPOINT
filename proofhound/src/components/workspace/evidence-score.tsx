'use client';

import * as React from 'react';
import type { EvidenceBand, EvidenceScore as EvidenceScoreType } from '@/core/types';
import { InfoTip, Meter, Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * Evidence strength.
 *
 * The number is deliberately *not* a probability of truth, and the label says
 * so where the number is, not in a footnote. Every component and penalty is
 * shown with the sentence that produced it, so the score can be argued with.
 */

const BAND_COLOR: Record<EvidenceBand, string> = {
  INSUFFICIENT: 'text-contradicts',
  WEAK: 'text-contradicts',
  MODERATE: 'text-brass',
  STRONG: 'text-supports',
  'VERY STRONG': 'text-supports',
};

export function EvidenceScorePanel({ score }: { score: EvidenceScoreType }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const total = score.components.reduce((sum, c) => sum + c.points, 0);
  const deductions = score.penalties.reduce((sum, p) => sum + p.points, 0);

  return (
    <Panel className="overflow-hidden">
      <div className="px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2">
          <h2 className="ph-label">Evidence strength</h2>
          <InfoTip label="What evidence strength measures">
            This is a measure of how strong the available evidence is — its independence, directness,
            reproducibility and documentation. It is not a probability that the claim is true. A true claim
            with no surviving records scores low; a well-documented claim scores high right up until it is
            overturned.
          </InfoTip>
        </div>

        <div className="mt-2 flex items-end gap-3">
          <span className={cn('font-mono text-5xl leading-none tabular-nums', BAND_COLOR[score.band])}>
            {score.value}
          </span>
          <span className="pb-1 font-mono text-sm text-faint">/ 100</span>
          <span className={cn('ml-auto pb-1.5 font-mono text-xs tracking-[0.14em]', BAND_COLOR[score.band])}>
            {score.band}
          </span>
        </div>

        <div className="mt-3">
          <Meter
            value={score.value}
            max={100}
            tone={score.value >= 62 ? 'signal' : score.value >= 40 ? 'brass' : 'contradicts'}
            label={`Evidence strength ${score.value} out of 100`}
          />
        </div>

        <p className="mt-3.5 text-sm leading-relaxed text-dim">{score.explanation}</p>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="-mx-1 mt-2.5 inline-flex min-h-[30px] items-center px-1 text-xs text-signal underline-offset-4 hover:underline"
        >
          {open ? 'Hide the breakdown' : 'Show how this score was reached'}
        </button>
      </div>

      {open ? (
        <div className="border-t border-line px-4 py-4 sm:px-5">
          <ul className="space-y-3">
            {score.components.map((component) => (
              <li key={component.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-ink">{component.label}</span>
                  <span className="shrink-0 font-mono text-xs tabular-nums text-dim">
                    {component.points.toFixed(1)} / {component.max}
                  </span>
                </div>
                <div className="mt-1.5">
                  <Meter
                    value={component.points}
                    max={component.max}
                    label={`${component.label}: ${component.points} of ${component.max}`}
                  />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-faint">{component.rationale}</p>
              </li>
            ))}
          </ul>

          <div className="mt-5 border-t border-line pt-4">
            <div className="flex items-baseline justify-between gap-3">
              <span className="ph-label">Subtotal</span>
              <span className="font-mono text-xs tabular-nums text-dim">{total.toFixed(1)} / 100</span>
            </div>

            {score.penalties.length > 0 ? (
              <ul className="mt-3 space-y-2.5">
                {score.penalties.map((penalty) => (
                  <li key={penalty.key}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-sm text-contradicts">{penalty.label}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums text-contradicts">
                        {penalty.points.toFixed(1)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-faint">{penalty.rationale}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-faint">No penalties applied.</p>
            )}

            <div className="mt-4 flex items-baseline justify-between gap-3 border-t border-line pt-3">
              <span className="ph-label text-brass-dim">
                Total{deductions !== 0 ? ` (${total.toFixed(1)} − ${Math.abs(deductions).toFixed(1)})` : ''}
              </span>
              <span className="font-mono text-sm tabular-nums text-ink">{score.value} / 100</span>
            </div>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
