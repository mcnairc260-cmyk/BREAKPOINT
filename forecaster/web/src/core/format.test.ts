import { describe, expect, it } from 'vitest';
import {
  confidenceLabel,
  describeSampleSize,
  formatClock,
  formatCountdown,
  formatHorizon,
  formatPrice,
  formatProbability,
  formatSignedPercent,
  formatSignedPrice,
} from '@/core/format';

describe('formatProbability', () => {
  it('never implies more precision than the system has', () => {
    // The difference between 0.3% and 0.7% is far below what any realistic
    // amount of outcome data can establish, so it is not printed.
    expect(formatProbability(0.003)).toBe('<1%');
    expect(formatProbability(0.0001)).toBe('<1%');
    expect(formatProbability(0.997)).toBe('>99%');
  });

  it('shows one decimal in the range that means something', () => {
    expect(formatProbability(0.5)).toBe('50.0%');
    expect(formatProbability(0.628)).toBe('62.8%');
    expect(formatProbability(0.0125)).toBe('1.3%');
  });

  it('handles a missing value rather than printing NaN', () => {
    expect(formatProbability(Number.NaN)).toBe('—');
  });
});

describe('describeSampleSize', () => {
  it('refuses to let a tiny sample look like evidence', () => {
    expect(describeSampleSize(0).label).toBe('No outcomes yet');
    expect(describeSampleSize(12).label).toBe('Far too few to judge');
    expect(describeSampleSize(60).label).toBe('Too few to judge');
    expect(describeSampleSize(400).label).toBe('Indicative only');
    expect(describeSampleSize(5000).label).toBe('Usable sample');
  });

  it('always explains why', () => {
    for (const n of [0, 5, 50, 500, 50_000]) {
      expect(describeSampleSize(n).detail.length).toBeGreaterThan(20);
    }
  });
});

describe('price and percentage formatting', () => {
  it('formats prices as currency', () => {
    expect(formatPrice(79434.27)).toBe('$79,434.27');
  });

  it('marks direction with a real minus sign, not a hyphen', () => {
    expect(formatSignedPrice(25.73)).toBe('+$25.73');
    expect(formatSignedPrice(-25.73)).toBe('−$25.73');
    expect(formatSignedPercent(0.0324)).toBe('+0.0324%');
    expect(formatSignedPercent(-0.0324)).toBe('−0.0324%');
  });
});

describe('time formatting', () => {
  it('names horizons the way the interface labels them', () => {
    expect(formatHorizon(300)).toBe('5 MIN');
    expect(formatHorizon(1200)).toBe('20 MIN');
    expect(formatHorizon(3600)).toBe('1 HOUR');
  });

  it('counts down in minutes and seconds', () => {
    expect(formatCountdown(300)).toBe('5:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(0)).toBe('expired');
    expect(formatCountdown(-5)).toBe('expired');
  });

  it('does not throw on an unparseable timestamp', () => {
    expect(formatClock('not a date')).toBe('—');
  });
});

describe('confidenceLabel', () => {
  it('upper-cases for display', () => {
    expect(confidenceLabel('moderate')).toBe('MODERATE');
  });
});
