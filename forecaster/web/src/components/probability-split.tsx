'use client';

import { formatProbability } from '@/core/format';
import { cx } from '@/components/primitives';

/**
 * ABOVE against BELOW, readable in one glance.
 *
 * Both numbers are shown at the same size. Showing only the larger one, or
 * shrinking the smaller, would turn a 52/48 into something that looks like a
 * call — and 52/48 is the honest answer most of the time at these horizons.
 *
 * The bar is the fast read; the numbers are the precise one. The leading side
 * is marked with a thin rule rather than a colour flood, so the difference
 * between 51% and 78% is visible as *width* rather than as intensity.
 */
export function ProbabilitySplit({
  pAbove,
  pBelow,
  size = 'large',
}: {
  pAbove: number;
  pBelow: number;
  size?: 'large' | 'small';
}) {
  const abovePct = Math.max(0, Math.min(100, pAbove * 100));
  const leading = pAbove >= pBelow ? 'above' : 'below';
  const numberClass = size === 'large' ? 'text-[34px] sm:text-[40px]' : 'text-[22px]';

  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div className={cx(leading === 'above' ? 'text-above' : 'text-muted')}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em]">Above</div>
          <div className={cx('tnum font-semibold leading-none tracking-tight', numberClass)}>
            {formatProbability(pAbove)}
          </div>
        </div>
        <div className={cx('text-right', leading === 'below' ? 'text-below' : 'text-muted')}>
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em]">Below</div>
          <div className={cx('tnum font-semibold leading-none tracking-tight', numberClass)}>
            {formatProbability(pBelow)}
          </div>
        </div>
      </div>

      <div
        className="mt-3 flex h-2 overflow-hidden rounded-full bg-surface-2"
        role="img"
        aria-label={`${formatProbability(pAbove)} above the target, ${formatProbability(pBelow)} below`}
      >
        <div className="bg-above transition-[width] duration-500" style={{ width: `${abovePct}%` }} />
        <div className="flex-1 bg-below transition-[width] duration-500" />
      </div>

      {/* The 50% mark, so "barely leaning" is visually distinct from "confident". */}
      <div className="relative mt-1 h-3">
        <div
          className="absolute top-0 h-2 w-px bg-line-bright"
          style={{ left: '50%' }}
          aria-hidden
        />
        <span className="absolute left-1/2 top-1.5 -translate-x-1/2 text-[9px] uppercase tracking-wider text-faint">
          coin flip
        </span>
      </div>
    </div>
  );
}
