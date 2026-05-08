/**
 * fetch() wrapper that aborts the request if the upstream does not respond
 * within `timeoutMs`. The timer is cleared as soon as the response headers
 * have been received; the response body may still be read after that.
 *
 * Callers that already pass their own `init.signal` have their signal
 * respected — the upstream is aborted when EITHER signal fires. `AbortSignal.any`
 * is used when available; a manual fan-in is used on older runtimes.
 */

export class FetchTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Upstream fetch timed out after ${timeoutMs}ms`);
    this.name = 'FetchTimeoutError';
  }
}

export async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

  const signal = combineSignals(init.signal, timeoutController.signal);

  try {
    return await fetchImpl(url, { ...init, signal });
  } catch (err) {
    if (timeoutController.signal.aborted) {
      throw new FetchTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function combineSignals(caller: AbortSignal | null | undefined, timeout: AbortSignal): AbortSignal {
  if (!caller) return timeout;

  const anyFactory = (AbortSignal as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFactory === 'function') {
    return anyFactory([caller, timeout]);
  }

  const combined = new AbortController();
  const abortCombined = (reason: unknown): void => combined.abort(reason);
  if (caller.aborted) {
    combined.abort(caller.reason);
  } else {
    caller.addEventListener('abort', () => abortCombined(caller.reason), { once: true });
  }
  if (timeout.aborted) {
    combined.abort(timeout.reason);
  } else {
    timeout.addEventListener('abort', () => abortCombined(timeout.reason), { once: true });
  }
  return combined.signal;
}
