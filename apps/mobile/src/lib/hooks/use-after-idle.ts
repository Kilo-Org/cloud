import { useEffect, useState } from 'react';

export const AFTER_IDLE_FALLBACK_MS = 500;

/** Defer mount-time work until JS is idle, with a bounded wait. */
export function useAfterIdle(): boolean {
  const [afterIdle, setAfterIdle] = useState(false);

  useEffect(() => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      setAfterIdle(true);
    };

    const handle = requestIdleCallback(settle);
    const fallback = setTimeout(settle, AFTER_IDLE_FALLBACK_MS);
    return () => {
      settled = true;
      cancelIdleCallback(handle);
      clearTimeout(fallback);
    };
  }, []);

  return afterIdle;
}
