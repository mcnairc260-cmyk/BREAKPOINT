'use client';

import { cx } from '@/components/primitives';
import { formatPrice } from '@/core/format';
import type { Price } from '@/core/types';

/**
 * The live price, and how much to trust it.
 *
 * The age of the last tick is shown whenever it is more than a couple of
 * seconds old. A price with no age next to it implicitly claims to be current,
 * and on a broken feed that claim is the lie that everything else rests on.
 */
export function LivePrice({ price, error }: { price: Price | null; error: string | null }) {
  if (error) {
    return (
      <div className="text-[13px] text-danger">
        {error}
      </div>
    );
  }
  if (!price) {
    return <div className="tnum text-[30px] font-semibold tracking-tight text-faint">—</div>;
  }

  const stale = price.stale || (price.age_s !== null && price.age_s > 5);
  return (
    <div>
      <div className="flex items-baseline gap-2.5">
        <span
          className={cx(
            'tnum text-[30px] font-semibold leading-none tracking-tight sm:text-[34px]',
            stale ? 'text-muted' : 'text-ink',
          )}
        >
          {formatPrice(price.price)}
        </span>
        {!stale ? (
          <span className="live-dot h-1.5 w-1.5 shrink-0 rounded-full bg-above" aria-hidden />
        ) : null}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
        <span>{price.venue}</span>
        {price.spread_bps !== null ? <span>spread {price.spread_bps.toFixed(1)} bps</span> : null}
        {price.age_s !== null && price.age_s > 2 ? (
          <span className={stale ? 'text-warn' : undefined}>{price.age_s.toFixed(0)}s old</span>
        ) : null}
        {stale ? <span className="text-warn">stale</span> : null}
      </div>
    </div>
  );
}
