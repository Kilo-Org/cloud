import { describe, expect, it, vi } from 'vitest';
import {
  GASTOWN_HEALTH_WINDOW_MINUTES,
  queryGastownHealth,
} from '../src/alerting/gastown-health-query';

const ACCOUNT_ID = 'test-account-123';
const API_TOKEN = 'test-token-abc';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function makeSecret(value: string | null): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeEnv(token: string | null = API_TOKEN) {
  return {
    O11Y_CF_ACCOUNT_ID: ACCOUNT_ID,
    O11Y_CF_AE_API_TOKEN: makeSecret(token),
  };
}

describe('queryGastownHealth', () => {
  it('queries weighted fifteen-minute container health metrics', async () => {
    let calledUrl = '';
    let calledInit: RequestInit | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      calledUrl = url;
      calledInit = init;
      return Response.json({
        data: [
          {
            town_id: 'town-1',
            weighted_failed_checks: '20',
            weighted_successful_checks: '100',
            latest_event_timestamp: '2026-06-24 15:09:00.000',
          },
          {
            town_id: 'town-2',
            weighted_failed_checks: '4',
            weighted_successful_checks: '50',
            latest_event_timestamp: '2026-06-24 15:10:00.000',
          },
          {
            town_id: '',
            weighted_failed_checks: '3',
            weighted_successful_checks: '2',
            latest_event_timestamp: '2026-06-24 15:08:00.000',
          },
        ],
      });
    };

    await expect(queryGastownHealth(makeEnv(), fetchFn)).resolves.toEqual({
      weightedFailedChecks: 27,
      weightedSuccessfulChecks: 152,
      affectedTownCount: 2,
      latestEventTimestamp: new Date('2026-06-24T15:10:00.000Z'),
    });
    expect(calledUrl).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`
    );
    expect(new Headers(calledInit?.headers).get('Authorization')).toBe(`Bearer ${API_TOKEN}`);
    expect(calledInit?.signal).toBeInstanceOf(AbortSignal);

    const sql = String(calledInit?.body);
    expect(sql).toContain('FROM gastown_events');
    expect(sql).toContain(`INTERVAL '${GASTOWN_HEALTH_WINDOW_MINUTES}' MINUTE`);
    expect(sql).toContain("blob1 = 'container.health_ping'");
    expect(sql).toContain("SUM(IF(blob5 != '', _sample_interval, 0))");
    expect(sql).toContain("SUM(IF(blob5 = '', _sample_interval, 0))");
    expect(sql).toContain("IF(blob5 != '' AND blob6 != '', blob6, '') AS town_id");
    expect(sql).toContain('GROUP BY town_id');
    expect(sql).not.toContain('GROUP BY blob6');
    expect(sql).not.toContain('uniqExactIf');
  });

  it('maps an empty Analytics Engine result to no telemetry', async () => {
    const fetchFn: FetchFn = async () => Response.json({ data: [] });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).resolves.toEqual({
      weightedFailedChecks: 0,
      weightedSuccessfulChecks: 0,
      affectedTownCount: 0,
      latestEventTimestamp: null,
    });
  });

  it('maps null aggregates to no telemetry', async () => {
    const fetchFn: FetchFn = async () =>
      Response.json({
        data: [
          {
            town_id: '',
            weighted_failed_checks: null,
            weighted_successful_checks: null,
            latest_event_timestamp: null,
          },
        ],
      });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).resolves.toEqual({
      weightedFailedChecks: 0,
      weightedSuccessfulChecks: 0,
      affectedTownCount: 0,
      latestEventTimestamp: null,
    });
  });

  it.each(['', 'not-a-number', '-1', 'Infinity'])(
    'rejects invalid Analytics Engine aggregate %j',
    async aggregate => {
      const fetchFn: FetchFn = async () =>
        Response.json({
          data: [
            {
              town_id: '',
              weighted_failed_checks: aggregate,
              weighted_successful_checks: '0',
              latest_event_timestamp: null,
            },
          ],
        });

      await expect(queryGastownHealth(makeEnv(), fetchFn)).rejects.toThrow();
    }
  );

  it('rejects malformed Analytics Engine responses', async () => {
    const fetchFn: FetchFn = async () =>
      Response.json({ data: [{ weighted_failed_checks: '20' }] });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).rejects.toThrow();
  });

  it('rejects invalid Analytics Engine queries without exposing response content', async () => {
    const fetchFn: FetchFn = async () =>
      new Response('sensitive provider response', { status: 422 });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).rejects.toThrow(
      'Gastown health Analytics Engine query failed (422)'
    );
  });

  it('times out Analytics Engine requests after five seconds', async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let signalReady: (() => void) | undefined;
    const receivedSignal = new Promise<void>(resolve => {
      signalReady = resolve;
    });
    const fetchFn: FetchFn = async (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        signalReady?.();
      });

    const query = queryGastownHealth(makeEnv(), fetchFn);
    await receivedSignal;
    controller.abort(new DOMException('Timed out', 'TimeoutError'));

    await expect(query).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
    timeoutSpy.mockRestore();
  });

  it('throws when the Analytics Engine token is not configured', async () => {
    const fetchFn: FetchFn = async () => Response.json({ data: [] });

    await expect(queryGastownHealth(makeEnv(null), fetchFn)).rejects.toThrow(
      'O11Y_CF_AE_API_TOKEN secret is not configured'
    );
  });
});
