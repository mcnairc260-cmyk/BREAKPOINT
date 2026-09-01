'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { StageRecord } from '@/core/types';
import { Button } from '@/components/ui/primitives';
import { cn } from '@/lib/utils';

const PLACEHOLDER =
  'A researcher claims a DNA sample from an unknown primate was independently verified by three laboratories.';

/**
 * The home input and the progress it shows.
 *
 * Progress comes from the pipeline itself over Server-Sent Events: a stage
 * appears once it has finished, with what it found. There is no percentage,
 * because the pipeline cannot know one — a moving bar would be decoration
 * pretending to be information.
 */
export function InvestigateForm({ demoId }: { demoId: string }): React.ReactElement {
  const router = useRouter();
  const [value, setValue] = React.useState('');
  const [stages, setStages] = React.useState<StageRecord[]>([]);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const run = React.useCallback(
    async (body: { input: string; demoId?: string }) => {
      setRunning(true);
      setError(null);
      setStages([]);
      try {
        const response = await fetch('/api/investigations', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok || !response.body) {
          const message = await response
            .json()
            .then((d: { error?: string }) => d.error)
            .catch(() => null);
          throw new Error(message ?? 'The investigation could not be started.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          buffer += decoder.decode(chunk, { stream: true });

          // SSE frames are separated by a blank line.
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';
          for (const frame of frames) {
            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!eventLine || !dataLine) continue;
            const event = eventLine.slice(7).trim();
            const data: unknown = JSON.parse(dataLine.slice(6));

            if (event === 'stage') {
              setStages((prev) => [...prev, data as StageRecord]);
            } else if (event === 'done') {
              router.push(`/investigations/${(data as { id: string }).id}`);
              return;
            } else if (event === 'error') {
              throw new Error((data as { message: string }).message);
            }
          }
        }
        throw new Error('The investigation ended without a result.');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Something went wrong.');
        setRunning(false);
      }
    },
    [router],
  );

  return (
    <div className="w-full">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!running) void run({ input: value });
        }}
        className="ph-panel overflow-hidden bg-panel/80 backdrop-blur-sm"
      >
        <label htmlFor="claim-input" className="sr-only">
          Investigate a claim
        </label>
        <textarea
          id="claim-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits; Shift+Enter adds a line, as in any composer.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              if (!running && value.trim().length >= 8) void run({ input: value });
            }
          }}
          rows={3}
          maxLength={4000}
          disabled={running}
          placeholder={PLACEHOLDER}
          aria-describedby="claim-input-help"
          className="block w-full resize-none bg-transparent px-4 py-4 text-[15px] leading-relaxed text-ink placeholder:text-faint/70 focus:outline-none disabled:opacity-60 sm:px-5 sm:text-base"
        />
        <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3 sm:px-5">
          <p id="claim-input-help" className="ph-note">
            Paste a claim, a question or a URL.
          </p>
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={running}
              onClick={() => void run({ input: '', demoId })}
            >
              View demo case
            </Button>
            <Button type="submit" variant="primary" disabled={running || value.trim().length < 8}>
              {running ? 'Investigating…' : 'Investigate'}
            </Button>
          </div>
        </div>
      </form>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-contradicts">
          {error}
        </p>
      ) : null}

      {running ? <StageTrace stages={stages} /> : null}
    </div>
  );
}

function StageTrace({ stages }: { stages: StageRecord[] }): React.ReactElement {
  return (
    <div className="ph-panel ph-rise mt-4 p-4 sm:p-5" aria-live="polite" aria-atomic="false">
      <p className="ph-label">Investigation in progress</p>
      <ol className="mt-3 space-y-1.5">
        {stages.map((stage) => (
          <li key={`${stage.id}-${stage.durationMs}`} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
            <span
              aria-hidden
              className={cn(
                'font-mono text-xs',
                stage.state === 'failed' ? 'text-contradicts' : 'text-supports',
              )}
            >
              {stage.state === 'failed' ? '✕' : '✓'}
            </span>
            <span className="text-ink">{stage.label}</span>
            <span className="text-xs text-faint">{stage.detail}</span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">{stage.durationMs}ms</span>
          </li>
        ))}
        <li className="flex items-baseline gap-3 text-sm text-faint">
          <span aria-hidden className="ph-pulse font-mono text-xs text-signal">
            ·
          </span>
          <span className="ph-pulse">Working…</span>
        </li>
      </ol>
    </div>
  );
}
