import { describe, expect, it, vi } from 'vitest';
import {
  GASTOWN_HEALTH_WINDOW_MINUTES,
  queryGastownHealth,
} from '../src/alerting/gastown-health-query';

const ACCOUNT_ID = 'test-account-123';
const API_TOKEN = 'test-token-abc';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

type TownRow = {
  town_id: string;
  weighted_failed_checks: string | number | null;
  weighted_successful_checks: string | number | null;
  weighted_exhausted: string | number | null;
  weighted_recovered: string | number | null;
  weighted_watchdog_code_updated: string | number | null;
  first_event_timestamp: string | null;
  last_event_timestamp: string | null;
};

type AggregateRow = {
  weighted_failed_checks: string | number | null;
  weighted_successful_checks: string | number | null;
  latest_event_timestamp: string | null;
};

function makeSecret(value: string | null): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeEnv(token: string | null = API_TOKEN) {
  return {
    O11Y_CF_ACCOUNT_ID: ACCOUNT_ID,
    O11Y_CF_AE_API_TOKEN: makeSecret(token),
  };
}

// The query runs two AE statements; route each response by inspecting the SQL.
function isTownSignalSql(body: unknown): boolean {
  return String(body).includes('GROUP BY town_id');
}

function makeFetchFn(responses: { townRows: TownRow[]; aggregateRow: AggregateRow | null }): {
  fetchFn: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    if (isTownSignalSql(init?.body)) {
      return Response.json({ data: responses.townRows });
    }
    return Response.json({ data: responses.aggregateRow ? [responses.aggregateRow] : [] });
  };
  return { fetchFn, calls };
}

describe('queryGastownHealth', () => {
  it('parses per-town signals and the fleet aggregate', async () => {
    const { fetchFn, calls } = makeFetchFn({
      townRows: [
        {
          town_id: 'town-1',
          weighted_failed_checks: '12',
          weighted_successful_checks: '0',
          weighted_exhausted: '1',
          weighted_recovered: '0',
          weighted_watchdog_code_updated: '0',
          first_event_timestamp: '2026-06-24 15:00:00.000',
          last_event_timestamp: '2026-06-24 15:12:00.000',
        },
        {
          town_id: 'town-2',
          weighted_failed_checks: '4',
          weighted_successful_checks: '3',
          weighted_exhausted: '0',
          weighted_recovered: '2',
          weighted_watchdog_code_updated: '5',
          first_event_timestamp: '2026-06-24 15:05:00.000',
          last_event_timestamp: '2026-06-24 15:09:00.000',
        },
      ],
      aggregateRow: {
        weighted_failed_checks: '16',
        weighted_successful_checks: '150',
        latest_event_timestamp: '2026-06-24 15:12:00.000',
      },
    });

    const metrics = await queryGastownHealth(makeEnv(), fetchFn);

    expect(metrics.aggregateWeightedFailedChecks).toBe(16);
    expect(metrics.aggregateWeightedSuccessfulChecks).toBe(150);
    expect(metrics.latestEventTimestamp).toEqual(new Date('2026-06-24T15:12:00.000Z'));
    expect(metrics.townSignals).toEqual([
      {
        townId: 'town-1',
        weightedFailedChecks: 12,
        weightedSuccessfulChecks: 0,
        weightedExhausted: 1,
        weightedRecovered: 0,
        weightedWatchdogCodeUpdated: 0,
        firstEventAt: new Date('2026-06-24T15:00:00.000Z'),
        lastEventAt: new Date('2026-06-24T15:12:00.000Z'),
      },
      {
        townId: 'town-2',
        weightedFailedChecks: 4,
        weightedSuccessfulChecks: 3,
        weightedExhausted: 0,
        weightedRecovered: 2,
        weightedWatchdogCodeUpdated: 5,
        firstEventAt: new Date('2026-06-24T15:05:00.000Z'),
        lastEventAt: new Date('2026-06-24T15:09:00.000Z'),
      },
    ]);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe(
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`
      );
      expect(new Headers(call.init?.headers).get('Authorization')).toBe(`Bearer ${API_TOKEN}`);
      expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    }

    const townSql = String(calls.find(c => isTownSignalSql(c.init?.body))?.init?.body);
    expect(townSql).toContain('FROM gastown_events');
    expect(townSql).toContain(`INTERVAL '${GASTOWN_HEALTH_WINDOW_MINUTES}' MINUTE`);
    expect(townSql).toContain("'container.auto_restart_exhausted'");
    expect(townSql).toContain("'container.health_recovered'");
    expect(townSql).toContain("'container.health_watchdog_error'");
    expect(townSql).toContain("position('code was updated' IN blob5) > 0");
    expect(townSql).toContain('GROUP BY town_id');
    expect(townSql).toContain('HAVING');

    const aggregateSql = String(calls.find(c => !isTownSignalSql(c.init?.body))?.init?.body);
    expect(aggregateSql).toContain("blob1 = 'container.health_ping'");
    expect(aggregateSql).not.toContain('GROUP BY');
  });

  it('maps empty Analytics Engine results to no telemetry', async () => {
    const { fetchFn } = makeFetchFn({ townRows: [], aggregateRow: null });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).resolves.toEqual({
      townSignals: [],
      aggregateWeightedFailedChecks: 0,
      aggregateWeightedSuccessfulChecks: 0,
      latestEventTimestamp: null,
    });
  });

  it('maps null aggregates to zero', async () => {
    const { fetchFn } = makeFetchFn({
      townRows: [],
      aggregateRow: {
        weighted_failed_checks: null,
        weighted_successful_checks: null,
        latest_event_timestamp: null,
      },
    });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).resolves.toEqual({
      townSignals: [],
      aggregateWeightedFailedChecks: 0,
      aggregateWeightedSuccessfulChecks: 0,
      latestEventTimestamp: null,
    });
  });

  it.each(['', 'not-a-number', '-1', 'Infinity'])(
    'rejects invalid Analytics Engine aggregate %j',
    async aggregate => {
      const { fetchFn } = makeFetchFn({
        townRows: [],
        aggregateRow: {
          weighted_failed_checks: aggregate,
          weighted_successful_checks: '0',
          latest_event_timestamp: null,
        },
      });

      await expect(queryGastownHealth(makeEnv(), fetchFn)).rejects.toThrow();
    }
  );

  it('rejects an invalid per-town timestamp', async () => {
    const { fetchFn } = makeFetchFn({
      townRows: [
        {
          town_id: 'town-1',
          weighted_failed_checks: '12',
          weighted_successful_checks: '0',
          weighted_exhausted: '0',
          weighted_recovered: '0',
          weighted_watchdog_code_updated: '0',
          first_event_timestamp: 'not-a-timestamp',
          last_event_timestamp: '2026-06-24 15:12:00.000',
        },
      ],
      aggregateRow: {
        weighted_failed_checks: '12',
        weighted_successful_checks: '0',
        latest_event_timestamp: '2026-06-24 15:12:00.000',
      },
    });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).rejects.toThrow('invalid timestamp');
  });

  it('rejects malformed Analytics Engine responses', async () => {
    const fetchFn: FetchFn = async () =>
      Response.json({ data: [{ weighted_failed_checks: '20' }] });

    await expect(queryGastownHealth(makeEnv(), fetchFn)).rejects.toThrow();
  });

  it('rejects failed Analytics Engine queries without exposing response content', async () => {
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
