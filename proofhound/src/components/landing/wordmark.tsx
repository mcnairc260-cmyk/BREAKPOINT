import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * The mark: three nodes collapsing into one origin — the product's whole
 * argument in 22 pixels.
 */
export function Mark({ className }: { className?: string }): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn('h-5 w-5', className)}>
      <path d="M5 5.5 L12 12 M5 18.5 L12 12 M19 12 L12 12" stroke="currentColor" strokeWidth="1.4" opacity="0.5" />
      <circle cx="5" cy="5.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.6" />
      <circle cx="5" cy="18.5" r="2" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.6" />
      <circle cx="19" cy="12" r="2.6" fill="currentColor" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }): React.ReactElement {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <Mark className="text-brass" />
      <span className="text-[15px] font-semibold tracking-tight text-ink">ProofHound</span>
    </span>
  );
}
