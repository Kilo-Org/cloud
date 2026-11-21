/**
 * The transport for one refresh request.
 *
 * The refresh answer's status decides whether the session is over; its body
 * only enriches that answer — a 401 names the blocked-account copy, a 403 says
 * whether the refusal came from the route or an intermediary, and a 2xx carries
 * the new pair. None of that may depend on the body ever finishing, because a
 * body that stalls after its head must not turn a dead session into a retry.
 *
 * Both HTTP clients React Native offers settle only after the whole body: the
 * global `fetch` is `whatwg-fetch` (it resolves in `xhr.onload`), and
 * `expo/fetch` was measured to resolve at body completion too — a body written
 * twelve seconds after its head made that call resolve at twelve seconds. A
 * plain `XMLHttpRequest` is the one client that reports the head on its own, at
 * `readyState` 2, so the status is read there and any body is then read under a
 * budget of its own.
 *
 * React Native's XMLHttpRequest delivers its intermediate states only when an
 * `onreadystatechange` handler is assigned before `send()`; a listener added
 * with `addEventListener` does not switch that on. The handler assignment below
 * is therefore a correctness requirement, not a style choice.
 *
 * Because this module talks to the raw client, it owns the telemetry the
 * wrapped global `fetch` used to provide for this route
 * (`install-error-reporting.ts`): an error answer the app does not handle files
 * the process's event, and a request that got no response is reported as the
 * endpoint's `failed` outcome with the rejection attached. The policy itself
 * stays in `network-errors.ts`; only the call lives here.
 */

import { classifyAuthResponse } from '@/lib/auth/auth-response-class';
import {
  isExpectedHttpStatus,
  normalizeUrlPath,
  reportNetworkError,
} from '@/lib/telemetry/network-errors';

/** One refresh answer, available at the response head. */
export type RefreshAnswer = {
  readonly status: number;
  readonly ok: boolean;
  readonly retryAfter: string | null;
  /**
   * The body as text, waiting at most `budgetMs`. `null` when the body did not
   * arrive within that budget; the request is abandoned at that point.
   */
  text(budgetMs: number): Promise<string | null>;
  /**
   * Ends the exchange when its caller is done with it. A request whose status
   * the caller already used is released here rather than left holding the
   * connection and a socket for the life of the app.
   */
  release(): void;
};

export type RefreshRequest = {
  readonly url: string;
  readonly body: string;
  /** Aborts the request, e.g. when the caller's deadline expires. */
  readonly signal: AbortSignal;
};

const XHR_HEADERS_RECEIVED = 2;
const XHR_DONE = 4;

