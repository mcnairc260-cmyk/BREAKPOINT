import * as React from 'react';
import type { Investigation } from '@/core/types';
import { cn } from '@/lib/utils';

/**
 * Where the evidence came from — stated before any of it is shown.
 *
 * This banner is not dismissible and not collapsed. A demonstration corpus that
 * looks like live research would undermine everything else the product says.
 */
export function ResearchBanner({ investigation }: { investigation: Investigation }): React.ReactElement {
  const { researchMode, researchModeNote, analysisEngine } = investigation;

  const tone =
    researchMode === 'LIVE'
      ? 'border-signal/40 bg-signal/[0.07] text-signal'
      : researchMode === 'DEMONSTRATION'
        ? 'border-brass/45 bg-brass/[0.08] text-brass'
        : 'border-line-strong bg-raised text-dim';

  const label =
    researchMode === 'LIVE'
      ? 'Live research'
      : researchMode === 'DEMONSTRATION'
        ? 'Demonstration data'
        : 'No sources retrieved';

  return (
    <div className={cn('rounded-[10px] border px-4 py-3 sm:px-5', tone)}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.16em]">{label}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-60">
          Analysis engine: {analysisEngine}
        </span>
      </div>
      <p className="mt-1.5 max-w-3xl text-xs leading-relaxed text-dim">{researchModeNote}</p>
    </div>
  );
}
