'use client';

import { useEffect, useState } from 'react';
import { Banner, Label, Panel, cx } from '@/components/primitives';
import { ReliabilityChart } from '@/components/reliability-chart';
import { getStats } from '@/core/client';
import { formatHorizon, formatProbability } from '@/core/format';
import type { GroupStats, StatsResponse } from '@/core/types';

function MetricRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-0">
      <span className="text-[12px] text-muted">{label}</span>
      <span className="text-right">
        <span className="tnum text-[13px] font-medium text-ink">{value}</span>
        {hint ? <span className="ml-2 text-[11px] text-faint">{hint}</span> : null}
      </span>
    </div>
  );
}

function GroupPanel({ group }: { group: GroupStats }) {
  const heading = `${group.symbol.replace('-USD', '')} · ${formatHorizon(group.horizon_s)}`;
  if (!group.n) {
    return (
      <Panel className="p-4">
        <h3 className="text-[13px] font-semibold tracking-tight">{heading}</h3>
        <p className="mt-2 text-[12px] text-muted">No scored forecasts yet.</p>
      </Panel>
    );
  }
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold tracking-tight">{heading}</h3>
        <span className="tnum text-[11px] text-faint">{group.n} scored</span>
      </div>

      <div className="mt-3">
        <MetricRow
          label="Brier score"
          value={group.brier?.toFixed(4) ?? '—'}
          hint="lower is better"
        />
        <MetricRow
          label="Calibration error"
          value={group.ece?.toFixed(4) ?? '—'}
          hint="gap between promised and observed"
        />
        <MetricRow label="Log loss" value={group.log_loss?.toFixed(4) ?? '—'} />
        <MetricRow
          label="Accuracy"
          value={group.accuracy !== undefined ? formatProbability(group.accuracy) : '—'}
          hint="least useful number here"
        />
        <MetricRow
          label="Skill over a coin flip"
          value={
            group.brier_skill !== undefined && group.brier_skill !== null
              ? `${(group.brier_skill * 100).toFixed(1)}%`
              : '—'
          }
        />
      </div>

      {group.sample_size_note ? (
        <p className="mt-3 rounded-lg border border-line bg-void/60 p-2.5 text-[11px] leading-relaxed text-muted">
          {group.sample_size_note}
        </p>
      ) : null}
      {group.calibration_note ? (
        <p className="mt-2 text-[11px] leading-relaxed text-warn">{group.calibration_note}</p>
      ) : null}

      {group.calibration && group.calibration.buckets.length > 0 ? (
        <div className="mt-4 border-t border-line pt-3">
          <Label>Reliability</Label>
          <div className="mt-2">
            <ReliabilityChart buckets={group.calibration.buckets} />
          </div>
        </div>
      ) : null}

      {group.probability_buckets && group.probability_buckets.some((b) => b.n > 0) ? (
        <div className="mt-4 border-t border-line pt-3">
          <Label>By confidence band</Label>
          <table className="mt-2 w-full text-[11px]">
            <thead>
              <tr className="text-faint">
                <th className="pb-1 text-left font-normal">Band</th>
                <th className="pb-1 text-right font-normal">n</th>
                <th className="pb-1 text-right font-normal">Said</th>
                <th className="pb-1 text-right font-normal">Happened</th>
              </tr>
            </thead>
            <tbody className="tnum">
              {group.probability_buckets
                .filter((bucket) => bucket.n > 0)
                .map((bucket) => (
                  <tr key={bucket.low} className="border-t border-line">
                    <td className="py-1 text-muted">
                      {(bucket.low * 100).toFixed(0)}–{Math.min(100, bucket.high * 100).toFixed(0)}%
                    </td>
                    <td className="py-1 text-right text-muted">{bucket.n}</td>
                    <td className="py-1 text-right text-muted">
                      {bucket.predicted !== null ? `${(bucket.predicted * 100).toFixed(1)}%` : '—'}
                    </td>
                    <td
                      className={cx(
                        'py-1 text-right font-medium',
                        bucket.observed !== null && bucket.predicted !== null
                          ? Math.abs(bucket.observed - bucket.predicted) < 0.05
                            ? 'text-above'
                            : 'text-warn'
                          : 'text-muted',
                      )}
                    >
                      {bucket.observed !== null ? `${(bucket.observed * 100).toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
}

export default function PerformancePage() {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await getStats();
        if (!cancelled) {
          setStats(data);
          setError(null);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : 'Could not load statistics');
      }
    };
    void load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const groups = stats ? Object.values(stats.groups) : [];
  const voids = stats?.void_analysis ?? {};

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-[20px] font-semibold tracking-tight">Model performance</h1>
        <p className="mt-1 text-[13px] text-muted">
          Whether the stated probabilities have matched what actually happened.
        </p>
      </div>

      {error ? <Banner tone="danger" title="Could not load statistics">{error}</Banner> : null}

      {stats && stats.data_source && stats.data_source !== 'live' ? (
        <Banner tone="warn" title={`${stats.data_source.toUpperCase()} DATA`}>
          These results describe forecasts made against {stats.data_source} market data. They say
          the pipeline works. They are not evidence about real markets.
        </Banner>
      ) : null}

      {stats && stats.total_resolved === 0 ? (
        <Panel className="p-5 text-[13px] leading-relaxed text-muted">
          <p className="text-ink">Nothing scored yet</p>
          <p className="mt-2">
            Forecasts appear here once their horizon has passed and the outcome has been read
            from the recorded feed. A 5-minute forecast takes 5 minutes.
          </p>
        </Panel>
      ) : null}

      {groups.length > 0 ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {groups.map((group) => (
            <GroupPanel key={`${group.symbol}-${group.horizon_s}`} group={group} />
          ))}
        </div>
      ) : null}

      {typeof voids.resolved === 'number' && voids.resolved > 0 ? (
        <Panel className="p-4">
          <Label>Unscored forecasts</Label>
          <p className="mt-2 text-[12px] leading-relaxed text-muted">
            {typeof voids.void_rate === 'number'
              ? `${(voids.void_rate * 100).toFixed(1)}% of forecasts could not be scored, usually because no trade was recorded near the expiry time. `
              : ''}
            Excluding them is not neutral — feeds drop when markets move fastest — so accuracy
            is shown as a range that accounts for them:
            {typeof voids.accuracy_if_all_voids_wrong === 'number' &&
            typeof voids.accuracy_if_all_voids_right === 'number' ? (
              <span className="tnum text-ink">
                {' '}
                {(voids.accuracy_if_all_voids_wrong * 100).toFixed(1)}% to{' '}
                {(voids.accuracy_if_all_voids_right * 100).toFixed(1)}%
              </span>
            ) : null}
            .
          </p>
        </Panel>
      ) : null}

      {stats ? (
        <Panel className="p-4 text-[12px] leading-relaxed text-faint">{stats.honesty_note}</Panel>
      ) : null}
    </div>
  );
}
