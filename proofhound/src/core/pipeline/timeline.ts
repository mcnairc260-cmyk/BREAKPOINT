import type { TimelineEvent } from '@/core/types';

/**
 * Timeline construction.
 *
 * Dates arrive partial (`2019`, `2019-04`, `2019-04-11`) because sources are
 * often vague. Rather than inventing precision, a partial date sorts at the
 * start of the period it names and is rendered as the period it named.
 */

const FULL = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;
const YEAR = /^(\d{4})$/;

/** Sort key for a possibly-partial ISO date. Undated events sort last. */
export function dateSortKey(date: string | null): string {
  if (!date) return '9999-99-99';
  if (FULL.test(date)) return date;
  if (MONTH.test(date)) return `${date}-00`;
  if (YEAR.test(date)) return `${date}-00-00`;
  // Anything else is not a date we can order; treat it as undated.
  return '9999-99-99';
}

export function isValidPartialDate(date: string): boolean {
  return FULL.test(date) || MONTH.test(date) || YEAR.test(date);
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Render a partial date at exactly the precision the source gave. */
export function formatPartialDate(date: string | null): string {
  if (!date) return 'Date unknown';
  const full = FULL.exec(date);
  if (full) {
    const [, y, m, d] = full;
    const monthName = MONTH_NAMES[Number(m) - 1] ?? m;
    return `${Number(d)} ${monthName} ${y}`;
  }
  const month = MONTH.exec(date);
  if (month) {
    const [, y, m] = month;
    return `${MONTH_NAMES[Number(m) - 1] ?? m} ${y}`;
  }
  if (YEAR.test(date)) return date;
  return date;
}

/**
 * Order events chronologically, oldest first, with undated events last.
 * Ties break on kind (origin before reporting before rebuttal) then description,
 * so ordering is stable across runs.
 */
const KIND_ORDER: Record<TimelineEvent['kind'], number> = {
  origin: 0,
  report: 1,
  amplification: 2,
  analysis: 3,
  rebuttal: 4,
  correction: 5,
};

export function orderTimeline(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    const ka = dateSortKey(a.date);
    const kb = dateSortKey(b.date);
    if (ka !== kb) return ka < kb ? -1 : 1;
    const oa = KIND_ORDER[a.kind];
    const ob = KIND_ORDER[b.kind];
    if (oa !== ob) return oa - ob;
    return a.description.localeCompare(b.description);
  });
}

/**
 * Chronological impossibilities.
 *
 * The only sound test is dependency, not document kind: if event B draws on
 * event A, B cannot predate A. Comparing by kind alone produces false positives
 * the moment an investigation has more than one independent origin — a second
 * family's origin document legitimately postdates the first family's coverage.
 */
export interface TimelineConflict {
  /** The event that is dated too early. */
  earlierId: string;
  /** The event it depends on, which is dated later. */
  laterId: string;
  detail: string;
  /** Other events with the same dependency that are also out of order. */
  alsoAffectedIds: string[];
}

/** True when `dependent` draws on `antecedent`. */
export type DependencyTest = (dependent: TimelineEvent, antecedent: TimelineEvent) => boolean;

/**
 * One conflict per antecedent, not one per pair.
 *
 * A single mis-dated origin puts *every* event that draws on it out of order.
 * Reporting that as twenty findings would bury the one fact that matters, so
 * the antecedent is named once and the events it affects are counted.
 */
export function findTimelineConflicts(events: TimelineEvent[], dependsOn: DependencyTest): TimelineConflict[] {
  const datable = events.filter((e) => e.date !== null && !e.approximate);
  const conflicts: TimelineConflict[] = [];

  for (const antecedent of datable) {
    const violating = datable
      .filter((e) => e.id !== antecedent.id && dependsOn(e, antecedent) && dateSortKey(e.date) < dateSortKey(antecedent.date))
      .sort((a, b) => dateSortKey(a.date).localeCompare(dateSortKey(b.date)));
    const earliest = violating[0];
    if (!earliest) continue;
    const others = violating.slice(1);
    conflicts.push({
      earlierId: earliest.id,
      laterId: antecedent.id,
      alsoAffectedIds: others.map((e) => e.id),
      detail:
        `"${earliest.description}" (${formatPartialDate(earliest.date)}) is dated before "${antecedent.description}" (${formatPartialDate(antecedent.date)}), which it draws on.` +
        (others.length > 0
          ? ` ${others.length} further event${others.length === 1 ? '' : 's'} in this investigation ${others.length === 1 ? 'is' : 'are'} affected by the same inconsistency.`
          : ''),
    });
  }

  return conflicts;
}
