import { DrainSessionError, type DrainSessionErrorKind } from './kilo-api.js';

export const DRAIN_TRANSIENT_FAILURE_LIMIT = 3;
const DRAIN_BACKOFF_MS = [1_000, 2_000] as const;
const DRAIN_SLOW_FAILURE_MS = 30_000;

export type DrainWaitResult =
  | { readonly state: 'drained' }
  | { readonly state: 'cancelled' }
  | {
      readonly state: 'failed';
      readonly reason: string;
      readonly kind: DrainSessionErrorKind;
      readonly exhaustedTransient: boolean;
    };

export type DrainWaiter = {
  readonly active: boolean;
  start(): Promise<DrainWaitResult>;
  cancel(): void;
};

function classifyDrainFailure(error: unknown): { kind: DrainSessionErrorKind; reason: string } {
  if (error instanceof DrainSessionError) {
    if (error.message === 'Session drain returned false') {
      return { kind: 'anomalous', reason: error.message };
    }
    const reason = error.message.startsWith('Session drain failed:')
      ? error.message
      : `Session drain failed: ${error.message}`;
    return { kind: error.kind, reason };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { kind: 'unclassified', reason: `Session drain failed: ${message}` };
}

/**
 * One logical drain operation: a settled transient is retried inside the
 * waiter, so its backoff occupies the same slot as the in-flight request.
 */
export function createDrainWaiter(drain: (signal: AbortSignal) => Promise<boolean>): DrainWaiter {
  let generation = 0;
  let active = false;
  let current: Promise<DrainWaitResult> | null = null;
  let settle: ((result: DrainWaitResult) => void) | null = null;
  let controller: AbortController | null = null;
  let backoff: ReturnType<typeof setTimeout> | null = null;
  let failureCount = 0;

  function clearBackoff(): void {
    if (backoff === null) return;
    clearTimeout(backoff);
    backoff = null;
  }

  function finish(result: DrainWaitResult): void {
    if (settle === null) return;
    const resolve = settle;
    settle = null;
    active = false;
    current = null;
    controller = null;
    clearBackoff();
    resolve(result);
  }

  async function attempt(op: number): Promise<void> {
    const attemptController = new AbortController();
    controller = attemptController;
    const startedAt = Date.now();
    let value: unknown;
    let failure: { kind: DrainSessionErrorKind; reason: string } | null = null;
    try {
      value = await drain(attemptController.signal);
    } catch (error) {
      failure = classifyDrainFailure(error);
    }
    if (attemptController.signal.aborted) {
      if (op === generation) finish({ state: 'cancelled' });
      return;
    }
    if (op !== generation) return;
    controller = null;
    if (failure) {
      if (failure.kind === 'transient') {
        failureCount = Date.now() - startedAt >= DRAIN_SLOW_FAILURE_MS ? 1 : failureCount + 1;
        if (failureCount < DRAIN_TRANSIENT_FAILURE_LIMIT) {
          const delay = DRAIN_BACKOFF_MS[failureCount - 1] ?? 0;
          backoff = setTimeout(() => {
            backoff = null;
            if (op === generation) void attempt(op);
          }, delay);
          return;
        }
        finish({
          state: 'failed',
          reason: failure.reason,
          kind: 'transient',
          exhaustedTransient: true,
        });
        return;
      }
      finish({
        state: 'failed',
        reason: failure.reason,
        kind: failure.kind,
        exhaustedTransient: false,
      });
      return;
    }
    if (value === false) {
      finish({
        state: 'failed',
        reason: 'Session drain returned false',
        kind: 'anomalous',
        exhaustedTransient: false,
      });
      return;
    }
    if (value !== true) {
      finish({
        state: 'failed',
        reason: 'Session drain failed: returned no boolean result',
        kind: 'anomalous',
        exhaustedTransient: false,
      });
      return;
    }
    failureCount = 0;
    finish({ state: 'drained' });
  }

  return {
    get active() {
      return active;
    },
    start(): Promise<DrainWaitResult> {
      if (current) return current;
      failureCount = 0;
      active = true;
      const op = generation;
      const promise = new Promise<DrainWaitResult>(resolve => {
        settle = resolve;
      });
      current = promise;
      void attempt(op);
      return promise;
    },
    cancel(): void {
      generation += 1;
      controller?.abort();
      controller = null;
      clearBackoff();
      failureCount = 0;
      finish({ state: 'cancelled' });
    },
  };
}
