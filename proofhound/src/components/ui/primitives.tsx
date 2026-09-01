'use client';

import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cn } from '@/lib/utils';

/**
 * The small set of primitives the workspace is built from.
 *
 * Hand-styled rather than pulled from a component library: the brief rules out
 * a generic template look, and a shared kit's defaults are exactly that look.
 * Radix sits underneath the interactive pieces so keyboard and screen-reader
 * behaviour is correct without reimplementing it.
 */

export function Panel({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div className={cn('ph-panel', className)} {...props}>
      {children}
    </div>
  );
}

interface SectionProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  /** Short uppercase index, e.g. "03". Reads as a case-file section marker. */
  index?: string;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  id?: string;
}

export function Section({
  title,
  index,
  subtitle,
  actions,
  className,
  children,
  ...props
}: SectionProps): React.ReactElement {
  const headingId = `${props.id ?? title.toLowerCase().replace(/\W+/g, '-')}-heading`;
  return (
    <section aria-labelledby={headingId} className={cn('ph-panel overflow-hidden', className)} {...props}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-3 sm:px-5">
        <div className="flex items-baseline gap-3">
          {index ? <span className="ph-label text-brass-dim tabular-nums">{index}</span> : null}
          <h2 id={headingId} className="text-[15px] font-semibold tracking-tight text-ink">
            {title}
          </h2>
        </div>
        {subtitle ? <p className="ph-note max-w-prose">{subtitle}</p> : null}
        {actions ? <div className="ml-auto flex items-center gap-2">{actions}</div> : null}
      </header>
      {children}
    </section>
  );
}

const BADGE_TONES = {
  neutral: 'border-line-strong bg-raised text-dim',
  brass: 'border-brass/35 bg-brass/10 text-brass',
  signal: 'border-signal/35 bg-signal/10 text-signal',
  supports: 'border-supports/35 bg-supports/10 text-supports',
  contradicts: 'border-contradicts/35 bg-contradicts/10 text-contradicts',
  derived: 'border-derived/35 bg-derived/10 text-derived',
  warn: 'border-brass/45 bg-brass/15 text-brass',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({
  tone = 'neutral',
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase leading-4 tracking-[0.1em]',
        BADGE_TONES[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

const BUTTON_VARIANTS = {
  primary:
    'bg-brass text-void hover:bg-brass/90 border border-brass disabled:border-line-strong disabled:bg-transparent disabled:text-faint',
  secondary: 'border border-line-strong bg-raised text-ink hover:border-signal/60 hover:text-signal',
  ghost: 'border border-transparent text-dim hover:border-line-strong hover:text-ink',
} as const;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof BUTTON_VARIANTS;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', className, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
        'disabled:cursor-not-allowed disabled:opacity-60',
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  );
});

/** A stat with its label above it, used for the headline Source DNA numbers. */
export function Stat({
  label,
  value,
  hint,
  tone = 'ink',
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'ink' | 'brass' | 'signal';
  className?: string;
}): React.ReactElement {
  const toneClass = tone === 'brass' ? 'text-brass' : tone === 'signal' ? 'text-signal' : 'text-ink';
  return (
    <div className={cn('min-w-0', className)}>
      <div className="ph-label">{label}</div>
      <div className={cn('mt-1.5 font-mono text-2xl leading-none tabular-nums sm:text-[28px]', toneClass)}>
        {value}
      </div>
      {hint ? <p className="mt-1.5 text-xs leading-snug text-faint">{hint}</p> : null}
    </div>
  );
}

export function TooltipProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <TooltipPrimitive.Provider delayDuration={150} skipDelayDuration={300}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Tooltips carry explanations of scoring terms, so they must be reachable by
 * keyboard. Radix handles focus and Escape; the trigger stays a real button.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-[11px] leading-none text-faint transition-colors hover:border-signal hover:text-signal"
        >
          ?
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          collisionPadding={12}
          className="z-50 max-w-xs rounded-md border border-line-strong bg-raised px-3 py-2 text-xs leading-relaxed text-dim shadow-xl shadow-black/60"
        >
          {children}
          <TooltipPrimitive.Arrow className="fill-[#2a3546]" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

/** A horizontal proportion bar. Used for score components; never animated on data change. */
export function Meter({
  value,
  max,
  tone = 'signal',
  label,
}: {
  value: number;
  max: number;
  tone?: 'signal' | 'brass' | 'contradicts';
  label: string;
}): React.ReactElement {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  const bar = tone === 'brass' ? 'bg-brass' : tone === 'contradicts' ? 'bg-contradicts' : 'bg-signal';
  return (
    <div
      role="meter"
      aria-valuenow={Number(value.toFixed(1))}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
      className="h-1.5 w-full overflow-hidden rounded-full bg-line"
    >
      <div className={cn('h-full rounded-full', bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * States a feature is deliberately not built yet.
 *
 * Used instead of a button that looks live and does nothing — the brief rules
 * that out, and so does basic honesty about what the product can do.
 */
export function DeferredNote({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <p className="flex items-start gap-2 rounded-md border border-dashed border-line-strong bg-raised/50 px-3 py-2 text-xs leading-relaxed text-faint">
      <span className="ph-label mt-px shrink-0 text-brass-dim">Not built yet</span>
      <span>{children}</span>
    </p>
  );
}
