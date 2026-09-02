'use client';

import { useSyncExternalStore } from 'react';

const QUERY = '(min-width: 1280px)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia(QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

/**
 * True when the viewport is wide enough for the two-column workspace.
 *
 * Used so the score panel and the source inspector exist exactly once in the
 * DOM. The obvious alternative — rendering both placements and hiding one with
 * `hidden xl:block` — duplicates every heading, button and live region, which
 * a screen reader then reads twice.
 *
 * The server snapshot is `true`: the wide layout is what gets sent, and a
 * narrow client corrects it on hydration.
 */
export function useWideLayout(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => true);
}
