import type { Metadata, Viewport } from 'next';
import { TooltipProvider } from '@/components/ui/primitives';
import './globals.css';

export const metadata: Metadata = {
  title: 'ProofHound — Trace claims back to the evidence',
  description:
    'Investigate viral claims, uncover circular sourcing, map contradictions, and see exactly how strong the evidence really is.',
  applicationName: 'ProofHound',
};

export const viewport: Viewport = {
  themeColor: '#06080c',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-brass focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-void"
        >
          Skip to content
        </a>
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
