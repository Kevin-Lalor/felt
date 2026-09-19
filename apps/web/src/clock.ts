import { useEffect, useState } from 'react';

/** Ticks while a deadline is live so a countdown can re-render, and stops when
 *  nobody is on the clock. The deadline is wall-clock ms from the server, so a
 *  client with a skewed clock sees a skewed countdown — acceptable for a
 *  display, and the server's timer is the one that actually acts. */
export function useCountdown(deadline: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline === null) return null;
  return Math.max(0, deadline - now);
}

/** 18500 → "0:18" */
export function formatClock(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
