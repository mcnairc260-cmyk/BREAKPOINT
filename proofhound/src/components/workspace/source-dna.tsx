'use client';

import * as React from 'react';
import type { Investigation, Source, SourceFamily } from '@/core/types';
import { Badge, InfoTip, Section, Stat } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';
import { independenceTone, sourceDate, sourceLabel } from '@/components/workspace/shared';
import { independenceForDepth } from '@/core/pipeline/lineage';

/**
 * Source DNA — the product's centre of gravity.
 *
 * The headline is one comparison: how many sources appear to exist, against how
 * many independent origins they actually reduce to. Below it, each family is
 * drawn as a descent from its origin, indented by distance, so repetition is
 * visible as shape rather than as a number the reader has to trust.
 */
export function SourceDNA({
  investigation,
  selectedSourceId,
  onSelectSource,
}: {
  investigation: Investigation;
  selectedSourceId: string | null;
  onSelectSource: (id: string) => void;
}): React.ReactElement {
  const { lineage, sources } = investigation;
  const byId = React.useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);
  const collapsed = lineage.totalSources - lineage.independentFamilyCount;

  return (
    <Section
      id="source-dna"
      index="02"
      title="Source DNA"
      subtitle="Where the sources actually come from"
    >
      <div className="border-b border-line px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-end gap-x-10 gap-y-5">
          <Stat label="Sources found" value={lineage.totalSources} />
          <div aria-hidden className="hidden self-center pb-1 font-mono text-lg text-faint sm:block">
            →
          </div>
          <Stat
            label="Independent source families"
            value={lineage.independentFamilyCount}
            tone="brass"
            hint={
              collapsed > 0
                ? `${collapsed} of the sources add no independent information.`
                : 'Every source is its own origin.'
            }
          />
          {lineage.circularCitationCount > 0 ? (
            <Stat
              label="Circular citation loops"
              value={lineage.circularCitationCount}
              tone="signal"
              hint="Sources citing each other in a loop, with no origin outside it."
            />
          ) : null}
        </div>

        {lineage.totalSources > 0 ? (
          <FamilyProportionBar families={lineage.families} total={lineage.totalSources} />
        ) : null}
      </div>

      {lineage.families.length === 0 ? (
        <p className="px-4 py-6 text-sm text-faint sm:px-5">
          No sources were retrieved, so there is no lineage to trace.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {lineage.families.map((family, index) => (
            <FamilyBlock
              key={family.id}
              family={family}
              index={index}
              byId={byId}
              depths={lineage.depthBySourceId}
              selectedSourceId={selectedSourceId}
              onSelectSource={onSelectSource}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

/** One bar, segmented by family size — how much of the coverage each origin owns. */
function FamilyProportionBar({ families, total }: { families: SourceFamily[]; total: number }): React.ReactElement {
  const palette = ['bg-brass', 'bg-signal', 'bg-derived', 'bg-supports', 'bg-neutral'];
  return (
    <div className="mt-5">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-line" role="img"
        aria-label={families
          .map((f) => `${f.label}: ${f.memberSourceIds.length} of ${total} sources`)
          .join('; ')}
      >
        {families.map((family, index) => (
          <div
            key={family.id}
            className={cn(palette[index % palette.length], 'h-full')}
            style={{ width: `${(family.memberSourceIds.length / total) * 100}%` }}
          />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {families.map((family, index) => (
          <li key={family.id} className="flex items-center gap-1.5 text-[11px] text-dim">
            <span aria-hidden className={cn('h-2 w-2 rounded-full', palette[index % palette.length])} />
            <span className="truncate">{family.label}</span>
            <span className="font-mono tabular-nums text-faint">{family.memberSourceIds.length}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FamilyBlock({
  family,
  index,
  byId,
  depths,
  selectedSourceId,
  onSelectSource,
}: {
  family: SourceFamily;
  index: number;
  byId: Map<string, Source>;
  depths: Record<string, number>;
  selectedSourceId: string | null;
  onSelectSource: (id: string) => void;
}): React.ReactElement {
  const members = family.memberSourceIds
    .map((id) => byId.get(id))
    .filter((s): s is Source => Boolean(s))
    .sort((a, b) => (depths[a.id] ?? 0) - (depths[b.id] ?? 0) || a.id.localeCompare(b.id));

  return (
    <li className="px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="ph-label text-brass-dim">Family {String(index + 1).padStart(2, '0')}</span>
        <h3 className="text-sm font-medium text-ink">{family.label}</h3>
        <Badge tone="neutral">{family.memberSourceIds.length} sources</Badge>
        {family.circular ? <Badge tone="warn">Circular citation</Badge> : null}
        {family.carriesDirectEvidence ? (
          <Badge tone="signal">First-hand material</Badge>
        ) : (
          <Badge tone="derived">Repetition only</Badge>
        )}
      </div>

      <ol className="mt-3 space-y-px">
        {members.map((source) => {
          const depth = depths[source.id] ?? 0;
          const isOrigin = source.id === family.originSourceId;
          const selected = source.id === selectedSourceId;
          return (
            <li key={source.id} style={{ paddingLeft: `${Math.min(depth, 6) * 16}px` }}>
              <button
                type="button"
                onClick={() => onSelectSource(source.id)}
                aria-pressed={selected}
                className={cn(
                  // min-h keeps the row a comfortable tap target on a phone,
                  // where these are the primary way into the source inspector.
                  'group flex min-h-[34px] w-full items-baseline gap-2 rounded px-2 py-2 text-left transition-colors',
                  selected ? 'bg-raised' : 'hover:bg-raised/60',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'mt-1 h-1.5 w-1.5 shrink-0 rounded-full',
                    isOrigin ? 'bg-brass' : depth === 1 ? 'bg-signal' : 'bg-derived/70',
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className={cn('truncate text-sm', isOrigin ? 'text-brass' : 'text-ink')}>
                      {sourceLabel(source)}
                    </span>
                    {isOrigin ? <Badge tone="brass">Origin</Badge> : null}
                    {source.retracted ? <Badge tone="contradicts">Retracted</Badge> : null}
                    {source.verification !== 'VERIFIED' ? (
                      <Badge tone="warn">{source.verification === 'INACCESSIBLE' ? 'Inaccessible' : 'Unverified'}</Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block truncate text-xs text-faint">{source.title}</span>
                </span>
                <span className="ml-auto hidden shrink-0 font-mono text-[11px] tabular-nums text-faint sm:block">
                  {sourceDate(source)}
                </span>
                <span className="hidden shrink-0 sm:block">
                  <Badge tone={independenceTone(independenceForDepth(depth))}>
                    {depth === 0 ? 'origin' : `${depth} hop${depth === 1 ? '' : 's'}`}
                  </Badge>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {family.depth >= 2 ? (
        <p className="mt-2.5 flex items-start gap-2 text-xs leading-relaxed text-faint">
          <InfoTip label="What the chain depth means">
            Depth is the number of citation hops from the family origin. A source five hops down has passed
            through five retellings, and typically adds no information the origin did not already contain.
          </InfoTip>
          <span>
            Deepest chain in this family: {family.depth} hop{family.depth === 1 ? '' : 's'} from the origin.
          </span>
        </p>
      ) : null}
    </li>
  );
}
