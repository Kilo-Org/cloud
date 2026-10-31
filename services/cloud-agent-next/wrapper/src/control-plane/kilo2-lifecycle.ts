import { withTimeoutAndAbort } from '../utils.js';

/** One native process's in-flight cancellation requests and their event acknowledgements. */
export function createKilo2Lifecycle() {
  const pending = new Map<
    string,
    { work: Promise<boolean>; closed: ReturnType<typeof Promise.withResolvers<void>> }
  >();
  return {
    interrupt(
      sessionId: string,
      signal: AbortSignal,
      operation: (waitForClose: () => Promise<void>) => Promise<boolean>
    ): Promise<boolean> {
      const existing = pending.get(sessionId);
      if (existing) return existing.work;
      const closed = Promise.withResolvers<void>();
      const work = Promise.resolve()
        .then(() =>
          operation(() =>
            withTimeoutAndAbort(closed.promise, {
              signal,
              timeoutMs: 10_000,
              timeoutMessage: 'Kilo v2 interruption event timed out',
              abortMessage: 'Kilo v2 interruption cancelled',
            })
          )
        )
        .finally(() => {
          if (pending.get(sessionId)?.work === work) pending.delete(sessionId);
        });
      pending.set(sessionId, { work, closed });
      return work;
    },
    async waitForInterrupt(sessionId: string, signal?: AbortSignal) {
      const current = pending.get(sessionId);
      if (current && !(await current.work))
        throw new Error('Kilo v2 interruption was not confirmed');
      signal?.throwIfAborted();
    },
    closed(sessionId: string) {
      pending.get(sessionId)?.closed.resolve();
    },
  };
}
export type Kilo2Lifecycle = ReturnType<typeof createKilo2Lifecycle>;
