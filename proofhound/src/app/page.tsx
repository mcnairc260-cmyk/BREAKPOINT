import Link from 'next/link';
import { InvestigateForm } from '@/components/landing/investigate-form';
import { Wordmark } from '@/components/landing/wordmark';
import { Badge, Panel } from '@/components/ui/primitives';
import { FEATURED_DEMO_ID } from '@/core/research';

const FEATURES = [
  {
    title: 'Source DNA',
    body: 'Discover when dozens of articles actually trace back to one source.',
    tone: 'brass' as const,
  },
  {
    title: 'Evidence Map',
    body: 'See people, documents, claims, and institutions as a connected investigation.',
    tone: 'signal' as const,
  },
  {
    title: 'Contradictions',
    body: 'Surface evidence that challenges the story instead of hiding it.',
    tone: 'contradicts' as const,
  },
  {
    title: 'Missing Evidence',
    body: 'Know exactly what would strengthen or weaken the case.',
    tone: 'derived' as const,
  },
];

/**
 * The landing page has one job: make the product's claim legible in about ten
 * seconds, then get out of the way of the input.
 */
export default function HomePage(): React.ReactElement {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <Link
          href="/investigations"
          className="ph-label -mx-2 inline-flex min-h-[32px] items-center px-2 transition-colors hover:text-signal focus-visible:text-signal"
        >
          Case history
        </Link>
      </header>

      <main id="main" className="flex flex-1 flex-col justify-center pb-16 pt-6 sm:pt-10">
        <div className="ph-rise">
          <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight text-ink sm:text-6xl">
            Trace claims back
            <br />
            to the evidence.
          </h1>
          <p className="mt-5 max-w-2xl text-pretty text-base leading-relaxed text-dim sm:text-lg">
            Investigate viral claims, uncover circular sourcing, map contradictions, and see exactly how strong
            the evidence really is.
          </p>
        </div>

        <div className="mt-8 sm:mt-10">
          <InvestigateForm demoId={FEATURED_DEMO_ID} />
        </div>

        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-faint">
          ProofHound reports the strength of the evidence it can find. It does not return a verdict, and it
          never shows a source it did not retrieve.
        </p>

        <ul className="mt-12 grid gap-3 sm:mt-16 sm:grid-cols-2">
          {FEATURES.map((feature) => (
            <li key={feature.title}>
              <Panel className="h-full p-4 sm:p-5">
                <Badge tone={feature.tone}>{feature.title}</Badge>
                <p className="mt-3 text-sm leading-relaxed text-dim">{feature.body}</p>
              </Panel>
            </li>
          ))}
        </ul>
      </main>

      <footer className="border-t border-line py-5 text-xs text-faint">
        <p>
          Built-in demonstration cases are fictional and labelled as such throughout. Live web research runs
          only when a search provider is configured.
        </p>
      </footer>
    </div>
  );
}
