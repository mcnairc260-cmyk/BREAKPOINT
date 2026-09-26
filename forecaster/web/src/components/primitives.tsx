'use client';

import type { ReactNode } from 'react';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cx(
        'rounded-xl border border-line bg-surface/70 backdrop-blur-sm',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return (
    <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
      {children}
    </span>
  );
}

/**
 * A banner the page cannot render without deciding what to say.
 *
 * `tone` is required rather than defaulted, so adding a new warning forces a
 * decision about how loud it should be.
 */
export function Banner({
  tone,
  title,
  children,
}: {
  tone: 'warn' | 'danger' | 'info';
  title: string;
  children?: ReactNode;
}) {
  const palette = {
    warn: 'border-warn/40 bg-warn/10 text-warn',
    danger: 'border-danger/40 bg-danger/10 text-danger',
    info: 'border-accent/40 bg-accent/10 text-accent',
  }[tone];
  return (
    <div className={cx('rounded-lg border px-3.5 py-2.5 text-[13px]', palette)}>
      <p className="font-semibold tracking-tight">{title}</p>
      {children ? <div className="mt-1 leading-relaxed opacity-90">{children}</div> : null}
    </div>
  );
}

export function ConfidencePill({ confidence }: { confidence: string }) {
  const palette =
    confidence === 'high'
      ? 'border-above/40 text-above'
      : confidence === 'moderate'
        ? 'border-warn/40 text-warn'
        : 'border-danger/40 text-danger';
  return (
    <span
      className={cx(
        'rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em]',
        palette,
      )}
    >
      {confidence} confidence
    </span>
  );
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="tnum mt-1 text-[15px] font-medium text-ink">{value}</div>
      {hint ? <div className="mt-0.5 text-[12px] text-faint">{hint}</div> : null}
    </div>
  );
}
