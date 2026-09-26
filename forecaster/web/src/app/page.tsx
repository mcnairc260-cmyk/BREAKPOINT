'use client';

import { useCallback, useEffect, useState } from 'react';
import { AssetSelector } from '@/components/asset-selector';
import { DataSourceBanner } from '@/components/data-source-banner';
import { ForecastCard } from '@/components/forecast-card';
import { LivePrice } from '@/components/live-price';
import { Banner, Label, Panel, cx } from '@/components/primitives';
import { TargetInput } from '@/components/target-input';
import { EngineError, getPrice, postForecast } from '@/core/client';
import { formatSignedPercent, formatSignedPrice } from '@/core/format';
import { HORIZONS, type ForecastResponse, type Price } from '@/core/types';

type HorizonChoice = 300 | 1200 | 'both';

const PRICE_POLL_MS = 2000;

export default function ForecastPage() {
  const [symbol, setSymbol] = useState<string>('BTC-USD');
  const [target, setTarget] = useState('');
  const [choice, setChoice] = useState<HorizonChoice>('both');
  const [price, setPrice] = useState<Price | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [result, setResult] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // The live price polls on its own. The forecast does not: a probability that
  // silently changed under the reader would make the recorded prediction and
  // the number on screen disagree, and the recorded one is the one that gets
  // scored.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await getPrice(symbol);
        if (!cancelled) {
          setPrice(next);
          setPriceError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setPrice(null);
          setPriceError(caught instanceof Error ? caught.message : 'Price unavailable');
        }
      }
    };
    void load();
    const timer = window.setInterval(load, PRICE_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [symbol]);

  useEffect(() => {
    setResult(null);
    setError(null);
    setRefusal(null);
  }, [symbol]);

  const predict = useCallback(async () => {
    const parsed = Number.parseFloat(target);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a target price above zero.');
      return;
    }
    setPending(true);
    setError(null);
    setRefusal(null);
    try {
      const horizons = choice === 'both' ? [...HORIZONS] : [choice];
      setResult(await postForecast({ symbol, target: parsed, horizons }));
    } catch (caught) {
      setResult(null);
      if (caught instanceof EngineError && caught.isRefusal) setRefusal(caught.message);
      else setError(caught instanceof Error ? caught.message : 'Forecast failed');
    } finally {
      setPending(false);
    }
  }, [choice, symbol, target]);

  const canPredict = Number.isFinite(Number.parseFloat(target)) && Number.parseFloat(target) > 0;

  return (
    <div className="space-y-4">
      {price ? (
        <DataSourceBanner
          dataSource={price.data_source}
          venue={price.venue}
          serviceLevel={price.service_level}
        />
      ) : null}

      <Panel className="p-4 sm:p-5">
        <AssetSelector value={symbol} onChange={setSymbol} disabled={pending} />

        <div className="mt-5 border-t border-line pt-4">
          <Label>Live price</Label>
          <div className="mt-1.5">
            <LivePrice price={price} error={priceError} />
          </div>
        </div>

        <div className="mt-5">
          <TargetInput
            value={target}
            onChange={setTarget}
            spot={price?.price ?? null}
            disabled={pending}
          />
        </div>

        <div className="mt-5">
          <Label>Horizon</Label>
          <div className="mt-1.5 grid grid-cols-3 gap-2" role="group" aria-label="Forecast horizon">
            {(
              [
                { value: 300 as const, label: '5 min' },
                { value: 1200 as const, label: '20 min' },
                { value: 'both' as const, label: 'Both' },
              ]
            ).map((option) => (
              <button
                key={String(option.value)}
                type="button"
                aria-pressed={choice === option.value}
                disabled={pending}
                onClick={() => setChoice(option.value)}
                className={cx(
                  'rounded-lg border px-3 py-2.5 text-[13px] font-medium transition-colors disabled:opacity-50',
                  choice === option.value
                    ? 'border-accent/60 bg-accent/10 text-ink'
                    : 'border-line bg-surface/60 text-muted hover:border-line-bright',
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={predict}
          disabled={pending || !canPredict}
          className="mt-5 w-full rounded-xl bg-accent px-4 py-3.5 text-[15px] font-semibold tracking-tight text-void transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {pending ? 'Working…' : 'Predict'}
        </button>
      </Panel>

      {error ? <Banner tone="danger" title="Something went wrong">{error}</Banner> : null}
      {refusal ? (
        <Banner tone="warn" title="No forecast made">
          {refusal}
          <p className="mt-1.5 opacity-80">
            The system declines rather than producing a number it cannot stand behind.
          </p>
        </Banner>
      ) : null}

      {result ? (
        <>
          <Panel className="p-4 sm:p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <div>
                <Label>Forecasting against</Label>
                <div className="tnum mt-1 text-[19px] font-semibold tracking-tight">
                  ${result.target.toLocaleString('en-US', { minimumFractionDigits: 2 })}
                </div>
              </div>
              <div className="text-right">
                <Label>Distance</Label>
                <div
                  className={cx(
                    'tnum mt-1 text-[19px] font-semibold tracking-tight',
                    result.distance > 0 ? 'text-above' : result.distance < 0 ? 'text-below' : 'text-muted',
                  )}
                >
                  {formatSignedPrice(result.distance)}
                  <span className="ml-2 text-[13px] font-normal text-faint">
                    {formatSignedPercent(result.distance_pct, 4)}
                  </span>
                </div>
              </div>
            </div>
            {result.warnings.length > 0 ? (
              <ul className="mt-3 space-y-1 border-t border-line pt-3 text-[12px] text-warn">
                {result.warnings.map((warning) => (
                  <li key={warning}>· {warning}</li>
                ))}
              </ul>
            ) : null}
          </Panel>

          <div className={cx('grid gap-4', result.forecasts.length > 1 ? 'sm:grid-cols-2' : '')}>
            {result.forecasts.map((forecast) => (
              <ForecastCard key={forecast.horizon_s} forecast={forecast} />
            ))}
          </div>
        </>
      ) : null}

      {!result && !refusal ? (
        <Panel className="p-5 text-[13px] leading-relaxed text-muted">
          <p className="text-ink">What this does</p>
          <p className="mt-2">
            Pick an asset, type a price, and get the probability it finishes above or below
            that price in 5 or 20 minutes. The answer is a calibrated probability, not a
            call — for a target close to the current price it will usually sit near 50%,
            because at these horizons there is very little in the data that says otherwise.
          </p>
          <p className="mt-2">
            Every forecast is saved before its outcome is knowable and scored automatically
            when it expires, so the Performance page can show whether the numbers have held
            up.
          </p>
        </Panel>
      ) : null}
    </div>
  );
}
