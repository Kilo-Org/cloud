import { afterEach, describe, expect, it, vi } from 'vitest';
import { summarizeInternalAuthCounter, type InternalAuthCounterEnv } from './internal-auth-counter';

vi.mock('./secrets', () => ({ readO11ySecret: async () => 'test-token' }));

const env = {
  O11Y_CF_ACCOUNT_ID: 'account',
  O11Y_CF_AE_API_TOKEN: {},
} as unknown as InternalAuthCounterEnv;

function lines(log: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('summarizeInternalAuthCounter', () => {
  it('writes one kilo_internal_auth line per Analytics Engine row', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            {
              receiver: 'usage-ingest',
              route: 'usage_publish',
              auth: 'legacy_shared_secret',
              caller: 'unknown',
              accepted: 12,
              minute: 1795769280,
            },
            {
              receiver: 'notifications',
              route: 'dispatch',
              auth: 'sts',
              caller: 'web',
              accepted: '3',
              minute: 1795769280,
            },
            // A zero row is not evidence and writes nothing.
            {
              receiver: 'notifications',
              route: 'glanceable_refresh',
              auth: 'legacy_shared_secret',
              caller: 'unknown',
              accepted: 0,
              minute: 1795769280,
            },
            { receiver: 'notifications' },
          ],
        })
      )
    );

    await summarizeInternalAuthCounter(env);

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
        minute: 1795769280,
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
        minute: 1795769280,
      },
      { event: 'o11y_internal_auth_summary_failed', reason: 'row' },
    ]);
  });

  it('reports a refused query and writes no counter lines', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 }))
    );

    await summarizeInternalAuthCounter(env);

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

    await expect(summarizeInternalAuthCounter(env)).resolves.toBeUndefined();
    expect(lines(log)).toEqual([{ event: 'o11y_internal_auth_summary_failed', reason: 'fetch' }]);
  });
});
