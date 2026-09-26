'use client';

import { useEffect, useState } from 'react';
import { formatCountdown } from '@/core/format';

/**
 * Time until a forecast can be scored.
 *
 * Counts down from a fixed expiry timestamp rather than decrementing a number,
 * so a backgrounded tab or a sleeping phone resumes with the correct value
 * instead of however far it got before being suspended.
 */
export function Countdown({ expiresAt, className }: { expiresAt: string; className?: string }) {
  const target = new Date(expiresAt).getTime();
  const [remaining, setRemaining] = useState(() => (target - Date.now()) / 1000);

  useEffect(() => {
    const tick = () => setRemaining((target - Date.now()) / 1000);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [target]);

  const expired = remaining <= 0;
  return (
    <span className={className}>
      <span className="tnum">{formatCountdown(remaining)}</span>
      {!expired ? <span className="ml-1 text-faint">to go</span> : null}
    </span>
  );
}
