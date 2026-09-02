import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Title-case a snake_case enum value for display. */
export function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * The URL if it is safe to put in an `href`, otherwise null.
 *
 * Source URLs arrive from search providers, which are outside our trust
 * boundary. React blocks `javascript:` but renders `data:` and `vbscript:`
 * verbatim, so a hostile or compromised provider could hand us a link that
 * navigates to attacker-controlled markup. Only http(s) is ever linkable.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
