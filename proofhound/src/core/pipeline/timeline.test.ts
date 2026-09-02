import { describe, expect, it } from 'vitest';
import {
  dateSortKey,
  findTimelineConflicts,
  formatPartialDate,
  isValidPartialDate,
  orderTimeline,
} from '@/core/pipeline/timeline';
import { makeEvent } from '@/core/test-support';

describe('dateSortKey', () => {
  it('sorts a partial date at the start of the period it names', () => {
    expect(dateSortKey('2024')).toBe('2024-00-00');
    expect(dateSortKey('2024-03')).toBe('2024-03-00');
    expect(dateSortKey('2024-03-15')).toBe('2024-03-15');
  });

  it('sorts undated and unparseable values last', () => {
    expect(dateSortKey(null)).toBe('9999-99-99');
    expect(dateSortKey('sometime in the spring')).toBe('9999-99-99');
  });
});

describe('formatPartialDate', () => {
  it('renders at exactly the precision given', () => {
    expect(formatPartialDate('2024-03-15')).toBe('15 March 2024');
    expect(formatPartialDate('2024-03')).toBe('March 2024');
    expect(formatPartialDate('2024')).toBe('2024');
    expect(formatPartialDate(null)).toBe('Date unknown');
  });
});

describe('isValidPartialDate', () => {
  it('accepts year, year-month and full dates only', () => {
    expect(isValidPartialDate('2024')).toBe(true);
    expect(isValidPartialDate('2024-03')).toBe(true);
    expect(isValidPartialDate('2024-03-15')).toBe(true);
    expect(isValidPartialDate('March 2024')).toBe(false);
  });
});

describe('orderTimeline', () => {
  it('orders oldest first with undated events last', () => {
    const ordered = orderTimeline([
      makeEvent({ id: 'undated' }),
      makeEvent({ id: 'late', date: '2024-06-01' }),
      makeEvent({ id: 'early', date: '2023' }),
      makeEvent({ id: 'middle', date: '2024-02' }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(['early', 'middle', 'late', 'undated']);
  });

  it('breaks ties by kind so an origin precedes the reporting of it', () => {
    const ordered = orderTimeline([
      makeEvent({ id: 'report', date: '2024-01-01', kind: 'report' }),
      makeEvent({ id: 'origin', date: '2024-01-01', kind: 'origin' }),
    ]);
    expect(ordered.map((e) => e.id)).toEqual(['origin', 'report']);
  });

  it('does not mutate its input', () => {
    const input = [makeEvent({ id: 'b', date: '2024-02' }), makeEvent({ id: 'a', date: '2024-01' })];
    orderTimeline(input);
    expect(input.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('findTimelineConflicts', () => {
  const dependsOnFirst = (dependent: { id: string }, antecedent: { id: string }): boolean =>
    dependent.id !== antecedent.id && antecedent.id === 'origin';

  it('flags an event dated before the thing it draws on', () => {
    const conflicts = findTimelineConflicts(
      [
        makeEvent({ id: 'origin', date: '2024-05-02' }),
        makeEvent({ id: 'citing', date: '2024-02-11' }),
      ],
      dependsOnFirst,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.earlierId).toBe('citing');
    expect(conflicts[0]?.laterId).toBe('origin');
  });

  it('reports one conflict per antecedent rather than one per pair', () => {
    const conflicts = findTimelineConflicts(
      [
        makeEvent({ id: 'origin', date: '2024-05-02' }),
        makeEvent({ id: 'c1', date: '2024-02-11' }),
        makeEvent({ id: 'c2', date: '2024-03-01' }),
        makeEvent({ id: 'c3', date: '2024-04-01' }),
      ],
      dependsOnFirst,
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.earlierId).toBe('c1');
    expect(conflicts[0]?.alsoAffectedIds).toEqual(['c2', 'c3']);
    expect(conflicts[0]?.detail).toContain('2 further events');
  });

  it('does not flag independent events that merely happen to be out of order', () => {
    const conflicts = findTimelineConflicts(
      [makeEvent({ id: 'a', date: '2024-05-02' }), makeEvent({ id: 'b', date: '2024-02-11' })],
      () => false,
    );
    expect(conflicts).toEqual([]);
  });

  it('ignores approximate and undated events, which cannot be out of order', () => {
    const conflicts = findTimelineConflicts(
      [
        makeEvent({ id: 'origin', date: '2024-05-02' }),
        makeEvent({ id: 'approx', date: '2024-02', approximate: true }),
        makeEvent({ id: 'undated' }),
      ],
      dependsOnFirst,
    );
    expect(conflicts).toEqual([]);
  });
});
