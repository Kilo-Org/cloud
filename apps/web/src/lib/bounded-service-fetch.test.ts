import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
// The client deadline this budget must stay under. Imported from source rather
// than restated so the two constants can never drift apart.
import { CONTROL_PLANE_DEADLINE_MS } from '../../../../packages/event-service/src/deadline';
import {
  CONTROL_PLANE_UPSTREAM_BUDGET_MS,
  ServiceFetchTimeoutError,
  fetchWithinBudget,
  readJsonWithinBudget,
  readTextWithinBudget,
} from './bounded-service-fetch';
import { CONTROL_PLANE_PROCEDURE_BUDGET_MS } from '@kilocode/web-shared/lib/trpc/control-plane-budget';

const ENDPOINT_WITH_QUERY =
  'https://ingest.example.com/api/sessions/active?session=query-secret&page=1';
const INTERNAL_SERVICE_TOKEN = 'internal-service-token-secret';

/** A fetch stand-in that never settles. */
function neverSettlingFetch() {
  return jest.fn<typeof fetch>(() => new Promise<Response>(() => {}));
}

describe('fetchWithinBudget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('the upstream budget is strictly under the client control-plane deadline', () => {
    expect(CONTROL_PLANE_UPSTREAM_BUDGET_MS).toBe(8_000);
    expect(CONTROL_PLANE_UPSTREAM_BUDGET_MS).toBeLessThan(CONTROL_PLANE_DEADLINE_MS);
  });

  test('the upstream budget fires before the control-plane procedure backstop', () => {
    expect(CONTROL_PLANE_UPSTREAM_BUDGET_MS).toBeLessThan(CONTROL_PLANE_PROCEDURE_BUDGET_MS);
  });

  test('rejects with ServiceFetchTimeoutError when the upstream never answers', async () => {
    const fetchMock = neverSettlingFetch();

    const result = fetchWithinBudget(ENDPOINT_WITH_QUERY, {}, { fetch: fetchMock });
    // Attach the handler before advancing timers so the rejection is never
    // unhandled.
    const outcome = result.catch((error: unknown) => error);

    let settledEarly = false;
    void outcome.then(() => {
      settledEarly = true;
    });

    await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS - 1);
    expect(settledEarly).toBe(false);

    await jest.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(ServiceFetchTimeoutError);
    expect((error as ServiceFetchTimeoutError).budgetMs).toBe(CONTROL_PLANE_UPSTREAM_BUDGET_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('a caller signal aborts first and preserves the caller reason', async () => {
    const fetchMock = jest.fn<typeof fetch>((_url, init) => {
      const composedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        composedSignal?.addEventListener('abort', () => reject(composedSignal.reason));
      });
    });

    const caller = new AbortController();
    const callerReason = new Error('caller cancelled');
    const result = fetchWithinBudget(
      ENDPOINT_WITH_QUERY,
      { signal: caller.signal },
      { fetch: fetchMock }
    );
    const outcome = result.catch((error: unknown) => error);

    caller.abort(callerReason);

    const error = await outcome;
    expect(error).toBe(callerReason);
    expect(error).not.toBeInstanceOf(ServiceFetchTimeoutError);

    // The budget timer is disarmed after the caller's abort, so waiting past
    // it can never turn the caller's reason into a timeout.
    await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS + 1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('passes a normal response through untouched', async () => {
    const response = new Response(JSON.stringify({ sessions: [] }), { status: 200 });
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response);

    const result = await fetchWithinBudget(
      ENDPOINT_WITH_QUERY,
      { method: 'POST', headers: { Authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}` } },
      { fetch: fetchMock }
    );

    // The same Response instance the upstream produced: no clone, no re-wrap.
    expect(result).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toBe(ENDPOINT_WITH_QUERY);
    const calledInit = call?.[1];
    expect(calledInit?.method).toBe('POST');
    // The Authorization header is forwarded to fetch (and never logged).
    expect(new Headers(calledInit?.headers).get('authorization')).toBe(
      `Bearer ${INTERNAL_SERVICE_TOKEN}`
    );
    // The composed signal is the private budget controller's.
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);
    // A settled call leaves no timer armed.
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the timeout error carries no query string and no token', async () => {
    // Emulates a fetch implementation that rejects with a URL-bearing error
    // once aborted — the abort-derived error must never surface.
    const fetchMock = jest.fn<typeof fetch>((_url, init) => {
      const composedSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        composedSignal?.addEventListener('abort', () =>
          reject(new Error(`fetch failed for ${ENDPOINT_WITH_QUERY}`))
        );
      });
    });

    const result = fetchWithinBudget(
      ENDPOINT_WITH_QUERY,
      { headers: { Authorization: `Bearer ${INTERNAL_SERVICE_TOKEN}` } },
      { fetch: fetchMock }
    );
    const outcome = result.catch((error: unknown) => error);

    await jest.advanceTimersByTimeAsync(CONTROL_PLANE_UPSTREAM_BUDGET_MS);

    const error = await outcome;
    expect(error).toBeInstanceOf(ServiceFetchTimeoutError);
    const rendered = [
      (error as Error).name,
      (error as Error).message,
      (error as Error).stack ?? '',
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ].join(' ');
    expect(rendered).not.toContain('query-secret');
    expect(rendered).not.toContain('?session=');
    expect(rendered).not.toContain(INTERNAL_SERVICE_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('readJsonWithinBudget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('reads a body the upstream delivers inside the remaining budget', async () => {
    const response = new Response(JSON.stringify({ sessions: [] }), { status: 200 });

    await expect(readJsonWithinBudget(response, 1_000)).resolves.toEqual({ sessions: [] });
    expect(jest.getTimerCount()).toBe(0);
  });

  test('cancels a real response body that never finishes', async () => {
    // A real `Response`, because the interesting state only a real body
    // produces is the one `response.json()` leaves behind: it locks the stream,
    // and a locked stream cannot be cancelled. The upstream here sends a
    // partial body and then stalls, so an expiry that did not cancel its own
    // reader would keep the transfer alive after the caller gave up.
    const cancel = jest.fn(async () => undefined);
    let bursts = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        bursts += 1;
        if (bursts === 1) {
          controller.enqueue(encoder.encode('{"sessions":'));
        }
      },
      cancel,
    });
    const response = new Response(stream, { status: 200 });

    const outcome = readJsonWithinBudget(response, 500).catch((error: unknown) => error);

    let settledEarly = false;
    void outcome.then(() => {
      settledEarly = true;
    });

    await jest.advanceTimersByTimeAsync(499);
    expect(settledEarly).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    const error = await outcome;
    expect(error).toBeInstanceOf(ServiceFetchTimeoutError);
    expect((error as ServiceFetchTimeoutError).budgetMs).toBe(500);
    // No separate total was given, so the error reports the same value twice.
    expect((error as ServiceFetchTimeoutError).totalBudgetMs).toBe(500);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('reports the read budget it was configured with, not only what the headers left', async () => {
    // A body read arms its timer with the remainder, which is often a few
    // hundred milliseconds. Logs and Sentry must still show the budget the read
    // was configured with, or a 4,500 ms read looks like a 120 ms one.
    const response = {
      json: () => new Promise<never>(() => {}),
      body: null,
    } as unknown as Response;

    const outcome = readJsonWithinBudget(response, 120, 4_500).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(120);

    const error = await outcome;
    expect(error).toBeInstanceOf(ServiceFetchTimeoutError);
    expect((error as ServiceFetchTimeoutError).budgetMs).toBe(120);
    expect((error as ServiceFetchTimeoutError).totalBudgetMs).toBe(4_500);
    expect((error as ServiceFetchTimeoutError).message).toContain('4500ms');
  });

  test('leaves a body a reader already holds alone', async () => {
    // Cancelling a locked stream throws, so a mid-read body is abandoned.
    const cancel = jest.fn(async () => undefined);
    const response = {
      json: () => new Promise<never>(() => {}),
      body: { locked: true, cancel },
    } as unknown as Response;

    const outcome = readJsonWithinBudget(response, 100).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(100);

    expect(await outcome).toBeInstanceOf(ServiceFetchTimeoutError);
    expect(cancel).not.toHaveBeenCalled();
  });

  test('a caller abort mid-body rejects with the caller reason and cancels the reader', async () => {
    const cancel = jest.fn(async () => undefined);
    let bursts = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        bursts += 1;
        if (bursts === 1) {
          controller.enqueue(encoder.encode('{"sessions":'));
        }
      },
      cancel,
    });
    const response = new Response(stream, { status: 200 });

    const caller = new AbortController();
    const callerReason = new Error('caller cancelled');
    const outcome = readJsonWithinBudget(response, 1_000, 1_000, caller.signal).catch(
      (error: unknown) => error
    );

    let settledEarly = false;
    void outcome.then(() => {
      settledEarly = true;
    });

    await jest.advanceTimersByTimeAsync(250);
    expect(settledEarly).toBe(false);
    expect(cancel).not.toHaveBeenCalled();

    caller.abort(callerReason);

    const error = await outcome;
    expect(error).toBe(callerReason);
    expect(error).not.toBeInstanceOf(ServiceFetchTimeoutError);
    expect(cancel).toHaveBeenCalledTimes(1);
    // The budget timer is disarmed, so waiting past it cannot turn the caller's
    // reason into a timeout.
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(settledEarly).toBe(true);
  });

  test('an already aborted caller signal rejects without reading the body', async () => {
    const json = jest.fn(async () => ({ approvalKey: null }));
    const cancel = jest.fn(async () => undefined);
    const response = {
      json,
      body: { locked: true, cancel },
    } as unknown as Response;

    const caller = new AbortController();
    const callerReason = new Error('caller cancelled');
    caller.abort(callerReason);

    await expect(readJsonWithinBudget(response, 1_000, 1_000, caller.signal)).rejects.toBe(
      callerReason
    );
    expect(json).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('readTextWithinBudget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('reads a text body to its end inside the remaining budget', async () => {
    const response = new Response('<html>upstream failed</html>', {
      status: 502,
      headers: { 'Content-Type': 'text/html' },
    });

    await expect(readTextWithinBudget(response, 1_000)).resolves.toBe(
      '<html>upstream failed</html>'
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  test('rejects with ServiceFetchTimeoutError when the budget is already spent', async () => {
    // A spent budget arms the timer with zero, so the expiry fires before any
    // body can arrive and the reader's cancel tears the stream down.
    const cancel = jest.fn(async () => undefined);
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        // Never enqueues: the transfer stays open like a stalled upstream.
      },
      cancel,
    });
    const response = new Response(stream, { status: 200 });

    const outcome = readTextWithinBudget(response, 0).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);

    const error = await outcome;
    expect(error).toBeInstanceOf(ServiceFetchTimeoutError);
    expect((error as ServiceFetchTimeoutError).budgetMs).toBe(0);
    expect((error as ServiceFetchTimeoutError).totalBudgetMs).toBe(0);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('stops collecting an owned body at maxChars and cancels the reader', async () => {
    // The upstream keeps an error page streaming after the excerpt is complete.
    // A read that ran to the end would buffer all of it; with a cap the loop
    // stops at the excerpt and cancels the reader it owns, so nothing is left
    // transferring.
    const cancel = jest.fn(async () => undefined);
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        // Five 100-character bursts; the cap is reached during the second.
        controller.enqueue(encoder.encode('z'.repeat(100)));
        if (pulls === 5) {
          controller.close();
        }
      },
      cancel,
    });
    const response = new Response(stream, { status: 502 });

    const text = await readTextWithinBudget(response, 1_000, 1_000, 200);

    expect(text).toBe('z'.repeat(200));
    // The reader was cancelled at the cap rather than read to the end, so the
    // remaining bursts were never pulled and the stream was torn down.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(pulls).toBeLessThan(5);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('slices a body it cannot take over to maxChars', async () => {
    // A locked body is read by the platform in full, so the cap is applied to
    // what `text()` already returned.
    const response = {
      text: async () => 'y'.repeat(500),
      body: { locked: true },
      bodyUsed: true,
    } as unknown as Response;

    await expect(readTextWithinBudget(response, 1_000, 1_000, 200)).resolves.toBe('y'.repeat(200));
  });

  test('a caller abort mid-body rejects with the caller reason and cancels the reader', async () => {
    const cancel = jest.fn(async () => undefined);
    let bursts = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        bursts += 1;
        if (bursts === 1) {
          controller.enqueue(encoder.encode('<html>upstream'));
        }
      },
      cancel,
    });
    const response = new Response(stream, { status: 502 });

    const caller = new AbortController();
    const callerReason = new Error('caller cancelled');
    const outcome = readTextWithinBudget(response, 1_000, 1_000, undefined, caller.signal).catch(
      (error: unknown) => error
    );

    await jest.advanceTimersByTimeAsync(250);
    expect(cancel).not.toHaveBeenCalled();

    caller.abort(callerReason);

    const error = await outcome;
    expect(error).toBe(callerReason);
    expect(error).not.toBeInstanceOf(ServiceFetchTimeoutError);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an already aborted caller signal rejects without reading the body', async () => {
    const text = jest.fn(async () => 'upstream failed');
    const cancel = jest.fn(async () => undefined);
    const response = { text, body: { locked: true, cancel } } as unknown as Response;

    const caller = new AbortController();
    const callerReason = new Error('caller cancelled');
    caller.abort(callerReason);

    await expect(
      readTextWithinBudget(response, 1_000, 1_000, undefined, caller.signal)
    ).rejects.toBe(callerReason);
    expect(text).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
