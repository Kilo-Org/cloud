import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
// The client deadline this budget must stay under. Imported from source rather
// than restated so the two constants can never drift apart.
import { CONTROL_PLANE_DEADLINE_MS } from '../../../../packages/event-service/src/deadline';
import {
  CONTROL_PLANE_UPSTREAM_BUDGET_MS,
  ServiceFetchTimeoutError,
  fetchWithinBudget,
} from './bounded-service-fetch';

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
