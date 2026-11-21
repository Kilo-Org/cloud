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
 */

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
    answered.resolve({
      status: xhr.status,
      ok: xhr.status >= 200 && xhr.status < 300,
      retryAfter: xhr.getResponseHeader('retry-after'),
      text: budgetMs => readBody(xhr, budgetMs),
    });
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- one owner for the pre-head failure
  xhr.onerror = () => {
    answered.reject(new Error('refresh request failed'));
  };

  xhr.open('POST', url);
  xhr.setRequestHeader('Content-Type', 'application/json');
  xhr.send(body);
  return answered.promise;
}

/** The `fetch` route, for a runtime without `XMLHttpRequest` (a Node test worker). */
async function viaFetch({ url, body, signal }: RefreshRequest): Promise<RefreshAnswer> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal,
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
