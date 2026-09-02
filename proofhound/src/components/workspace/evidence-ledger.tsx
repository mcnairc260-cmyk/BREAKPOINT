'use client';

import * as React from 'react';
import type { EvidenceItem, Investigation, Source, Stance } from '@/core/types';
import { Badge, Section } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import {
  DIRECTNESS_LABEL,
  QUALITY_LABEL,
  StanceBadge,
  independenceLabel,
  independenceShort,
  independenceTone,
  sourceDate,
  sourceLabel,
} from '@/components/workspace/shared';
import { humanize } from '@/lib/utils';

/**
 * The evidence ledger.
 *
 * One row per evidence item, not per source, because a single document can
 * carry material that cuts both ways — the demonstration preprint supports the
 * claim's premise and contradicts its conclusion, and a source-per-row table
 * would have to pick one and hide the other.
 *
 * A real table on desktop; stacked records on small screens, where a nine-column
 * table is unreadable however it is scrolled.
 */

type StanceFilter = Stance | 'all';
type IndependenceFilter = 'all' | 'origin' | 'derivative';

export function EvidenceLedger({
  investigation,
  onSelectSource,
}: {
  investigation: Investigation;
  onSelectSource: (id: string) => void;
}): React.ReactElement {
  const [stance, setStance] = React.useState<StanceFilter>('all');
  const [independence, setIndependence] = React.useState<IndependenceFilter>('all');
  const [primaryOnly, setPrimaryOnly] = React.useState(false);

  const sourceById = React.useMemo(
    () => new Map(investigation.sources.map((s) => [s.id, s])),
    [investigation.sources],
  );

  const rows = React.useMemo(
    () =>
      investigation.evidence
        .map((item) => ({ item, source: sourceById.get(item.sourceId) }))
        .filter((row): row is { item: EvidenceItem; source: Source } => Boolean(row.source))
        .filter((row) => (stance === 'all' ? true : row.item.stance === stance))
        .filter((row) =>
          independence === 'all'
            ? true
            : independence === 'origin'
              ? row.item.independence >= 0.99
              : row.item.independence < 0.99,
        )
        .filter((row) => (primaryOnly ? row.source.primaryOrSecondary === 'primary' : true))
        .sort((a, b) => b.item.independence - a.item.independence || a.source.id.localeCompare(b.source.id)),
    [investigation.evidence, sourceById, stance, independence, primaryOnly],
  );

  return (
    <Section
      id="ledger"
      index="04"
      title="Evidence Ledger"
      subtitle={`${rows.length} of ${investigation.evidence.length} items shown`}
    >
      {/* Scrolls sideways on a phone rather than wrapping each option onto its
          own line, which pushed the first record below the fold. */}
      <div className="ph-scroll flex items-center gap-x-5 gap-y-3 overflow-x-auto border-b border-line px-4 py-3 max-sm:[&>*]:shrink-0 sm:flex-wrap sm:px-5">
        <FilterGroup
          label="Stance"
          value={stance}
          onChange={setStance}
          options={[
            { value: 'all', label: 'All' },
            { value: 'supports', label: 'Supports' },
            { value: 'contradicts', label: 'Contradicts' },
            { value: 'neutral', label: 'Neutral' },
          ]}
        />
        <FilterGroup
          label="Independence"
          value={independence}
          onChange={setIndependence}
          options={[
            { value: 'all', label: 'All' },
            { value: 'origin', label: 'Origins only' },
            { value: 'derivative', label: 'Derivative only' },
          ]}
        />
        <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-dim">
          <input
            type="checkbox"
            checked={primaryOnly}
            onChange={(event) => setPrimaryOnly(event.target.checked)}
            className="h-3.5 w-3.5 accent-[color:var(--color-signal)]"
          />
          Primary sources only
        </label>
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-6 text-sm text-faint sm:px-5">
          {investigation.evidence.length === 0
            ? 'No evidence items were produced, because no sources were retrieved.'
            : 'No evidence items match these filters.'}
        </p>
      ) : (
        <>
          {/* Desktop table.
              `table-fixed` with an explicit colgroup, because auto layout gave
              the long title column everything and squeezed Notes down to a few
              characters, which turned every row into a column of single words. */}
          <div className="ph-scroll hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[980px] table-fixed border-collapse text-sm">
              <colgroup>
                <col className="w-[17%]" />
                <col className="w-[8%]" />
                <col className="w-[8%]" />
                <col className="w-[10%]" />
                <col className="w-[10%]" />
                <col className="w-[8%]" />
                <col className="w-[9%]" />
                <col className="w-[7%]" />
                <col className="w-[23%]" />
              </colgroup>
              <thead>
                <tr className="border-b border-line text-left">
                  {['Source', 'Type', 'Date', 'Stance', 'Independence', 'Reliability', 'Directness', 'Primary?', 'Notes'].map(
                    (heading) => (
                      <th
                        key={heading}
                        scope="col"
                        // Tighter tracking than a standalone label: these
                        // headings must fit their columns without truncating.
                        className="ph-label truncate px-3 py-2 font-normal tracking-[0.05em] first:pl-4 last:pr-4"
                        title={heading}
                      >
                        {heading}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, source }) => (
                  <tr key={item.id} className="border-b border-line/60 align-top last:border-0 hover:bg-raised/50">
                    <td className="px-3 py-2.5 pl-4">
                      <button
                        type="button"
                        onClick={() => onSelectSource(source.id)}
                        className="block w-full truncate text-left text-ink hover:text-signal"
                        title={sourceLabel(source)}
                      >
                        {sourceLabel(source)}
                      </button>
                      <span className="mt-0.5 block truncate text-xs text-faint" title={source.title}>
                        {source.title}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-dim">{humanize(source.sourceType)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs tabular-nums text-dim">
                      {source.publicationDate ?? '—'}
                    </td>
                    <td className="overflow-hidden px-3 py-2.5">
                      <StanceBadge stance={item.stance} />
                    </td>
                    <td className="overflow-hidden px-3 py-2.5">
                      <Badge tone={independenceTone(item.independence)} title={independenceLabel(item.independence)}>
                        {independenceShort(item.independence)}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-dim">
                      {source.reliabilityScore.toFixed(2)}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-dim">
                      {DIRECTNESS_LABEL[item.directness]}
                      <span className="block text-faint">{QUALITY_LABEL[item.quality]}</span>
                    </td>
                    <td className="px-3 py-2.5 text-xs text-dim">
                      {source.primaryOrSecondary === 'primary' ? 'Yes' : humanize(source.primaryOrSecondary)}
                    </td>
                    <td className="px-3 py-2.5 pr-4 text-xs leading-relaxed text-faint">
                      <span className="line-clamp-4" title={item.summary}>
                        {item.summary}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile / tablet records */}
          <ul className="divide-y divide-line lg:hidden">
            {rows.map(({ item, source }) => (
              <li key={item.id} className="px-4 py-3.5 sm:px-5">
                <button
                  type="button"
                  onClick={() => onSelectSource(source.id)}
                  className="text-left text-sm font-medium text-ink hover:text-signal"
                >
                  {sourceLabel(source)}
                </button>
                <p className="mt-0.5 text-xs leading-snug text-faint">{source.title}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <StanceBadge stance={item.stance} />
                  <Badge tone={independenceTone(item.independence)}>{independenceLabel(item.independence)}</Badge>
                  <Badge tone="neutral">{DIRECTNESS_LABEL[item.directness]}</Badge>
                  <Badge tone="neutral">{humanize(source.sourceType)}</Badge>
                  {source.primaryOrSecondary === 'primary' ? <Badge tone="signal">Primary</Badge> : null}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-dim">{item.summary}</p>
                <p className="mt-1.5 font-mono text-[11px] text-faint">
                  {sourceDate(source)} · reliability {source.reliabilityScore.toFixed(2)}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

function FilterGroup<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  options: Array<{ value: T; label: string }>;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-2">
      <span className="ph-label">{label}</span>
      <div role="group" aria-label={label} className="flex overflow-hidden rounded border border-line">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              'whitespace-nowrap px-2.5 py-1.5 text-xs transition-colors',
              value === option.value ? 'bg-raised text-ink' : 'text-faint hover:text-dim',
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}
