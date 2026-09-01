import Link from 'next/link';
import { Wordmark } from '@/components/landing/wordmark';

export default function NotFound(): React.ReactElement {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-2xl flex-col items-start justify-center gap-5 px-6">
      <Wordmark />
      <h1 className="text-2xl font-semibold tracking-tight text-ink">That case does not exist.</h1>
      <p className="text-sm leading-relaxed text-dim">
        Investigations are stored locally. If the server restarted while using the in-memory store, or the
        case file was removed, the case is gone.
      </p>
      <Link href="/" className="text-sm text-signal hover:underline">
        Start a new investigation
      </Link>
    </div>
  );
}
