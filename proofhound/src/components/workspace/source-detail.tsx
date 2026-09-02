'use client';

import * as React from 'react';
import type { Investigation } from '@/core/types';
import { Badge, Button, Panel } from '@/components/ui/primitives';
import { humanize } from '@/lib/utils';
import {
  DIRECTNESS_LABEL,
  QUALITY_LABEL,
  SourceLink,
  StanceBadge,
  VerificationBadge,
  independenceLabel,
  independenceTone,
  sourceDate,
  sourceLabel,
} from '@/components/workspace/shared';
import { ancestryChain, independenceForDepth } from '@/core/pipeline/lineage';

/**
 * The inspector for one source.
 *
 * The ancestry chain is the part that matters: it answers "where did this
 * actually come from" in one glance, which is the question the rest of the
 * product exists to make askable.
 */
export function SourceDetail({
  investigation,
  sourceId,
  onClose,
  onSelectSource,
}: {
  investigation: Investigation;
  sourceId: string;
  onClose: () => void;
  onSelectSource: (id: string) => void;
}): React.ReactElement | null {
  const source = investigation.sources.find((s) => s.id === sourceId);
  const byId = React.useMemo(
    () => new Map(investigation.sources.map((s) => [s.id, s])),
    [investigation.sources],
  );

  if (!source) return null;

  const depth = investigation.lineage.depthBySourceId[source.id] ?? 0;
  const family = investigation.lineage.families.find((f) => f.memberSourceIds.includes(source.id));
  const chain = ancestryChain(source.id, investigation.sources);
  const evidence = investigation.evidence.filter((e) => e.sourceId === source.id);
  const children = investigation.sources.filter((s) => s.parentSourceIds.includes(source.id));

  return (
    <Panel className="overflow-hidden">
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <p className="ph-label">Source detail</p>
          <h2 className="mt-1 truncate text-sm font-semibold text-ink">{sourceLabel(source)}</h2>
        </div>
        <Button variant="ghost" className="shrink-0 px-2 py-1 text-xs" onClick={onClose} aria-label="Close source detail">
          Close
        </Button>
      </header>

      <div className="ph-scroll max-h-[70vh] overflow-y-auto">
        <div className="px-4 py-4 sm:px-5">
          <p className="text-sm leading-snug text-ink">{source.title}</p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            <Badge tone="neutral">{humanize(source.sourceType)}</Badge>
            <Badge tone={source.primaryOrSecondary === 'primary' ? 'signal' : 'neutral'}>
              {humanize(source.primaryOrSecondary)}
            </Badge>
            <Badge tone={independenceTone(independenceForDepth(depth))}>
              {independenceLabel(independenceForDepth(depth))}
            </Badge>
            <VerificationBadge state={source.verification} />
            {source.retracted ? <Badge tone="contradicts">Retracted</Badge> : null}
            {source.anonymousAttribution ? <Badge tone="warn">Anonymous attribution</Badge> : null}
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
            <Field label="Published" value={sourceDate(source)} />
            <Field label="Author" value={source.author ?? 'Not stated'} />
            <Field label="Reliability" value={source.reliabilityScore.toFixed(2)} />
            <Field label="Source family" value={family?.label ?? 'None'} />
          </dl>

          {source.url ? (
            <div className="mt-4">
              <p className="ph-label">Location</p>
              <div className="mt-1">
                <SourceLink source={source} />
              </div>
            </div>
          ) : null}

          {source.notes ? (
            <div className="mt-4">
              <p className="ph-label">Notes</p>
              <p className="mt-1 text-xs leading-relaxed text-dim">{source.notes}</p>
            </div>
          ) : null}
        </div>

        {chain.length > 1 ? (
          <div className="border-t border-line px-4 py-4 sm:px-5">
            <p className="ph-label">Where this came from</p>
            <ol className="mt-2.5 space-y-1">
              {chain.map((id, index) => {
                const step = byId.get(id);
                if (!step) return null;
                const isSelf = index === 0;
                return (
                  <li key={id} style={{ paddingLeft: `${index * 12}px` }} className="flex items-baseline gap-2">
                    <span aria-hidden className="font-mono text-[10px] text-faint">
                      {index === 0 ? '•' : '↳'}
                    </span>
                    <button
                      type="button"
                      disabled={isSelf}
                      onClick={() => onSelectSource(id)}
                      className="truncate text-left text-xs text-dim enabled:hover:text-signal disabled:text-ink"
                    >
                      {sourceLabel(step)}
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="mt-2 text-[11px] leading-relaxed text-faint">
              {depth === 0
                ? 'This is the origin of its source family.'
                : `${depth} citation hop${depth === 1 ? '' : 's'} from the origin of its family.`}
            </p>
          </div>
        ) : null}

        {children.length > 0 ? (
          <div className="border-t border-line px-4 py-4 sm:px-5">
            <p className="ph-label">Sources that draw on this one</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {children.map((child) => (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => onSelectSource(child.id)}
                    className="rounded border border-line px-1.5 py-0.5 text-[11px] text-dim transition-colors hover:border-signal hover:text-signal"
                  >
                    {sourceLabel(child)}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {evidence.length > 0 ? (
          <div className="border-t border-line px-4 py-4 sm:px-5">
            <p className="ph-label">Evidence from this source</p>
            <ul className="mt-2.5 space-y-3">
              {evidence.map((item) => (
                <li key={item.id}>
                  <div className="flex flex-wrap gap-1.5">
                    <StanceBadge stance={item.stance} />
                    <Badge tone="neutral">{humanize(item.evidenceType)}</Badge>
                    <Badge tone="neutral">
                      {DIRECTNESS_LABEL[item.directness]} · {QUALITY_LABEL[item.quality]}
                    </Badge>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-dim">{item.summary}</p>
                  {item.excerpt ? (
                    <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-xs italic leading-relaxed text-faint">
                      {item.excerpt}
                    </blockquote>
                  ) : (
                    <p className="mt-1.5 text-[11px] text-faint">
                      No verbatim excerpt was retrieved for this item.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {source.citations.length > 0 ? (
          <div className="border-t border-line px-4 py-4 sm:px-5">
            <p className="ph-label">Citations declared by this source</p>
            <ul className="mt-2 space-y-1.5">
              {source.citations.map((citation) => (
                <li key={citation.text} className="text-xs leading-relaxed text-dim">
                  {citation.text}{' '}
                  {citation.resolvedSourceId ? (
                    <Badge tone="signal">Resolved</Badge>
                  ) : (
                    <Badge tone="warn">Not retrievable</Badge>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function Field({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="min-w-0">
      <dt className="ph-label">{label}</dt>
      <dd className="mt-0.5 truncate text-dim" title={value}>
        {value}
      </dd>
    </div>
  );
}
