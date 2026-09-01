'use client';

import * as React from 'react';
import type { Investigation } from '@/core/types';
import { DeferredNote, Panel } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

/**
 * What the pipeline actually did, with the real duration of each stage.
 *
 * Kept in the finished investigation rather than thrown away with the progress
 * indicator: when a result looks wrong, the first question is which stage
 * produced it.
 */
export function InvestigationTrace({ investigation }: { investigation: Investigation }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const total = investigation.stages.reduce((sum, stage) => sum + stage.durationMs, 0);

  return (
    <Panel className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left sm:px-5"
      >
        <span className="ph-label">Investigation trace</span>
        <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">{total}ms</span>
        <span aria-hidden className="font-mono text-xs text-faint">
          {open ? '−' : '+'}
        </span>
      </button>

      {open ? (
        <div className="border-t border-line px-4 py-3 sm:px-5">
          <ol className="space-y-2">
            {investigation.stages.map((stage) => (
              <li key={stage.id} className="text-xs">
                <div className="flex items-baseline gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'font-mono',
                      stage.state === 'failed'
                        ? 'text-contradicts'
                        : stage.state === 'skipped'
                          ? 'text-faint'
                          : 'text-supports',
                    )}
                  >
                    {stage.state === 'failed' ? '✕' : stage.state === 'skipped' ? '–' : '✓'}
                  </span>
                  <span className="text-ink">{stage.label}</span>
                  <span className="ml-auto font-mono tabular-nums text-faint">{stage.durationMs}ms</span>
                </div>
                <p className="ml-5 mt-0.5 leading-relaxed text-faint">{stage.detail}</p>
              </li>
            ))}
          </ol>

          <div className="mt-4 space-y-2">
            <DeferredNote>
              Export, saved-case monitoring and collaboration are planned for later versions and are not
              wired up. No button here pretends otherwise.
            </DeferredNote>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
