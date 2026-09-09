'use client';

import { useMemo } from 'react';
import { Label, cx } from '@/components/primitives';
import { formatSignedPercent, formatSignedPrice } from '@/core/format';

/**
 * Entering the target price.
 *
 * Three things matter here and nothing else does:
 *
 * The keyboard must be numeric on a phone (`inputMode="decimal"`), because the
 * whole interaction is typing a number.
 *
 * The distance from the current price updates as you type. It is the number that
 * actually determines the answer, so seeing it live teaches what the forecast
 * responds to.
 *
 * The nudge buttons move by a percentage, not by dollars. A fixed $50 step is
 * meaningful for Bitcoin and absurd for Ethereum; a percentage works for both
 * and keeps its meaning as prices change.
 */
const NUDGES = [-0.5, -0.1, 0.1, 0.5] as const;

export function TargetInput({
  value,
  onChange,
  spot,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  spot: number | null;
  disabled?: boolean;
}) {
  const parsed = Number.parseFloat(value);
  const valid = Number.isFinite(parsed) && parsed > 0;

  const distance = useMemo(() => {
    if (!valid || spot === null || spot <= 0) return null;
    return { absolute: parsed - spot, percent: (parsed / spot - 1) * 100 };
  }, [parsed, spot, valid]);

  const nudge = (percent: number) => {
    const base = valid ? parsed : spot;
    if (base === null || base <= 0) return;
    onChange((base * (1 + percent / 100)).toFixed(2));
  };

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>Target price</Label>
        {spot !== null ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(spot.toFixed(2))}
            className="text-[11px] text-accent transition-opacity hover:opacity-80 disabled:opacity-40"
          >
            use current
          </button>
        ) : null}
      </div>

      <div className="mt-1.5 flex items-center rounded-xl border border-line bg-surface/60 px-3.5 focus-within:border-accent/60">
        <span className="text-[22px] text-faint">$</span>
        <input
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={spot !== null ? spot.toFixed(2) : '0.00'}
          aria-label="Target price in US dollars"
          className="tnum w-full bg-transparent py-3 pl-1.5 text-[22px] font-semibold tracking-tight text-ink outline-none placeholder:text-faint/60 disabled:opacity-50"
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex gap-1.5">
          {NUDGES.map((percent) => (
            <button
              key={percent}
              type="button"
              disabled={disabled || (!valid && spot === null)}
              onClick={() => nudge(percent)}
              className="tnum rounded-md border border-line bg-surface/60 px-2 py-1 text-[11px] text-muted transition-colors hover:border-line-bright hover:text-ink disabled:opacity-40"
            >
              {percent > 0 ? '+' : '−'}
              {Math.abs(percent)}%
            </button>
          ))}
        </div>
        {distance ? (
          <div
            className={cx(
              'tnum text-right text-[12px]',
              distance.absolute > 0 ? 'text-above' : distance.absolute < 0 ? 'text-below' : 'text-muted',
            )}
          >
            {formatSignedPrice(distance.absolute)}
            <span className="ml-1.5 text-faint">{formatSignedPercent(distance.percent, 3)}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
