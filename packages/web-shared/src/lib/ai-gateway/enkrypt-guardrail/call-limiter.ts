import type { EnkryptScanKind } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/report';

/**
 * The most Enkrypt calls one gateway request has in flight at once, across the input guardrail's
 * blocking and log-only scans of every part and tool definition, retries included.
 */
export const ENKRYPT_MAX_CONCURRENT_CALLS = 4;

/** Frees the slot. Calling it again does nothing. */
export type EnkryptCallSlot = () => void;

export type EnkryptCallLimiter = {
  /**
   * Waits for a free slot. Blocking calls are granted slots before log-only calls, and calls of the
   * same priority in the order they asked. Resolves null, without a slot, when `signal` aborts
   * first.
   */
  acquire(priority: EnkryptScanKind, signal: AbortSignal): Promise<EnkryptCallSlot | null>;
};

export function createEnkryptCallLimiter(
  maxConcurrent: number = ENKRYPT_MAX_CONCURRENT_CALLS
): EnkryptCallLimiter {
  let active = 0;
  const waiting: Record<EnkryptScanKind, (() => void)[]> = { blocking: [], log_only: [] };

  const slot = (): EnkryptCallSlot => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      active--;
      grant();
    };
  };

  const grant = () => {
    while (active < maxConcurrent) {
      const next = waiting.blocking.shift() ?? waiting.log_only.shift();
      if (!next) return;
      active++;
      next();
    }
  };

  return {
    acquire(priority, signal) {
      if (signal.aborted) return Promise.resolve(null);
      const queue = waiting[priority];
      return new Promise(resolve => {
        const onAbort = () => {
          const index = queue.indexOf(granted);
          if (index !== -1) queue.splice(index, 1);
          resolve(null);
        };
        const granted = () => {
          signal.removeEventListener('abort', onAbort);
          resolve(slot());
        };
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(granted);
        grant();
      });
    },
  };
}
