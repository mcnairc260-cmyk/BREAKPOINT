'use client';

import * as React from 'react';
import type { Investigation } from '@/core/types';
import { Badge, InfoTip, Section } from '@/components/ui/primitives';
import { EpistemicBadge } from '@/components/workspace/shared';
import { humanize } from '@/lib/utils';

/**
 * What is actually being claimed.
 *
 * The card separates the claim from the framing around it and states its
 * epistemic category up front, because most disagreements about "is this true"
 * turn out to be disagreements about what was asserted.
 */
export function ClaimCard({ investigation }: { investigation: Investigation }): React.ReactElement {
  const { claim, entities, status, sources } = investigation;
  const topEntities = entities.slice(0, 8);

  return (
    <Section id="claim" index="01" title="Claim">
      <div className="px-4 py-4 sm:px-5">
        <p className="text-pretty text-lg leading-snug text-ink sm:text-xl">{claim.normalized}</p>

        <div className="mt-3.5 flex flex-wrap items-center gap-2">
          <Badge tone="signal">{claim.category}</Badge>
          <EpistemicBadge status={claim.epistemicStatus} />
          <Badge tone="neutral">{humanize(status)}</Badge>
          <InfoTip label="What the epistemic label means">
            ProofHound separates a FACT (established by evidence) from a CLAIM (asserted), an ALLEGATION, an
            INTERPRETATION, SPECULATION and an UNVERIFIED REPORT. A statement is never moved up this ladder
            without evidence that justifies the move.
          </InfoTip>
        </div>

        {claim.rawInput !== claim.normalized ? (
          <details className="mt-4 text-sm">
            <summary className="ph-note cursor-pointer py-1 hover:text-signal">
              As submitted
            </summary>
            <p className="mt-2 border-l-2 border-line pl-3 text-sm leading-relaxed text-dim">{claim.rawInput}</p>
          </details>
        ) : null}

        {claim.assertions.length > 1 ? (
          <div className="mt-4">
            <p className="ph-label">Separate assertions that must each hold</p>
            <ol className="mt-2 space-y-1.5">
              {claim.assertions.map((assertion, index) => (
                <li key={assertion} className="flex gap-2.5 text-sm leading-relaxed text-dim">
                  <span className="font-mono text-xs text-brass-dim">{index + 1}</span>
                  <span>{assertion}</span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}
      </div>

      {(topEntities.length > 0 || claim.referencedDates.length > 0) && sources.length > 0 ? (
        <div className="grid gap-4 border-t border-line px-4 py-4 sm:grid-cols-2 sm:px-5">
          {topEntities.length > 0 ? (
            <div>
              <p className="ph-label">Entities</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {topEntities.map((entity) => (
                  <li key={entity.id}>
                    <Badge tone="neutral" title={entity.role}>
                      {entity.name}
                      <span className="text-faint">· {entity.kind}</span>
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {claim.referencedDates.length > 0 ? (
            <div>
              <p className="ph-label">Dates referenced in the claim</p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {claim.referencedDates.map((date) => (
                  <li key={date}>
                    <Badge tone="neutral">{date}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
