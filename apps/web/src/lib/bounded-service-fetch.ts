/**
 * Time budget for one internal-service (control-plane upstream) fetch.
 *
 * Strictly under the mobile control plane's `CONTROL_PLANE_DEADLINE_MS =
 * 15_000` (`packages/event-service/src/deadline.ts:17`): an upstream that never
 * answers must fail inside the app's window so the client renders its existing
 * retryable error state, instead of the call hanging until the app's deadline
 * fires (or the gateway answers 504). This is a missing bound being added, not
 * a timeout being widened.
 */
export const CONTROL_PLANE_UPSTREAM_BUDGET_MS = 8_000;

/**
 * Raised when an internal-service fetch does not settle inside its budget.
 *
 * Carries only budgets: the request URL (and its query string), the
 * `Authorization` header and the internal-service token are never attached to
 * this error or written to a log.
 */
export class ServiceFetchTimeoutError extends Error {
  /** Time the timed phase had left when it expired. */
  readonly budgetMs: number;

  /**
   * Budget the phase was configured with. Equal to {@link budgetMs} unless the
   * phase had already spent part of its budget before the timed operation
   * started — a body read arms its timer with what the headers left, so
   * reporting `budgetMs` alone would show a few milliseconds instead of the
   * read's actual budget in logs and Sentry.
   */
  readonly totalBudgetMs: number;

  constructor(budgetMs: number, totalBudgetMs: number = budgetMs) {
    super(`Internal service did not respond within ${totalBudgetMs}ms`);
    this.name = 'ServiceFetchTimeoutError';
    this.budgetMs = budgetMs;
    this.totalBudgetMs = totalBudgetMs;
  }
}

export type FetchWithinBudgetDeps = {
  /** Injectable for tests; defaults to the ambient `fetch`. */
  fetch?: typeof fetch;
  /**
   * Tightens {@link CONTROL_PLANE_UPSTREAM_BUDGET_MS} for a caller that shares
   * one answer's budget between several phases, so this fetch cannot spend all
   * of it. Tests also use it to shorten the budget.
   */
  budgetMs?: number;
};

/**
 * `fetch` an internal service under a time budget.
 *
 * Composes `init.signal` with a private `AbortController` armed for the budget,
 * so an upstream that never answers aborts and rejects with
 * {@link ServiceFetchTimeoutError} rather than holding the caller open. A
 * caller abort wins: when `init.signal` aborts first the rejection is the
 * caller's `reason`, never a timeout.
 *
 * The upstream `Response` is returned untouched. Nothing here logs or attaches
 * the URL's query string, the `Authorization` header, or the internal-service
 * token.
 */
