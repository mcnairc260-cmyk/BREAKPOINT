'use client';

import { useEffect, useState } from 'react';
import { Countdown } from '@/components/countdown';
import { Banner, Label, Panel, cx } from '@/components/primitives';
import { getHistory } from '@/core/client';
import {
  describeSampleSize,
  formatClock,
  formatHorizon,
  formatPrice,
  formatProbability,
} from '@/core/format';
import type { HistoryRow } from '@/core/types';

const POLL_MS = 5000;

function OutcomeBadge({ row }: { row: HistoryRow }) {
  if (!row.resolved) {
    return (
      <span className="rounded-full border border-line-bright px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">
        <Countdown expiresAt={row.expires_at} />
      </span>
    );
  }
  if (row.outcome?.startsWith('void')) {
    return (
      <span className="rounded-full border border-warn/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-warn">
        void
      </span>
    );
  }
  return (
    <span
      className={cx(
        'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        row.correct ? 'border-above/50 text-above' : 'border-below/50 text-below',
      )}
    >
      {row.correct ? '✓ correct' : '✗ wrong'}
    </span>
  );
}

export default function HistoryPage() {
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getHistory(100);
        if (!cancelled) {
          setRows(data.predictions);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load history');
      }
    };
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const resolved = rows?.filter((row) => row.resolved && !row.outcome?.startsWith('void')) ?? [];
  const correct = resolved.filter((row) => row.correct).length;
  const sample = describeSampleSize(resolved.length);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">Prediction history</h1>
        <p className="mt-1 text-[13px] text-muted">
          Every forecast, recorded before its outcome could be known and scored automatically
          when it expired.
        </p>
      </div>

      {error ? <Banner tone="danger" title="Could not load history">{error}</Banner> : null}

      <Panel className="p-4 sm:p-5">
        <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
          <div>
            <Label>Scored</Label>
            <div className="tnum mt-1 text-[22px] font-semibold tracking-tight">
              {resolved.length}
            </div>
          </div>
          <div>
            <Label>Called correctly</Label>
            <div className="tnum mt-1 text-[22px] font-semibold tracking-tight">
              {resolved.length > 0 ? `${((correct / resolved.length) * 100).toFixed(0)}%` : '—'}
            </div>
          </div>
          <div className="min-w-[12rem] flex-1">
            <Label>{sample.label}</Label>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{sample.detail}</p>
          </div>
        </div>
        <p className="mt-4 border-t border-line pt-3 text-[12px] leading-relaxed text-faint">
          Accuracy is the least useful number here. A forecaster that says 55% and is right
          55% of the time is working perfectly, and accuracy makes that look mediocre. The
          Performance page has the measures that matter.
        </p>
      </Panel>

      {rows === null ? (
        <Panel className="p-5 text-[13px] text-muted">Loading…</Panel>
      ) : rows.length === 0 ? (
        <Panel className="p-5 text-[13px] text-muted">
          No forecasts yet. Make one on the Forecast page and it will appear here.
        </Panel>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id}>
              <Panel className="p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[13px] font-semibold tracking-tight">
                      {row.symbol.replace('-USD', '')}
                    </span>
                    <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted">
                      {formatHorizon(row.horizon_s)}
                    </span>
                    {row.data_source !== 'live' ? (
                      <span className="rounded border border-warn/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-warn">
                        {row.data_source}
                      </span>
                    ) : null}
                  </div>
                  <OutcomeBadge row={row} />
                </div>

                <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] sm:grid-cols-4">
                  <div>
                    <Label>Target</Label>
                    <div className="tnum mt-0.5 text-ink">{formatPrice(row.target)}</div>
                  </div>
                  <div>
                    <Label>Predicted</Label>
                    <div
                      className={cx(
                        'tnum mt-0.5 font-medium',
                        row.predicted_side === 'above' ? 'text-above' : 'text-below',
                      )}
                    >
                      {row.predicted_side} {formatProbability(Math.max(row.p_above, 1 - row.p_above))}
                    </div>
                  </div>
                  <div>
                    <Label>Settled at</Label>
                    <div className="tnum mt-0.5 text-ink">
                      {row.eval_price !== null ? formatPrice(row.eval_price) : '—'}
                    </div>
                  </div>
                  <div>
                    <Label>Expires</Label>
                    <div className="tnum mt-0.5 text-muted">{formatClock(row.expires_at)}</div>
                  </div>
                </div>
              </Panel>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
