import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Probability Terminal',
  description:
    'Calibrated probabilities that BTC or ETH finishes above a price you choose, with every forecast scored against what actually happened.',
  icons: {
    // Without this the browser requests /favicon.ico on every page and logs a
    // console error when it is not there. An inline SVG costs nothing and keeps
    // the console clean — which matters, because the browser verification
    // treats any console error as a failure.
    icon: [
      {
        url:
          'data:image/svg+xml,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
              '<rect width="32" height="32" rx="7" fill="#08090c"/>' +
              '<circle cx="16" cy="16" r="5" fill="#7d97ff"/>' +
              '</svg>',
          ),
        type: 'image/svg+xml',
      },
    ],
  },
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
              {/* The full name does not fit beside three nav links on a 390px
                  phone — measured at 410px of content in 390px of viewport.
                  The short form is shown there instead. */}
              <span className="hidden text-[15px] font-semibold tracking-tight sm:inline">
                Probability Terminal
              </span>
              <span className="text-[15px] font-semibold tracking-tight sm:hidden">
                Terminal
              </span>
            </Link>
            <nav className="flex shrink-0 items-center gap-0.5 text-[13px] sm:gap-1">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="rounded-md px-2 py-1.5 text-muted transition-colors hover:bg-surface hover:text-ink sm:px-2.5"
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