/** The body read for one answered request, settled once. */
function readBody(xhr: XMLHttpRequest, budgetMs: number): Promise<string | null> {
  const settled = Promise.withResolvers<string | null>();
  let done = false;
  const finish = (value: string | null): void => {
    if (done) {
      return;
    }
    done = true;
    clearTimeout(timer);
    // The body is abandoned: aborting releases the connection instead of
    // holding it for the life of the app.
    if (value === null) {
      xhr.abort();
    }
    settled.resolve(value);
  };
  const timer = setTimeout(() => {
    finish(null);
  }, budgetMs);
  if (xhr.readyState === XHR_DONE) {
    finish(xhr.responseText);
    return settled.promise;
  }
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- see the module comment: the completion handler is one owner
  xhr.onreadystatechange = () => {
    if (xhr.readyState === XHR_DONE) {
      finish(xhr.responseText);
    }
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- a failure has one owner, like the completion handler above
  xhr.onerror = () => {
    finish(null);
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- a timeout has one owner, like the completion handler above
  xhr.ontimeout = () => {
    finish(null);
  };
  return settled.promise;
}

/**
 * What one answered refresh request offers a report. The status decides whether
 * there is anything to report at all, so it is part of the descriptor rather
 * than a separate argument.
 */
type AnswerReport = {
  readonly url: string;
  readonly status: number;
  readonly statusText: string | undefined;
  /** When the request was sent, so the report's duration starts there. */
  readonly startedAt: number;
};

/**
 * Report one answered refresh request whose status names a defect. This mirrors
 * what the wrapped global `fetch` did for this route before the transport moved
 * to `XMLHttpRequest`, which had two halves:
 *
 * - an expected answer (`isExpectedHttpStatus`) is the app's own, so 401, 403
 *   and 429 record nothing; and
 * - a terminal refusal on a sign-in route is filed by the auth layer itself
 *   (`reportAuthTerminalFailure`), so the wrapper never filed it a second time.
 *
 * Both halves matter here: this route is a sign-in route, so a 400 is already
 * reported once by that layer and a second event would be a duplicate. What
 * remains reportable is the retryable family — a 408 and the 5xx statuses —
 * which is exactly `classifyAuthResponse` answering `retry`. The body is never
 * read for this.
 */
function reportErrorAnswer({ url, status, statusText, startedAt }: AnswerReport): void {
  if (status < 400 || isExpectedHttpStatus(status)) {
    return;
  }
  // The path only refines a 401 (does it clear the pair) and a 403 (came it from
  // the route), and both are expected answers filtered above, so no status that
  // reaches here classifies differently on any sign-in route.
  if (classifyAuthResponse({ path: normalizeUrlPath(url), status }).kind !== 'retry') {
    return;
  }
  reportNetworkError({
    source: 'fetch',
    url,
    method: 'POST',
    status,
    ...(statusText === undefined || statusText.length === 0 ? {} : { statusText }),
    durationMs: Date.now() - startedAt,
  });
}

/**
 * The `XMLHttpRequest` route. A Node test worker has no `XMLHttpRequest`, so it
 * takes the `fetch` route below and the suites that spy on `fetch` still see the
 * request; a device needs this one, because neither client it has reports the
 * head.
 */
function viaXhr(
  Xhr: typeof XMLHttpRequest,
  { url, body, signal }: RefreshRequest
): Promise<RefreshAnswer> {
  const answered = Promise.withResolvers<RefreshAnswer>();
  const xhr = new Xhr();
  let headSeen = false;
  let startedAt = 0;

  signal.addEventListener('abort', () => {
    xhr.abort();
    answered.reject(new Error('refresh request aborted'));
  });

  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- see the module comment: only an assigned handler turns on the intermediate states
  xhr.onreadystatechange = () => {
    if (headSeen || xhr.readyState !== XHR_HEADERS_RECEIVED) {
      return;
    }
    headSeen = true;
    reportErrorAnswer({ url, status: xhr.status, statusText: xhr.statusText, startedAt });
    answered.resolve({
      status: xhr.status,
      ok: xhr.status >= 200 && xhr.status < 300,
      retryAfter: xhr.getResponseHeader('retry-after'),
      text: budgetMs => readBody(xhr, budgetMs),
      release: () => {
        xhr.abort();
      },
    });
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- one owner for the pre-head failure
  xhr.onerror = () => {
    const error = new Error('refresh request failed');
    // An answer already reported at its head owns the exchange: a failure while
    // its body is read is the caller's `text()` returning null, which is what
    // the wrapped `fetch` left to the caller too, so it adds no second report.
    if (!headSeen) {
      reportNetworkError({
        source: 'fetch',
        url,
        method: 'POST',
        durationMs: Date.now() - startedAt,
        error,
      });
    }
    answered.reject(error);
  };

  xhr.open('POST', url);
  xhr.setRequestHeader('Content-Type', 'application/json');
  // The duration the report carries starts at the send, like the wrapped
  // `fetch` this route replaced measured it.
  startedAt = Date.now();
  xhr.send(body);
  return answered.promise;
}

/** The `fetch` route, for a runtime without `XMLHttpRequest` (a Node test worker). */
async function viaFetch({ url, body, signal }: RefreshRequest): Promise<RefreshAnswer> {
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
  }).catch((error: unknown) => {
    // The rejection still reaches the caller unchanged; the report records the
    // request as the endpoint's `failed` outcome, as the wrapped `fetch` did.
    reportNetworkError({
      source: 'fetch',
      url,
      method: 'POST',
      durationMs: Date.now() - startedAt,
      error,
    });
    throw error;
  });
  reportErrorAnswer({
    url,
    status: response.status,
    statusText: response.statusText,
    startedAt,
  });
  return {
    status: response.status,
    ok: response.ok,
    retryAfter: response.headers.get('retry-after'),
    text: async budgetMs => {
      const expiry = Promise.withResolvers<null>();
      const timer = setTimeout(() => {
        expiry.resolve(null);
      }, budgetMs);
      try {
        return await Promise.race([response.text(), expiry.promise]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    release: () => {
      // A resolved fetch body still holds the connection until it is read or
      // the response is discarded; the caller owns that decision.
      if (response.body !== null && !response.bodyUsed) {
        void response.body.cancel();
      }
    },
  };
}

/** The head-reporting client of this runtime, or undefined where only `fetch` exists (a Node test worker). */
function headReportingClient(): typeof XMLHttpRequest | undefined {
  // Read from the global object rather than the bare name: a runtime without
  // this client has no binding for it, and `globalThis` answers undefined.
  return globalThis.XMLHttpRequest;
}

export function sendRefreshRequest(request: RefreshRequest): Promise<RefreshAnswer> {
  const Xhr = headReportingClient();
  return Xhr === undefined ? viaFetch(request) : viaXhr(Xhr, request);
}
