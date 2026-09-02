'use client';

import * as React from 'react';
import type { Contradiction, Investigation, MissingEvidenceItem, TimelineEvent } from '@/core/types';
import { Badge, Section } from '@/components/ui/primitives';
import { cn, humanize } from '@/lib/utils';
import { formatPartialDate } from '@/core/pipeline/timeline';
import { sourceLabel } from '@/components/workspace/shared';

/**
 * Contradictions, evidence gaps and chronology.
 *
 * Negative findings are given the same visual weight as positive ones and are
 * never collapsed behind a toggle — a fact-checking tool that hides its
 * disconfirming evidence is doing the opposite of its job.
 */

const SEVERITY_TONE = { decisive: 'contradicts', material: 'warn', minor: 'neutral' } as const;

export function Contradictions({
  investigation,
  onSelectSource,
}: {
  investigation: Investigation;
  onSelectSource: (id: string) => void;
}): React.ReactElement {
  const { contradictions, sources } = investigation;
  const byId = React.useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  return (
    <Section
      id="contradictions"
      index="05"
      title="Contradictions"
      subtitle={contradictions.length > 0 ? `${contradictions.length} recorded` : undefined}
    >
      {contradictions.length === 0 ? (
        <p className="px-4 py-6 text-sm leading-relaxed text-faint sm:px-5">
          No contradiction was detected in the retrieved record. That is not the same as there being none —
          it means nothing in what was retrieved conflicts with the claim.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {contradictions.map((contradiction: Contradiction) => (
            <li key={contradiction.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEVERITY_TONE[contradiction.severity]}>{contradiction.severity}</Badge>
                <Badge tone="neutral">{humanize(contradiction.kind)}</Badge>
              </div>
              <p className="mt-2 text-sm leading-snug text-ink">{contradiction.summary}</p>
              <p className="mt-1.5 text-xs leading-relaxed text-dim">{contradiction.detail}</p>
              {contradiction.sourceIds.length > 0 ? (
                <ul className="mt-2.5 flex flex-wrap gap-1.5">
                  {contradiction.sourceIds.slice(0, 6).map((id) => {
                    const source = byId.get(id);
                    if (!source) return null;
                    return (
                      <li key={id}>
                        <button
                          type="button"
                          onClick={() => onSelectSource(id)}
                          className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-faint transition-colors hover:border-signal hover:text-signal"
                        >
                          {sourceLabel(source)}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const IMPACT_TONE = { decisive: 'brass', high: 'signal', moderate: 'neutral' } as const;

export function MissingEvidence({ items }: { items: MissingEvidenceItem[] }): React.ReactElement {
  return (
    <Section
      id="missing-evidence"
      index="06"
      title="Missing Evidence"
      subtitle="What would materially strengthen or weaken this case"
    >
      {items.length === 0 ? (
        <p className="px-4 py-6 text-sm text-faint sm:px-5">No material gap was identified.</p>
      ) : (
        <ul className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-baseline gap-2">
                <Badge tone={IMPACT_TONE[item.impact]}>{item.impact}</Badge>
                <h3 className="text-sm font-medium text-ink">{item.title}</h3>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-dim">{item.why}</p>
              <p className="mt-2 flex gap-2 text-xs leading-relaxed text-faint">
                <span className="ph-label mt-px shrink-0">How</span>
                <span>{item.howToObtain}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

const KIND_TONE: Record<TimelineEvent['kind'], 'brass' | 'signal' | 'derived' | 'contradicts' | 'neutral'> = {
  origin: 'brass',
  report: 'neutral',
  amplification: 'derived',
  analysis: 'signal',
  rebuttal: 'contradicts',
  correction: 'contradicts',
};

export function Timeline({
  investigation,
  onSelectSource,
}: {
  investigation: Investigation;
  onSelectSource: (id: string) => void;
}): React.ReactElement {
  const { timeline, sources } = investigation;
  const byId = React.useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  return (
    <Section id="timeline" index="07" title="Timeline" subtitle={`${timeline.length} events`}>
      {timeline.length === 0 ? (
        <p className="px-4 py-6 text-sm text-faint sm:px-5">No dated events could be established.</p>
      ) : (
        <ol className="px-4 py-4 sm:px-5">
          {timeline.map((event, index) => (
            <li key={event.id} className="relative flex gap-4 pb-5 last:pb-0">
              {index < timeline.length - 1 ? (
                <span aria-hidden className="absolute left-[5px] top-3 h-full w-px bg-line" />
              ) : null}
              <span
                aria-hidden
                className={cn(
                  'relative mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ring-4 ring-[color:var(--color-panel)]',
                  event.kind === 'origin'
                    ? 'bg-brass'
                    : event.kind === 'rebuttal' || event.kind === 'correction'
                      ? 'bg-contradicts'
                      : event.kind === 'amplification'
                        ? 'bg-derived'
                        : 'bg-neutral',
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="font-mono text-xs tabular-nums text-dim">
                    {formatPartialDate(event.date)}
                    {event.approximate && event.date ? ' (approx.)' : ''}
                  </span>
                  <Badge tone={KIND_TONE[event.kind]}>{event.kind}</Badge>
                  {event.confidence === 'LOW' ? <Badge tone="warn">Low confidence</Badge> : null}
                </div>
                <p className="mt-1 text-sm leading-snug text-ink">{event.description}</p>
                {event.sourceIds.length > 0 ? (
                  <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                    {event.sourceIds.map((id) => {
                      const source = byId.get(id);
                      if (!source) return null;
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            onClick={() => onSelectSource(id)}
                            className="font-mono text-[11px] text-faint transition-colors hover:text-signal"
                          >
                            {sourceLabel(source)}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

export function InvestigationSummaryPanel({ investigation }: { investigation: Investigation }): React.ReactElement {
  const { summary } = investigation;
  const rows: Array<{ label: string; body: React.ReactNode }> = [
    { label: 'Strongest supporting evidence', body: summary.strongestSupport },
    { label: 'Strongest contradictory evidence', body: summary.strongestContradiction },
    { label: 'Source independence', body: summary.independenceAssessment },
    {
      label: 'Major uncertainties',
      body: (
        <ul className="space-y-1.5">
          {summary.uncertainties.map((item) => (
            <li key={item} className="flex gap-2">
              <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-faint" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ),
    },
    { label: 'Best next research step', body: summary.bestNextStep },
  ];

  return (
    <Section id="summary" index="08" title="Investigation Summary">
      <p className="border-b border-line bg-raised/40 px-4 py-4 text-sm leading-relaxed text-ink sm:px-5">
        {summary.bottomLine}
      </p>
      <dl className="divide-y divide-line">
        {rows.map((row) => (
          <div key={row.label} className="px-4 py-3.5 sm:px-5">
            <dt className="ph-label">{row.label}</dt>
            <dd className="mt-1.5 text-sm leading-relaxed text-dim">{row.body}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
