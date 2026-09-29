/**
 * Formatting, and the honesty rules baked into it.
 *
 * Two of these are not cosmetic:
 *
 * `formatProbability` refuses to print more precision than the system has. A
 * probability below one percent shows as "<1%", not "0.3%", because the
 * difference between 0.3% and 0.7% is far below what any realistic amount of
 * outcome data can establish, and printing it implies knowledge that does not
 * exist.
 *
 * `describeSampleSize` turns a count into a sentence about what it can support.
 * Twenty resolved forecasts and twenty thousand should not look the same on a
 * page, and a number alone leaves the reader to guess.
 */

export function formatPrice(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatPriceCompact(value: number): string {
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

export function formatProbability(p: number): string {
  if (!Number.isFinite(p)) return '—';
  if (p < 0.01) return '<1%';
  if (p > 0.99) return '>99%';
  return `${(p * 100).toFixed(1)}%`;
}

export function formatSignedPrice(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${formatPrice(Math.abs(value))}`;
}

export function formatSignedPercent(value: number, digits = 4): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}%`;
}

export function formatHorizon(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600} HOUR`;
  return `${Math.round(seconds / 60)} MIN`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return 'expired';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
}

/**
 * What a given number of resolved forecasts can actually support.
 *
 * The thresholds are not arbitrary. At 30 outcomes the standard error on an
 * accuracy estimate is about 9 percentage points, which is wider than any edge
 * this kind of system plausibly has.
 */
export function describeSampleSize(n: number): { label: string; detail: string } {
  if (n === 0) return { label: 'No outcomes yet', detail: 'Nothing has been scored so far.' };
  if (n < 30)
    return {
      label: 'Far too few to judge',
      detail: `${n} scored forecasts. Random variation is much larger than any real difference at this size.`,
    };
  if (n < 100)
    return {
      label: 'Too few to judge',
      detail: `${n} scored forecasts. Enough to spot something badly broken, not enough to measure quality.`,
    };
  if (n < 1000)
    return {
      label: 'Indicative only',
      detail: `${n} scored forecasts. Calibration is starting to mean something, but confidence intervals are still wide.`,
    };
  return {
    label: 'Usable sample',
    detail: `${n} scored forecasts. Large enough for calibration to be measured, though the independent evidence is smaller than this count.`,
  };
}

export function confidenceLabel(confidence: string): string {
  return confidence.toUpperCase();
}
