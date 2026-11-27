import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeInternalAuthCounter, type InternalAuthCounterEnv } from './internal-auth-counter';

vi.mock('./secrets', () => ({ readO11ySecret: async () => 'test-token' }));

const env = {
  O11Y_CF_ACCOUNT_ID: 'account',
  O11Y_CF_AE_API_TOKEN: {},
} as unknown as InternalAuthCounterEnv;

const WINDOW = 1795769220;
/** Three minutes after the window: the cron's scheduled time for the run that reads it. */
const SCHEDULED_MS = (WINDOW + 180) * 1000;
const MINUTE = WINDOW + 60;

function lines(log: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

function stubQuery(rows: unknown[]) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    Response.json({ data: rows })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('summarizeInternalAuthCounter', () => {
  it('writes one kilo_internal_auth line per valid row and pins the closed window', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = stubQuery([
      {
        receiver: 'usage-ingest',
        route: 'usage_publish',
        auth: 'legacy_shared_secret',
        caller: 'unknown',
        accepted: 12,
        minute: MINUTE,
      },
      {
        receiver: 'notifications',
        route: 'dispatch',
        auth: 'sts',
        caller: 'web',
        accepted: '3',
        minute: MINUTE,
      },
      // A zero row writes nothing.
      {
        receiver: 'notifications',
        route: 'glanceable_refresh',
        auth: 'legacy_shared_secret',
        caller: 'unknown',
        accepted: 0,
        minute: MINUTE,
      },
      // An unknown receiver, an unknown auth method and a bad route are refused.
      {
        receiver: 'o11y',
        route: 'api_metrics_write',
        auth: 'legacy_shared_secret',
        caller: 'unknown',
        accepted: 5,
        minute: MINUTE,
      },
      {
        receiver: 'notifications',
        route: 'dispatch',
        auth: 'something_else',
        caller: 'unknown',
        accepted: 5,
        minute: MINUTE,
      },
      {
        receiver: 'notifications',
        route: 'Dispatch!',
        auth: 'sts',
        caller: 'unknown',
        accepted: 5,
        minute: MINUTE,
      },
      { receiver: 'notifications' },
    ]);

    await summarizeInternalAuthCounter(env, undefined, SCHEDULED_MS);

    const sql = String((fetchMock.mock.calls[0]?.[1] as { body?: string } | undefined)?.body);
    expect(sql).toContain('FROM kilo_internal_auth');
    expect(sql).toContain('SUM(_sample_interval * double1) AS accepted');
    expect(sql).toContain('blob1 AS receiver');
    expect(sql).toContain('blob2 AS route');
    expect(sql).toContain('blob3 AS auth');
    expect(sql).toContain('blob4 AS caller');
    expect(sql).toContain(`toDateTime(${WINDOW})`);
    expect(sql).toContain(`toDateTime(${WINDOW + 60})`);
    expect(sql).toContain('toUInt32(index1)');
    expect(sql).toContain('GROUP BY receiver, route, auth, caller, minute');

    expect(lines(log)).toEqual([
      {
        event: 'kilo_internal_auth',
        v: 1,
        source: 'analytics_engine',
        receiver: 'usage-ingest',
        route: 'usage_publish',
        auth: 'legacy_shared_secret',
        caller: 'unknown',
        count: 12,
        minute: MINUTE,
        window: WINDOW,
      },
      {
        event: 'kilo_internal_auth',
        v: 1,
        source: 'analytics_engine',
        receiver: 'notifications',
        route: 'dispatch',
        auth: 'sts',
        caller: 'web',
        count: 3,
        minute: MINUTE,
        window: WINDOW,
      },
      { event: 'o11y_internal_auth_summary_failed', reason: 'row' },
      { event: 'o11y_internal_auth_summary_failed', reason: 'row' },
      { event: 'o11y_internal_auth_summary_failed', reason: 'row' },
      { event: 'o11y_internal_auth_summary_failed', reason: 'row' },
    ]);
  });

  it('reports a refused query and writes no counter lines', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 }))
    );

    await summarizeInternalAuthCounter(env, undefined, SCHEDULED_MS);

    expect(lines(log)).toEqual([
      { event: 'o11y_internal_auth_summary_failed', reason: 'query', status: 403 },
    ]);
  });

  it('reports a transport failure without throwing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      })
    );

    await expect(
      summarizeInternalAuthCounter(env, undefined, SCHEDULED_MS)
    ).resolves.toBeUndefined();
    expect(lines(log)).toEqual([{ event: 'o11y_internal_auth_summary_failed', reason: 'fetch' }]);
  });
});
