import Link from 'next/link';
import type { Metadata } from 'next';
import { Wordmark } from '@/components/landing/wordmark';
import { Badge, Panel } from '@/components/ui/primitives';
import { getStore } from '@/core/store';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Case history — ProofHound' };

export default async function InvestigationsPage(): Promise<React.ReactElement> {
  const store = getStore();
  const rows = await store.list(50);

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-20 sm:px-6">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 py-5">
        <Link href="/" className="rounded">
          <Wordmark />
        </Link>
        <span aria-hidden className="text-faint">
          /
        </span>
        <span className="ph-label">Case history</span>
      </header>

      <main id="main">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Case history</h1>
        <p className="mt-2 text-sm leading-relaxed text-dim">
          Investigations run on this machine.{' '}
          {store.name === 'memory'
            ? 'This deployment uses the in-memory store, so cases are lost when the server restarts.'
            : 'Cases are stored as JSON files under .data/ and survive a restart.'}
        </p>

        {rows.length === 0 ? (
          <Panel className="mt-6 px-4 py-8 text-center">
            <p className="text-sm text-faint">No investigations yet.</p>
            <Link href="/" className="mt-3 inline-block text-sm text-signal hover:underline">
              Investigate a claim
            </Link>
          </Panel>
        ) : (
          <ul className="mt-6 space-y-2">
            {rows.map((row) => (
              <li key={row.id}>
                <Link href={`/investigations/${row.id}`} className="block rounded-[10px]">
                  <Panel className="px-4 py-3.5 transition-colors hover:border-line-strong">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="signal">{row.category}</Badge>
                      {row.isDemonstration ? <Badge tone="brass">Demonstration</Badge> : null}
                      <span className="ml-auto font-mono text-[11px] tabular-nums text-faint">
                        {new Date(row.createdAt).toISOString().slice(0, 16).replace('T', ' ')}
                      </span>
                    </div>
                    <p className="mt-2 text-sm leading-snug text-ink">{row.claim}</p>
                    <p className="mt-1.5 font-mono text-[11px] tabular-nums text-faint">
                      {row.sourceCount} sources → {row.familyCount} independent famil
                      {row.familyCount === 1 ? 'y' : 'ies'} · evidence strength {row.score}/100
                    </p>
                  </Panel>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
