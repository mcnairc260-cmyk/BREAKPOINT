import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Probability Terminal',
  description:
    'Calibrated probabilities that BTC or ETH finishes above a price you choose, with every forecast scored against what actually happened.',
};

export const viewport: Viewport = {
  themeColor: '#08090c',
  width: 'device-width',
  initialScale: 1,
  // The target price field is the one input on the page. Letting the viewport
  // zoom when it receives focus on iOS throws the layout around exactly when
  // the user is trying to type a number, so the base font size is kept at 16px
  // instead of locking scale — accessible and stable.
  maximumScale: 5,
};

const NAV = [
  { href: '/', label: 'Forecast' },
  { href: '/history', label: 'History' },
  { href: '/performance', label: 'Performance' },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">
        <div className="mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-4 pb-16 sm:px-6">
          <header className="flex items-center justify-between gap-4 py-5">
            <Link href="/" className="group flex items-center gap-2.5">
              <span className="grid h-7 w-7 place-items-center rounded-md border border-line-bright bg-surface-2">
                <span className="h-2 w-2 rounded-full bg-accent" />
              </span>
              <span className="text-[15px] font-semibold tracking-tight">
                Probability Terminal
              </span>
            </Link>
            <nav className="flex items-center gap-1 text-[13px]">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2.5 py-1.5 text-muted transition-colors hover:bg-surface hover:text-ink"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </header>
          <main className="flex-1">{children}</main>
          <footer className="mt-12 border-t border-line pt-5 text-[12px] leading-relaxed text-faint">
            <p>
              Probability estimates, not predictions. Every forecast is recorded before its
              outcome is knowable and scored automatically afterwards — the Performance page
              shows whether the stated probabilities have matched reality.
            </p>
            <p className="mt-1.5">Not investment advice. No forecast here is a recommendation to trade.</p>
          </footer>
        </div>
      </body>
    </html>
  );
}
