'use client';

import { useState } from 'react';
import { Countdown } from '@/components/countdown';
import { ConfidencePill, Label, Panel, Stat, cx } from '@/components/primitives';
import { ProbabilitySplit } from '@/components/probability-split';
import {
  formatClock,
  formatHorizon,
  formatPrice,
  formatPriceCompact,
} from '@/core/format';
import type { HorizonForecast } from '@/core/types';

/**
 * One horizon's answer.
 *
 * The hierarchy is fixed and deliberate: horizon, then the two probabilities,
 * then the range, then when it can be scored, and only then the detail. A user
 * glancing at this on a phone should get the answer without reading a word
 * below the fold, and everything quantitative sits behind a disclosure so the
 * main screen stays legible.
 */
export function ForecastCard({ forecast }: { forecast: HorizonForecast }) {
  const [open, setOpen] = useState(false);
  const simulatedModel = forecast.model_train_source !== 'live';

  return (
    <Panel className="p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold uppercase tracking-[0.16em] text-ink">
          {formatHorizon(forecast.horizon_s)}
        </h3>
        <ConfidencePill confidence={forecast.confidence} />
      </div>

      <div className="mt-4">
        <ProbabilitySplit pAbove={forecast.p_above} pBelow={forecast.p_below} />
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat
          label={`${Math.round(forecast.range_confidence * 100)}% range`}
          value={
            <span className="whitespace-nowrap">
              {formatPriceCompact(forecast.range_low)} – {formatPriceCompact(forecast.range_high)}
            </span>
          }
        />
        <Stat
          label="Scores at"
          value={formatClock(forecast.expires_at)}
          hint={<Countdown expiresAt={forecast.expires_at} />}
        />
      </dl>

      {forecast.signals.length > 0 ? (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-4">
          {forecast.signals.slice(0, 4).map((signal) => (
            <li key={signal.name} className="flex gap-2.5 text-[13px] leading-snug">
              <span
                aria-hidden
                className={cx(
                  'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                  signal.direction === 'above'
                    ? 'bg-above'
                    : signal.direction === 'below'
                      ? 'bg-below'
                      : 'bg-line-bright',
                )}
              />
              <span className="text-muted">
                <span className="text-ink">{signal.label}</span> — {signal.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mt-4 w-full rounded-lg border border-line px-3 py-2 text-[12px] font-medium text-muted transition-colors hover:border-line-bright hover:text-ink"
      >
        {open ? 'Hide the detail' : 'Show how this number was made'}
      </button>

      {open ? (
        <div className="mt-3 space-y-3 rounded-lg border border-line bg-void/60 p-3.5 text-[12px]">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
            <Stat
              label="Distance in σ"
              value={`${forecast.z >= 0 ? '+' : '−'}${Math.abs(forecast.z).toFixed(2)}σ`}
              hint="how far the target is in standard deviations"
            />
            <Stat
              label="Expected move"
              value={`${forecast.sigma_pct.toFixed(3)}%`}
              hint="one standard deviation over this horizon"
            />
            <Stat label="Median outcome" value={formatPrice(forecast.median)} />
            <Stat
              label="Calibrated"
              value={forecast.calibration_source ? `yes (${forecast.calibration_source})` : 'no'}
              hint={
                forecast.calibration_source
                  ? undefined
                  : 'probabilities have not been adjusted against outcomes yet'
              }
            />
          </dl>

          <div>
            <Label>Why this confidence</Label>
            <ul className="mt-1.5 space-y-1 text-muted">
              {forecast.confidence_reasons.map((reason) => (
                <li key={reason}>· {reason}</li>
              ))}
            </ul>
          </div>

          <div className="border-t border-line pt-3">
            <Label>Model</Label>
            <p className="mt-1 break-all font-mono text-[11px] text-muted">
              {forecast.model_version}
            </p>
            <p className={cx('mt-1', simulatedModel ? 'text-warn' : 'text-faint')}>
              {simulatedModel
                ? `Trained on ${forecast.model_train_source} data — not validated against a real market.`
                : 'Trained on live market data.'}
            </p>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
