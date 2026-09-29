'use client';

import { Label } from '@/components/primitives';
import type { CalibrationBucket } from '@/core/types';

/**
 * Predicted probability against what actually happened.
 *
 * The diagonal is perfect calibration. Points above it mean the forecast was too
 * cautious; below, too confident.
 *
 * Every point carries its confidence interval as a vertical bar, and its size
 * scales with the number of outcomes behind it. Without those, a point resting
 * on four forecasts looks exactly like one resting on four thousand, and a
 * reliability chart drawn from a small sample is one of the easier ways to
 * convince yourself of something false.
 *
 * Drawn as inline SVG — no charting library, no dependency, and it stays legible
 * at phone width.
 */
export function ReliabilityChart({ buckets }: { buckets: CalibrationBucket[] }) {
  const size = 240;
  const pad = 28;
  const plot = size - pad * 2;
  const x = (value: number) => pad + value * plot;
  const y = (value: number) => size - pad - value * plot;
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count));

  if (total === 0) {
    return (
      <p className="text-[13px] text-muted">
        Nothing has been scored yet, so there is no curve to draw.
      </p>
    );
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="h-auto w-full max-w-[320px]"
        role="img"
        aria-label="Reliability chart: predicted probability against observed frequency"
      >
        <rect
          x={pad}
          y={pad}
          width={plot}
          height={plot}
          fill="var(--color-void)"
          stroke="var(--color-line)"
        />
        {[0.25, 0.5, 0.75].map((tick) => (
          <g key={tick}>
            <line x1={x(tick)} y1={pad} x2={x(tick)} y2={size - pad} stroke="var(--color-line)" strokeDasharray="2 4" />
            <line x1={pad} y1={y(tick)} x2={size - pad} y2={y(tick)} stroke="var(--color-line)" strokeDasharray="2 4" />
          </g>
        ))}
        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(1)}
          y2={y(1)}
          stroke="var(--color-line-bright)"
          strokeWidth={1.5}
        />
        {buckets.map((bucket) => (
          <line
            key={`ci-${bucket.low}`}
            x1={x(bucket.mean_predicted)}
            y1={y(bucket.ci_low)}
            x2={x(bucket.mean_predicted)}
            y2={y(bucket.ci_high)}
            stroke="var(--color-accent)"
            strokeOpacity={0.45}
            strokeWidth={1.5}
          />
        ))}
        {buckets.map((bucket) => (
          <circle
            key={`pt-${bucket.low}`}
            cx={x(bucket.mean_predicted)}
            cy={y(bucket.observed_rate)}
            r={3 + 4 * Math.sqrt(bucket.count / maxCount)}
            fill="var(--color-accent)"
            fillOpacity={0.85}
          />
        ))}
        <text x={pad} y={size - 8} fill="var(--color-faint)" fontSize={9}>
          0%
        </text>
        <text x={size - pad - 16} y={size - 8} fill="var(--color-faint)" fontSize={9}>
          100%
        </text>
        <text x={4} y={pad + 8} fill="var(--color-faint)" fontSize={9}>
          100%
        </text>
        <text x={8} y={size - pad} fill="var(--color-faint)" fontSize={9}>
          0%
        </text>
      </svg>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint">
        <span>horizontal: predicted · vertical: observed</span>
        <span>dot size = number of outcomes</span>
        <span>bars = 95% interval</span>
      </div>
    </div>
  );
}
