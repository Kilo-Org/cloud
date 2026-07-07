import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  classifyGastownHealth,
  DEPLOY_CHURN_WATCHDOG_ERROR_TOWNS,
  evaluateGastownHealthAlert,
  SUSTAINED_FAILURE_MINUTES,
} from '../src/alerting/gastown-health-evaluate';
import type { GastownHealthMetrics, GastownTownSignal } from '../src/alerting/gastown-health-query';
import type { AlertPayload, GastownHealthAlertPayload } from '../src/alerting/notify';

const STATE_KEY = 'o11y:gastown_container_health';
const WINDOW_START = new Date('2026-06-24T15:00:00.000Z');

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

function town(overrides: Partial<GastownTownSignal> & { townId: string }): GastownTownSignal {
  return {
    townId: overrides.townId,
    weightedFailedChecks: overrides.weightedFailedChecks ?? 0,
    weightedSuccessfulChecks: overrides.weightedSuccessfulChecks ?? 0,
    weightedExhausted: overrides.weightedExhausted ?? 0,
    weightedRecovered: overrides.weightedRecovered ?? 0,
    weightedWatchdogCodeUpdated: overrides.weightedWatchdogCodeUpdated ?? 0,
    firstEventAt: overrides.firstEventAt ?? null,
    lastEventAt: overrides.lastEventAt ?? null,
  };
}

function span(minutes: number): Pick<GastownTownSignal, 'firstEventAt' | 'lastEventAt'> {
  return {
    firstEventAt: WINDOW_START,
    lastEventAt: new Date(WINDOW_START.getTime() + minutes * 60_000),
  };
}

// A town wedged past the sustained threshold: continuous failures, no success,
// no recovery, spanning longer than SUSTAINED_FAILURE_MINUTES.
function sustainedTown(townId: string): GastownTownSignal {
  return town({
    townId,
    weightedFailedChecks: 12,
    ...span(SUSTAINED_FAILURE_MINUTES + 1),
  });
}

