'use client';

import { cx } from '@/components/primitives';

const ASSETS = [
  { symbol: 'BTC-USD', name: 'Bitcoin', ticker: 'BTC' },
  { symbol: 'ETH-USD', name: 'Ethereum', ticker: 'ETH' },
] as const;

/**
 * Two large targets, thumb-reachable, no dropdown.
 *
 * A select element would be smaller and worse: this is a two-option choice the
 * user makes constantly, and every extra tap on a phone is a reason not to
 * bother.
 */
export function AssetSelector({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (symbol: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Choose an asset">
      {ASSETS.map((asset) => {
        const selected = asset.symbol === value;
        return (
          <button
            key={asset.symbol}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(asset.symbol)}
            className={cx(
              'rounded-xl border px-4 py-3 text-left transition-colors disabled:opacity-50',
              selected
                ? 'border-accent/60 bg-accent/10'
                : 'border-line bg-surface/60 hover:border-line-bright',
            )}
          >
            <div className={cx('text-[17px] font-semibold tracking-tight', selected ? 'text-ink' : 'text-muted')}>
              {asset.ticker}
            </div>
            <div className="text-[12px] text-faint">{asset.name}</div>
          </button>
        );
      })}
    </div>
  );
}
