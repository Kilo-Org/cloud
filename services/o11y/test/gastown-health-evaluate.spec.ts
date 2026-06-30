import { describe, expect, it } from 'vitest';
import {
  evaluateGastownHealthAlert,
  GASTOWN_HEALTH_THRESHOLDS,
} from '../src/alerting/gastown-health-evaluate';
import type { GastownHealthMetrics } from '../src/alerting/gastown-health-query';
import type { AlertPayload } from '../src/alerting/notify';

const STATE_KEY = 'o11y:gastown_container_health';

function makeKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    store,
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function makeSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeEnv(kv: KVNamespace) {
  return {
    O11Y_ALERT_STATE: kv,
    O11Y_CF_ACCOUNT_ID: 'test-account',
    O11Y_CF_AE_API_TOKEN: makeSecret('test-token'),
    O11Y_SLACK_WEBHOOK_PAGE: makeSecret('https://hooks.slack.com/page'),
    O11Y_SLACK_WEBHOOK_TICKET: makeSecret('https://hooks.slack.com/ticket'),
  };
}

function makeMetrics(
  weightedFailedChecks: number,
  affectedTownCount: number,
  weightedSuccessfulChecks = 0
): GastownHealthMetrics {
  return {
    weightedFailedChecks,
    weightedSuccessfulChecks,
    affectedTownCount,
    latestEventTimestamp:
      weightedFailedChecks + weightedSuccessfulChecks > 0
        ? new Date('2026-06-24T15:10:00.000Z')
        : null,
  };
}

async function evaluateAt(
  kv: KVNamespace,
  result: GastownHealthMetrics,
  sentAlerts: AlertPayload[]
): Promise<void> {
  await evaluateGastownHealthAlert(
    makeEnv(kv),
    async () => result,
    async alert => {
      sentAlerts.push(alert);
    }
  );
}

describe('evaluateGastownHealthAlert', () => {
  it('does not alert below both thresholds', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(
      kv,
      makeMetrics(
        GASTOWN_HEALTH_THRESHOLDS.weightedFailedChecks - 1,
        GASTOWN_HEALTH_THRESHOLDS.affectedTowns - 1,
        10
      ),
      sentAlerts
    );

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('does not alert when only the failed-check threshold is crossed', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(
      kv,
      makeMetrics(
        GASTOWN_HEALTH_THRESHOLDS.weightedFailedChecks,
        GASTOWN_HEALTH_THRESHOLDS.affectedTowns - 1
      ),
      sentAlerts
    );

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('does not alert when only the affected-town threshold is crossed', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(
      kv,
      makeMetrics(
        GASTOWN_HEALTH_THRESHOLDS.weightedFailedChecks - 1,
        GASTOWN_HEALTH_THRESHOLDS.affectedTowns
      ),
      sentAlerts
    );

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('alerts when both critical mass thresholds are crossed', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(
      kv,
      makeMetrics(
        GASTOWN_HEALTH_THRESHOLDS.weightedFailedChecks,
        GASTOWN_HEALTH_THRESHOLDS.affectedTowns
      ),
      sentAlerts
    );

    expect(sentAlerts).toMatchObject([
      {
        alertType: 'gastown_container_health',
        severity: 'ticket',
        weightedFailedChecks: 30,
        affectedTownCount: 4,
        windowMinutes: 15,
        crossedThresholds: ['failed_checks', 'affected_towns'],
      },
    ]);
  });

  it('notifies only once during persistent failure', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const failingMetrics = makeMetrics(30, 4);

    await evaluateAt(kv, failingMetrics, sentAlerts);
    await evaluateAt(kv, makeMetrics(45, 4), sentAlerts);
    await evaluateAt(kv, makeMetrics(59, 4), sentAlerts);

    expect(sentAlerts).toHaveLength(1);
  });

  it('renotifies during persistent failure when failed checks climb by another threshold step', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(kv, makeMetrics(30, 4), sentAlerts);
    await evaluateAt(kv, makeMetrics(59, 4), sentAlerts);
    await evaluateAt(kv, makeMetrics(60, 4), sentAlerts);

    expect(sentAlerts).toMatchObject([
      {
        weightedFailedChecks: 30,
        affectedTownCount: 4,
      },
      {
        weightedFailedChecks: 60,
        affectedTownCount: 4,
      },
    ]);
  });

  it('does not clear active state when no telemetry is observed', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(kv, makeMetrics(30, 4), sentAlerts);
    await evaluateAt(kv, makeMetrics(0, 0), sentAlerts);
    await evaluateAt(kv, makeMetrics(0, 0), sentAlerts);
    await evaluateAt(kv, makeMetrics(0, 0), sentAlerts);

    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      active: true,
      consecutiveHealthyCount: 0,
      lastNotifiedWeightedFailedChecks: 30,
    });
  });

  it('clears after three consecutive healthy evaluations and alerts on recurrence', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(kv, makeMetrics(30, 4), sentAlerts);
    await evaluateAt(kv, makeMetrics(0, 0, 12), sentAlerts);
    await evaluateAt(kv, makeMetrics(0, 0, 8), sentAlerts);
    await evaluateAt(kv, makeMetrics(0, 0, 1), sentAlerts);

    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      active: false,
      consecutiveHealthyCount: 0,
    });

    await evaluateAt(kv, makeMetrics(30, 4), sentAlerts);
    expect(sentAlerts).toHaveLength(2);
  });

  it('resets recovery progress when a threshold is crossed again', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(kv, makeMetrics(30, 4), sentAlerts);
    await evaluateAt(kv, makeMetrics(0, 0, 1), sentAlerts);
    await evaluateAt(kv, makeMetrics(30, 4), sentAlerts);

    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      active: true,
      consecutiveHealthyCount: 0,
      lastNotifiedWeightedFailedChecks: 30,
    });
    expect(sentAlerts).toHaveLength(1);
  });

  it('backfills legacy active state to the last step boundary, not the current count', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    kv.store.set(STATE_KEY, JSON.stringify({ active: true, consecutiveHealthyCount: 0 }));

    // weightedFailedChecks=59 is between step boundaries 30 and 60; backfill should be 30
    await evaluateAt(kv, makeMetrics(59, 4), sentAlerts);

    expect(sentAlerts).toEqual([]);
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      active: true,
      consecutiveHealthyCount: 0,
      lastNotifiedWeightedFailedChecks: 30,
    });
  });

  it('re-notifies correctly after backfilling legacy active state', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    kv.store.set(STATE_KEY, JSON.stringify({ active: true, consecutiveHealthyCount: 0 }));

    await evaluateAt(kv, makeMetrics(59, 4), sentAlerts);
    await evaluateAt(kv, makeMetrics(60, 4), sentAlerts);

    expect(sentAlerts).toMatchObject([{ weightedFailedChecks: 60, affectedTownCount: 4 }]);
  });

  it('does not persist active state when notification delivery fails', async () => {
    const kv = makeKv();

    await expect(
      evaluateGastownHealthAlert(
        makeEnv(kv),
        async () => makeMetrics(30, 4),
        async () => {
          throw new Error('Slack unavailable');
        }
      )
    ).rejects.toThrow('Slack unavailable');

    expect(kv.store.size).toBe(0);
  });
});