function metrics(
  townSignals: GastownTownSignal[],
  aggregate: { failed?: number; successful?: number } = {}
): GastownHealthMetrics {
  return {
    townSignals,
    aggregateWeightedFailedChecks:
      aggregate.failed ?? townSignals.reduce((sum, t) => sum + t.weightedFailedChecks, 0),
    aggregateWeightedSuccessfulChecks:
      aggregate.successful ?? townSignals.reduce((sum, t) => sum + t.weightedSuccessfulChecks, 0),
    latestEventTimestamp: townSignals.length > 0 ? WINDOW_START : null,
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

describe('classifyGastownHealth', () => {
  it('does not flag self-healed flapping (no exhaustion, has successes/recoveries)', () => {
    const result = classifyGastownHealth(
      metrics([
        town({
          townId: 'town-1',
          weightedFailedChecks: 8,
          weightedSuccessfulChecks: 4,
          weightedRecovered: 3,
          ...span(SUSTAINED_FAILURE_MINUTES + 5),
        }),
      ])
    );

    expect(result.wedgeTownIds).toEqual([]);
    expect(result.exhaustedTownIds).toEqual([]);
    expect(result.sustainedTownIds).toEqual([]);
    expect(result.affectedTownCount).toBe(1);
  });

  it('flags a town that exhausted its restart budget', () => {
    const result = classifyGastownHealth(
      metrics([town({ townId: 'town-1', weightedFailedChecks: 9, weightedExhausted: 1 })])
    );

    expect(result.exhaustedTownIds).toEqual(['town-1']);
    expect(result.wedgeTownIds).toEqual(['town-1']);
  });

  it('flags a sustained failure with no recovery or success', () => {
    const result = classifyGastownHealth(metrics([sustainedTown('town-1')]));

    expect(result.sustainedTownIds).toEqual(['town-1']);
    expect(result.wedgeTownIds).toEqual(['town-1']);
  });

  it('does not flag failures shorter than the sustained threshold', () => {
    const result = classifyGastownHealth(
      metrics([
        town({ townId: 'town-1', weightedFailedChecks: 5, ...span(SUSTAINED_FAILURE_MINUTES - 2) }),
      ])
    );

    expect(result.sustainedTownIds).toEqual([]);
    expect(result.wedgeTownIds).toEqual([]);
  });

  it('suppresses sustained towns during broad deploy churn but keeps exhausted ones', () => {
    const churnTowns = Array.from({ length: DEPLOY_CHURN_WATCHDOG_ERROR_TOWNS }, (_, i) =>
      town({
        townId: `churn-${i}`,
        weightedFailedChecks: 12,
        weightedWatchdogCodeUpdated: 4,
        ...span(SUSTAINED_FAILURE_MINUTES + 1),
      })
    );
    const exhausted = town({
      townId: 'wedged',
      weightedFailedChecks: 9,
      weightedExhausted: 1,
      weightedWatchdogCodeUpdated: 2,
    });

    const result = classifyGastownHealth(metrics([...churnTowns, exhausted]));

    expect(result.deployChurnSuspected).toBe(true);
    expect(result.sustainedTownIds).toEqual([]);
    // A genuine wedge (exhausted) still pages even when it also carries the
    // deploy-churn fingerprint.
    expect(result.exhaustedTownIds).toEqual(['wedged']);
    expect(result.wedgeTownIds).toEqual(['wedged']);
  });

  it('does not suspect deploy churn below the town threshold', () => {
    const result = classifyGastownHealth(
      metrics([
        town({
          townId: 'town-1',
          weightedFailedChecks: 12,
          weightedWatchdogCodeUpdated: 3,
          ...span(SUSTAINED_FAILURE_MINUTES + 1),
        }),
      ])
    );

    expect(result.deployChurnSuspected).toBe(false);
    // Not excluded as churn, so still a sustained wedge.
    expect(result.sustainedTownIds).toEqual(['town-1']);
  });
});

describe('evaluateGastownHealthAlert', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
  });

  it('does not page on self-healed flapping', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(
      kv,
      metrics(
        [
          town({
            townId: 'town-1',
            weightedFailedChecks: 8,
            weightedSuccessfulChecks: 4,
            weightedRecovered: 3,
            ...span(SUSTAINED_FAILURE_MINUTES + 5),
          }),
        ],
        { successful: 200 }
      ),
      sentAlerts
    );

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('always emits the aggregate trend info log', async () => {
    const kv = makeKv();
    await evaluateAt(kv, metrics([], { failed: 0, successful: 500 }), []);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(infoSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      event: 'gastown_container_health_trend',
      weightedSuccessfulChecks: 500,
      exhaustedTownCount: 0,
      sustainedTownCount: 0,
    });
  });

  it('pages once for an exhausted town', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const exhausted = metrics(
      [town({ townId: 'town-1', weightedFailedChecks: 9, weightedExhausted: 1 })],
      { successful: 100 }
    );

    await evaluateAt(kv, exhausted, sentAlerts);
    await evaluateAt(kv, exhausted, sentAlerts);

    expect(sentAlerts).toHaveLength(1);
    const alert = sentAlerts[0] as GastownHealthAlertPayload;
    expect(alert).toMatchObject({
      alertType: 'gastown_container_health',
      severity: 'ticket',
      exhaustedTownIds: ['town-1'],
      sustainedTownIds: [],
      deployChurnSuspected: false,
    });
  });

  it('pages on a sustained wedge with no recovery', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(kv, metrics([sustainedTown('town-1')], { successful: 50 }), sentAlerts);

    expect(sentAlerts).toHaveLength(1);
    expect((sentAlerts[0] as GastownHealthAlertPayload).sustainedTownIds).toEqual(['town-1']);
  });

  it('does not page during broad deploy churn without a genuine wedge', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const churnTowns = Array.from({ length: DEPLOY_CHURN_WATCHDOG_ERROR_TOWNS }, (_, i) =>
      town({
        townId: `churn-${i}`,
        weightedFailedChecks: 12,
        weightedWatchdogCodeUpdated: 4,
        ...span(SUSTAINED_FAILURE_MINUTES + 1),
      })
    );

    await evaluateAt(kv, metrics(churnTowns, { successful: 100 }), sentAlerts);

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('re-notifies when the wedged town set escalates', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(
      kv,
      metrics([town({ townId: 'town-1', weightedExhausted: 1, weightedFailedChecks: 9 })], {
        successful: 100,
      }),
      sentAlerts
    );
    await evaluateAt(
      kv,
      metrics(
        [
          town({ townId: 'town-1', weightedExhausted: 1, weightedFailedChecks: 9 }),
          town({ townId: 'town-2', weightedExhausted: 1, weightedFailedChecks: 9 }),
        ],
        { successful: 100 }
      ),
      sentAlerts
    );

    expect(sentAlerts).toHaveLength(2);
    expect((sentAlerts[1] as GastownHealthAlertPayload).exhaustedTownIds).toEqual([
      'town-1',
      'town-2',
    ]);
  });

  it('resolves after three clean evaluations and re-pages on recurrence', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const wedge = metrics(
      [town({ townId: 'town-1', weightedExhausted: 1, weightedFailedChecks: 9 })],
      { successful: 100 }
    );
    const clean = metrics([], { successful: 200 });

    await evaluateAt(kv, wedge, sentAlerts);
    await evaluateAt(kv, clean, sentAlerts);
    await evaluateAt(kv, clean, sentAlerts);
    await evaluateAt(kv, clean, sentAlerts);

    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      active: false,
      consecutiveHealthyCount: 0,
    });

    await evaluateAt(kv, wedge, sentAlerts);
    expect(sentAlerts).toHaveLength(2);
  });

  it('does not resolve during a telemetry blackout', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const wedge = metrics(
      [town({ townId: 'town-1', weightedExhausted: 1, weightedFailedChecks: 9 })],
      { successful: 100 }
    );

    await evaluateAt(kv, wedge, sentAlerts);
    // No wedge towns and zero successful pings — a blackout, not a recovery.
    await evaluateAt(kv, metrics([], { successful: 0 }), sentAlerts);
    await evaluateAt(kv, metrics([], { successful: 0 }), sentAlerts);
    await evaluateAt(kv, metrics([], { successful: 0 }), sentAlerts);

    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toMatchObject({
      active: true,
      notifiedTownIds: ['town-1'],
    });
  });

  it('does not persist active state when notification delivery fails', async () => {
    const kv = makeKv();

    await expect(
      evaluateGastownHealthAlert(
        makeEnv(kv),
        async () =>
          metrics([town({ townId: 'town-1', weightedExhausted: 1, weightedFailedChecks: 9 })], {
            successful: 100,
          }),
        async () => {
          throw new Error('Slack unavailable');
        }
      )
    ).rejects.toThrow('Slack unavailable');

    expect(kv.store.size).toBe(0);
  });
});
