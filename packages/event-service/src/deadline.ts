/**
 * Thrown when a {@link withDeadline}-wrapped request exceeds its time budget.
 * The caller must treat the outcome as uncertain: the server may have accepted
 * the request after the client gave up. Callers must reconcile before retry.
 */
export class RequestDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`Request timed out after ${deadlineMs}ms`);
    this.name = 'RequestDeadlineError';
  }
}

/**
 * Deadline for control-plane requests: tRPC, Kilo Chat non-send HTTP calls,
 * and Event Service connection-ticket fetches.
 */
export const CONTROL_PLANE_DEADLINE_MS = 15_000;

/**
 * Deadline for Kilo Chat message send (`POST /v1/messages`) only.
 * Longer than the control-plane deadline because the server may be
 * busy with agent processing and the outcome is always uncertain
 * for timed-out sends.
 */
export const SEND_DEADLINE_MS = 30_000;

/**
 * Run `fn` with a deadline. If the deadline expires before `fn` settles,
 * the returned promise rejects with a {@link RequestDeadlineError}.
 *
 * This helper is safe for Hermes (React Native). It uses `setTimeout` and
 * manual `AbortController` forwarding; it never calls `AbortSignal.timeout`
 * or `AbortSignal.any`, which are absent on Hermes.
 *
 * When `callerSignal` is provided, an abort on the caller signal forwards
 * to the deadline controller. Caller abort wins: the returned promise
 * rejects with `callerSignal.reason` instead of a deadline error.
 *
 * The outer promise settles independently of the inner `fn` result. On
 * Hermes, `whatwg-fetch` rejects with a generic `AbortError` after abort,
 * discarding `signal.reason`. This helper preserves the correct error type
 * (deadline or caller reason) regardless of what `fn` rejects.
 *
 * Cleanup (timer clear, listener removal) runs in a `finally` block so
 * the deadline is always disarmed after the promise settles.
 */
export function withDeadline<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  callerSignal?: AbortSignal
): Promise<T> {
  const controller = new AbortController();
  let settled = false;
  let timer!: ReturnType<typeof setTimeout>;
  let onCallerAbort: (() => void) | undefined;

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the outer promise first, then abort the inner controller.
      // This preserves the deadline error even when fn's fetch discards
      // signal.reason (Hermes whatwg-fetch).
      if (!settled) {
        settled = true;
        reject(new RequestDeadlineError(timeoutMs));
      }
      controller.abort(new RequestDeadlineError(timeoutMs));
    }, timeoutMs);

    onCallerAbort = () => {
      // Settle the outer promise first, then abort the inner controller.
      // This preserves the caller's reason even when fn's fetch discards
      // signal.reason (Hermes whatwg-fetch).
      if (!settled) {
        settled = true;
        reject(callerSignal?.reason);
      }
      controller.abort(callerSignal?.reason);
    };

    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer);
        // Already-aborted: reject immediately, never call fn.
        reject(callerSignal.reason);
        settled = true;
        controller.abort(callerSignal.reason);
        return;
      }
      callerSignal.addEventListener('abort', onCallerAbort);
    }

    fn(controller.signal).then(
      value => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      },
      reason => {
        // Forward inner rejection only when neither timer nor caller abort
        // has settled the outer promise yet.
        if (!settled) {
          settled = true;
          reject(reason);
        }
      }
    );
  }).finally(() => {
    clearTimeout(timer);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener('abort', onCallerAbort);
    }
  });
}
