import * as React from 'react';
import type {
  ConfidenceLevel,
  Directness,
  EpistemicStatus,
  QualityGrade,
  Source,
  Stance,
  VerificationState,
} from '@/core/types';
import { Badge, type BadgeTone } from '@/components/ui/primitives';
import { formatPartialDate } from '@/core/pipeline/timeline';
import { safeExternalUrl } from '@/lib/utils';

/**
 * Display vocabulary shared by every workspace panel.
 *
 * Colour is meaning: a reader who learns "brass = origin, violet = derivative,
 * red = contradicts" in the Source DNA panel can read the map, the ledger and
 * the timeline without learning anything new.
 */

export const STANCE_TONE: Record<Stance, BadgeTone> = {
  supports: 'supports',
  contradicts: 'contradicts',
  neutral: 'neutral',
};

export const STANCE_LABEL: Record<Stance, string> = {
  supports: 'Supports',
  contradicts: 'Contradicts',
  neutral: 'Neutral',
};

export const VERIFICATION_LABEL: Record<VerificationState, string> = {
  VERIFIED: 'Verified',
  UNVERIFIED_SOURCE: 'Unverified source',
  INACCESSIBLE: 'Inaccessible',
};

export function StanceBadge({ stance }: { stance: Stance }): React.ReactElement {
  return <Badge tone={STANCE_TONE[stance]}>{STANCE_LABEL[stance]}</Badge>;
}

export function VerificationBadge({ state }: { state: VerificationState }): React.ReactElement {
  return (
    <Badge tone={state === 'VERIFIED' ? 'neutral' : 'warn'}>{VERIFICATION_LABEL[state]}</Badge>
  );
}

export function EpistemicBadge({ status }: { status: EpistemicStatus }): React.ReactElement {
  const tone: BadgeTone = status === 'FACT' ? 'supports' : status === 'SPECULATION' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{status.replace(/_/g, ' ')}</Badge>;
}

export function ConfidenceBadge({ level }: { level: ConfidenceLevel }): React.ReactElement {
  return <Badge tone={level === 'LOW' ? 'warn' : 'neutral'}>{level} confidence</Badge>;
}

/** Independence rendered as a word, because 0.45 means nothing on its own. */
export function independenceLabel(independence: number): string {
  if (independence >= 0.99) return 'Origin';
  if (independence >= 0.4) return 'One step removed';
  if (independence >= 0.2) return 'Two steps removed';
  return 'Distant repetition';
}

/** Table-width form of the same fact. */
export function independenceShort(independence: number): string {
  if (independence >= 0.99) return 'Origin';
  if (independence >= 0.4) return '1 hop';
  if (independence >= 0.2) return '2 hops';
  return '3+ hops';
}

export function independenceTone(independence: number): BadgeTone {
  if (independence >= 0.99) return 'brass';
  if (independence >= 0.4) return 'signal';
  return 'derived';
}

export const DIRECTNESS_LABEL: Record<Directness, string> = {
  direct: 'Direct',
  indirect: 'Indirect',
  circumstantial: 'Circumstantial',
  hearsay: 'Hearsay',
};

export const QUALITY_LABEL: Record<QualityGrade, string> = {
  strong: 'Strong',
  moderate: 'Moderate',
  weak: 'Weak',
  unusable: 'Unusable',
};

export function sourceLabel(source: Source): string {
  return source.publisher ?? source.title;
}

export function sourceDate(source: Source): string {
  return formatPartialDate(source.publicationDate);
}

/** An external link that is only a link when the URL could actually be visited. */
export function SourceLink({ source }: { source: Source }): React.ReactElement | null {
  if (!source.url) return null;
  const safe = safeExternalUrl(source.url);
  const unreachable = source.url.includes('.invalid');
  // Anything that is not plain http(s) is shown as text, never as a link: the
  // URL came from a search provider, and only http(s) is safe to navigate to.
  if (unreachable || !safe) {
    return (
      <span
        className="break-all font-mono text-[11px] text-faint"
        title={unreachable ? 'Demonstration URL — cannot resolve' : 'Not a linkable http(s) address'}
      >
        {source.url}
      </span>
    );
  }
  return (
    <a
      href={safe}
      target="_blank"
      rel="noopener noreferrer nofollow"
      className="break-all font-mono text-[11px] text-signal underline-offset-2 hover:underline"
    >
      {source.url}
    </a>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="px-4 py-6 text-sm leading-relaxed text-faint sm:px-5">{children}</p>;
}