export async function fetchWithinBudget(
  url: string,
  init: RequestInit = {},
  deps: FetchWithinBudgetDeps = {}
): Promise<Response> {
  const fetchImpl = deps.fetch ?? fetch;
  const budgetMs = deps.budgetMs ?? CONTROL_PLANE_UPSTREAM_BUDGET_MS;
  const callerSignal = init.signal ?? undefined;

  const controller = new AbortController();
  let settled = false;
  let timer!: ReturnType<typeof setTimeout>;
  let onCallerAbort: (() => void) | undefined;

  return new Promise<Response>((resolve, reject) => {
    timer = setTimeout(() => {
      // Settle the outer promise first, then abort the inner controller: this
      // preserves the timeout error even when a fetch implementation discards
      // `signal.reason` on abort.
      if (!settled) {
        settled = true;
        reject(new ServiceFetchTimeoutError(budgetMs));
      }
      controller.abort();
    }, budgetMs);

    onCallerAbort = () => {
      if (!settled) {
        settled = true;
        reject(callerSignal?.reason);
      }
      controller.abort(callerSignal?.reason);
    };

    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer);
        settled = true;
        controller.abort(callerSignal.reason);
        reject(callerSignal.reason);
        return;
      }
      callerSignal.addEventListener('abort', onCallerAbort);
    }

    fetchImpl(url, { ...init, signal: controller.signal }).then(
      response => {
        if (!settled) {
          settled = true;
          resolve(response);
        }
      },
      error => {
        if (!settled) {
          settled = true;
          reject(error);
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

/**
 * Read a bounded fetch's JSON body inside the budget the fetch already spent
 * part of.
 *
 * {@link fetchWithinBudget} settles as soon as the upstream answers with its
 * headers and then disarms its timer, so an upstream that accepts the
 * connection and stalls the body would hold the caller open with no bound at
 * all. The body is therefore read under what is left of the budget and the read
 * is abandoned when that runs out, rejecting with the same
 * {@link ServiceFetchTimeoutError} the fetch raises so one caller handles both.
 *
 * The read goes through a reader this function owns rather than
 * `response.json()`. `json()` locks the body stream for the whole read, and a
 * locked stream cannot be cancelled, so an expired read of a real `Response`
 * would leave the abandoned body being buffered for as long as the upstream
 * kept trickling it. Cancelling a reader we hold tears the stream down and ends
 * the transfer.
 *
 * `remainingBudgetMs` is what the headers left; `totalBudgetMs` is the budget
 * this read was configured with, and it is the value the timeout error reports
 * so logs and Sentry show the configured budget instead of the few milliseconds
 * that were left when the body started.
 *
 * The reader, the timer and the cancellation are shared with
 * {@link readTextWithinBudget} through {@link readBodyWithinBudget}, which
 * only looks at the parse and at how an untakeable body is read. A body that
 * arrived but is not JSON rejects with `SyntaxError` while every transport
 * failure keeps rejecting with {@link ServiceFetchTimeoutError} or the
 * underlying stream error.
 *
 * A body this function cannot take over — one without a stream, or one a
 * reader already holds — is read with `response.json()`, which is what the
 * callers of a JSON reader hand in.
 */
export async function readJsonWithinBudget<T = unknown>(
  response: Response,
  remainingBudgetMs: number,
  totalBudgetMs: number = remainingBudgetMs
): Promise<T> {
  return readBodyWithinBudget(
    response,
    remainingBudgetMs,
    totalBudgetMs,
    body => body.json() as Promise<T>,
    text => JSON.parse(text) as T
  );
}

/**
 * Read a bounded fetch's body to its end as text, under the same budget rule as
 * {@link readJsonWithinBudget}.
 *
 * {@link fetchWithinBudget} settles as soon as the upstream answers with its
 * headers and then disarms its timer, so an upstream that accepts the
 * connection and stalls the body would hold the caller open with no bound at
 * all. The body is therefore read under what is left of the budget and the read
 * is abandoned when that runs out, rejecting with the same
 * {@link ServiceFetchTimeoutError} the fetch raises so one caller handles both.
 *
 * The read goes through a reader this function owns rather than
 * `response.text()`. `text()` locks the body stream for the whole read, and a
 * locked stream cannot be cancelled, so an expired read of a real `Response`
 * would leave the abandoned body being buffered for as long as the upstream
 * kept trickling it. Cancelling a reader we hold tears the stream down and ends
 * the transfer.
 *
 * `remainingBudgetMs` is what the headers left; `totalBudgetMs` is the budget
 * this read was configured with, and it is the value the timeout error reports
 * so logs and Sentry show the configured budget instead of the few milliseconds
 * that were left when the body started.
 */
export async function readTextWithinBudget(
  response: Response,
  remainingBudgetMs: number,
  totalBudgetMs: number = remainingBudgetMs
): Promise<string> {
  return readBodyWithinBudget(
    response,
    remainingBudgetMs,
    totalBudgetMs,
    body => body.text(),
    text => text
  );
}

/**
 * Read a bounded fetch's body inside what is left of a budget, sharing the
 * reader/timer/cancel machinery between {@link readJsonWithinBudget} and
 * {@link readTextWithinBudget}.
 *
 * The reader is taken only when the body is one this function can own: a body
 * another reader already holds, or a `Response` without a stream, cannot be
 * taken over, so the wait is still bounded there but the cancellation is out of
 * reach. `readFallback` is how each public reader reads such a body, and
 * `parseText` turns what an owned reader collected into that reader's result,
 * so the parse stays on the reader's side of the race and cannot be reported as
 * a timeout.
 *
 * `remainingBudgetMs` is what the headers left; `totalBudgetMs` is the budget
 * this read was configured with, and it is the value the timeout error reports
 * so logs and Sentry show the configured budget instead of the few milliseconds
 * that were left when the body started.
 */
async function readBodyWithinBudget<T>(
  response: Response,
  remainingBudgetMs: number,
  totalBudgetMs: number,
  readFallback: (response: Response) => Promise<T>,
  parseText: (text: string) => T
): Promise<T> {
  const budgetError = new ServiceFetchTimeoutError(remainingBudgetMs, totalBudgetMs);
  const expired = Promise.withResolvers<never>();
  // A body another reader already holds cannot be taken over; the wait is
  // still bounded, only the cancellation is out of reach.
  const body = response.body;
  const reader = body && !body.locked && !response.bodyUsed ? body.getReader() : undefined;
  const timer = setTimeout(
    () => {
      if (reader) {
        void reader.cancel().catch(() => undefined);
      }
      expired.reject(budgetError);
    },
    Math.max(0, remainingBudgetMs)
  );

  try {
    if (!reader) {
      return await Promise.race([readFallback(response), expired.promise]);
    }
    return parseText(await Promise.race([readAllText(reader), expired.promise]));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read a streamed body to its end as text. Cancellation belongs to the caller:
 * the reader it passed in is the only thing that can end a stalled transfer.
 */
async function readAllText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(decoder.decode(value, { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join('');
}
