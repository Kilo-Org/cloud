import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
// The client deadline and the upstream budget this one must stay between.
// Imported from source rather than restated so the constants can never drift.
import { CONTROL_PLANE_DEADLINE_MS, RequestDeadlineError } from '@kilocode/event-service';

import { CONTROL_PLANE_UPSTREAM_BUDGET_MS } from '@/lib/bounded-service-fetch';
import {
  CONTROL_PLANE_PROCEDURE_BUDGET_MS,
  controlPlanePathFromInfo,
  controlPlaneTypeFromInfo,
  withControlPlaneBudget,
} from './control-plane-budget';

const MOBILE_HEADERS = {
  'x-kilo-client': 'mobile',
  'x-kilo-app-platform': 'ios',
  'x-kilo-app-version': '1.2.3',
  'x-kilo-request-id': 'req-123',
};
const WEB_HEADERS = { 'x-kilo-client': 'web' };

function mobileHeaders(extra: Record<string, string> = {}): Headers {
  return new Headers({ ...MOBILE_HEADERS, ...extra });
}

/** A `next` stand-in that never settles. */
function neverSettlingNext() {
  return jest.fn<() => Promise<never>>(() => new Promise<never>(() => {}));
}

/** Drive a `withControlPlaneBudget` call to the deadline and return the error. */
async function runToDeadline(overrides: {
  path?: string;
  type?: 'query' | 'mutation' | 'subscription';
  headersList?: Headers | null;
  next: () => Promise<unknown>;
  startedAt?: number;
  surface?: 'procedure' | 'context';
}): Promise<unknown> {
  const outcome = withControlPlaneBudget({
    path: overrides.path ?? 'user.getMe',
    type: overrides.type ?? 'query',
    headersList: overrides.headersList ?? mobileHeaders(),
    next: overrides.next as () => Promise<never>,
    startedAt: overrides.startedAt,
    surface: overrides.surface,
  }).catch((error: unknown) => error);

  await jest.advanceTimersByTimeAsync(CONTROL_PLANE_PROCEDURE_BUDGET_MS);
  return outcome;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('the control-plane budgets', () => {
  test('the procedure budget is strictly under the client deadline, above the upstream budget', () => {
    expect(CONTROL_PLANE_PROCEDURE_BUDGET_MS).toBe(10_000);
    expect(CONTROL_PLANE_PROCEDURE_BUDGET_MS).toBeLessThan(CONTROL_PLANE_DEADLINE_MS);
    // The inner internal-service fetch bound fires first, so this is the backstop.
    expect(CONTROL_PLANE_UPSTREAM_BUDGET_MS).toBeLessThan(CONTROL_PLANE_PROCEDURE_BUDGET_MS);
  });
});

describe('withControlPlaneBudget', () => {
  test('a never-settling query rejects with INTERNAL_SERVER_ERROR and a deadline cause', async () => {
    const next = neverSettlingNext();

    const outcome = withControlPlaneBudget({
      path: 'user.getMe',
      type: 'query',
      headersList: mobileHeaders(),
      next,
    }).catch((error: unknown) => error);

    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(CONTROL_PLANE_PROCEDURE_BUDGET_MS - 1);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    const error = await outcome;

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((error as TRPCError).message).toBe('Control-plane request timed out');
    expect((error as TRPCError).cause).toBeInstanceOf(RequestDeadlineError);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a settling query resolves with the same value and leaves no timer armed', async () => {
    const value = { id: 'u1' };
    const next = jest.fn(async () => value);

    const result = await withControlPlaneBudget({
      path: 'user.getMe',
      type: 'query',
      headersList: mobileHeaders(),
      next,
    });

    expect(result).toBe(value);
    expect(next).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a query that rejects with its own error keeps that error unchanged', async () => {
    const failure = new Error('procedure failed');
    const next = jest.fn(async () => {
      throw failure;
    });

    await expect(
      withControlPlaneBudget({
        path: 'user.getMe',
        type: 'query',
        headersList: mobileHeaders(),
        next,
      })
    ).rejects.toBe(failure);
  });

  test('a non-mobile query is passed through untouched', async () => {
    const next = jest.fn(async () => 'web');

    await expect(
      withControlPlaneBudget({
        path: 'user.getMe',
        type: 'query',
        headersList: new Headers(WEB_HEADERS),
        next,
      })
    ).resolves.toBe('web');

    expect(next).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a mobile mutation is passed through untouched', async () => {
    const next = jest.fn(async () => 'mutation');

    await expect(
      withControlPlaneBudget({
        path: 'user.setPreference',
        type: 'mutation',
        headersList: mobileHeaders(),
        next,
      })
    ).resolves.toBe('mutation');

    expect(next).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the context surface bounds a mobile mutation (shared auth read)', async () => {
    const next = neverSettlingNext();

    const error = await runToDeadline({
      path: 'user.getMe',
      type: 'mutation',
      next,
      surface: 'context',
    });

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((error as TRPCError).cause).toBeInstanceOf(RequestDeadlineError);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('context and procedure share one budget from startedAt', async () => {
    const next = neverSettlingNext();
    const startedAt = performance.now();
    await jest.advanceTimersByTimeAsync(7_000);

    const outcome = withControlPlaneBudget({
      path: 'user.getMe',
      type: 'query',
      headersList: mobileHeaders(),
      next,
      startedAt,
    }).catch((error: unknown) => error);

    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    await jest.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    const error = await outcome;

    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('rejects without calling next when the shared budget is already spent', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const next = neverSettlingNext();
    const startedAt = performance.now();
    await jest.advanceTimersByTimeAsync(CONTROL_PLANE_PROCEDURE_BUDGET_MS);

    const error = await withControlPlaneBudget({
      path: 'user.getMe',
      type: 'query',
      headersList: mobileHeaders(),
      next,
      startedAt,
    }).catch((err: unknown) => err);

    expect(next).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('INTERNAL_SERVER_ERROR');
    expect((error as TRPCError).cause).toBeInstanceOf(RequestDeadlineError);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  test('a caller without headers is passed through untouched', async () => {
    const next = jest.fn(async () => 'no-headers');

    await expect(
      withControlPlaneBudget({ path: 'user.getMe', type: 'query', headersList: null, next })
    ).resolves.toBe('no-headers');

    expect(next).toHaveBeenCalledTimes(1);
  });

  test('the thrown error carries no url, query string, or request header', async () => {
    const error = await runToDeadline({
      headersList: mobileHeaders({
        referer: 'https://api.kilo.ai/api/trpc/user.getMe?token=query-secret',
      }),
      next: neverSettlingNext(),
    });

    const rendered = [
      (error as Error).name,
      (error as Error).message,
      (error as Error).stack ?? '',
      String((error as TRPCError).cause),
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ].join(' ');

    expect(rendered).not.toContain('query-secret');
    expect(rendered).not.toContain('?token=');
    expect(rendered).not.toContain('api.kilo.ai');
  });
});

describe('the budget-exceeded line', () => {
  test('emits one trpc_timing line naming the procedure path only', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await runToDeadline({
      path: 'user.getMe',
      headersList: mobileHeaders({
        referer: 'https://api.kilo.ai/api/trpc/user.getMe?token=query-secret',
      }),
      next: neverSettlingNext(),
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toMatchObject({
      type: 'trpc_timing',
      surface: 'trpc',
      path: 'user.getMe',
      procedureType: 'query',
      ok: false,
      client: 'mobile',
      platform: 'ios',
      version: '1.2.3',
      requestId: 'req-123',
    });
    expect(line.durationMs).toEqual(expect.any(Number));
    // No user id, and nothing derived from a request header or query string.
    expect(line).not.toHaveProperty('userId');
    expect(JSON.stringify(line)).not.toContain('query-secret');
    expect(JSON.stringify(line)).not.toContain('api.kilo.ai');
  });
});

describe('controlPlanePathFromInfo', () => {
  test('prefers the first procedure path and never includes a query string', () => {
    expect(
      controlPlanePathFromInfo({
        calls: [{ path: 'user.getMe' }],
        url: new URL('https://api.kilo.ai/api/trpc/user.getMe?token=query-secret'),
      })
    ).toBe('user.getMe');

    expect(
      controlPlanePathFromInfo({
        url: new URL('https://api.kilo.ai/api/trpc/user.getMe?token=query-secret'),
      })
    ).toBe('user.getMe');

    expect(controlPlanePathFromInfo({})).toBe('trpc.context');
    expect(controlPlanePathFromInfo(null)).toBe('trpc.context');
  });
});

describe('controlPlaneTypeFromInfo', () => {
  test('passes through a known type and treats unknown as a query', () => {
    expect(controlPlaneTypeFromInfo({ type: 'mutation' })).toBe('mutation');
    expect(controlPlaneTypeFromInfo({ type: 'subscription' })).toBe('subscription');
    expect(controlPlaneTypeFromInfo({ type: 'query' })).toBe('query');
    expect(controlPlaneTypeFromInfo({ type: 'unknown' })).toBe('query');
    expect(controlPlaneTypeFromInfo(undefined)).toBe('query');
  });
});
