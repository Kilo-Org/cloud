import { describe, expect, it } from 'vitest';
import { evaluateQueueBacklogAlert } from '../src/alerting/queue-backlog-evaluate';
import {
  MONITORED_QUEUE_ID,
  QUEUE_BACKLOG_THRESHOLDS,
  type QueueBacklogMetrics,
} from '../src/alerting/queue-backlog';
import type { AlertPayload } from '../src/alerting/notify';

const STATE_KEY = `o11y:queue_backlog:${MONITORED_QUEUE_ID}`;

function makeKv() {
  const store = new Map<string, string>();
  let putCount = 0;
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, value: string) => {
      putCount += 1;
      store.set(key, value);
    },
    store,
    get putCount() {
      return putCount;
    },
  } as unknown as KVNamespace & { store: Map<string, string>; putCount: number };
}

function makeSecret(value: string): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeEnv(kv: KVNamespace) {
  return {
    O11Y_ALERT_STATE: kv,
    O11Y_CF_ACCOUNT_ID: 'test-account',
    O11Y_CF_CONTAINERS_API_TOKEN: makeSecret('test-token'),
    O11Y_SLACK_WEBHOOK_PAGE: makeSecret('https://hooks.slack.com/page'),
    O11Y_SLACK_WEBHOOK_TICKET: makeSecret('https://hooks.slack.com/ticket'),
  };
}

function makeMetrics(backlogCount: number): QueueBacklogMetrics {
  return {
    queueId: MONITORED_QUEUE_ID,
    backlogCount,
    backlogBytes: 12_345_678,
    oldestMessageTimestamp: new Date('2026-06-04T08:00:00.000Z'),
  };
}

describe('evaluateQueueBacklogAlert', () => {
  it('sends one ticket alert and persists queue-scoped state', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const notify = async (alert: AlertPayload) => {
      sentAlerts.push(alert);
    };

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
      notify
    );
    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
      notify
    );

    expect(sentAlerts).toEqual([
      {
        alertType: 'queue_backlog',
        severity: 'ticket',
        provider: 'cloudflare',
        model: MONITORED_QUEUE_ID,
        clientName: 'queues',
        backlogCount: QUEUE_BACKLOG_THRESHOLDS.ticket,
        backlogBytes: 12_345_678,
        thresholdCount: QUEUE_BACKLOG_THRESHOLDS.ticket,
        oldestMessageTimestamp: new Date('2026-06-04T08:00:00.000Z'),
      },
    ]);
    expect(kv.store.size).toBe(1);
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      ticket: { active: true, consecutiveBelowCount: 0 },
      page: { active: false, consecutiveBelowCount: 0 },
    });
    expect(kv.putCount).toBe(1);
  });

  it('does not write state below the ticket threshold while inactive', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket - 1),
      async alert => {
        sentAlerts.push(alert);
      }
    );

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
    expect(kv.putCount).toBe(0);
  });

  it('sends only a page alert on a direct jump across both thresholds', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.page),
      async alert => {
        sentAlerts.push(alert);
      }
    );

    expect(sentAlerts.map(alert => alert.severity)).toEqual(['page']);
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      ticket: { active: true, consecutiveBelowCount: 0 },
      page: { active: true, consecutiveBelowCount: 0 },
    });
  });

  it('retries an alert when notification delivery fails', async () => {
    const kv = makeKv();
    let attempts = 0;
    const notify = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('Slack unavailable');
    };

    await expect(
      evaluateQueueBacklogAlert(
        makeEnv(kv),
        async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
        notify
      )
    ).rejects.toThrow('Slack unavailable');
    expect(kv.store.size).toBe(0);

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
      notify
    );

    expect(attempts).toBe(2);
    expect(kv.store.has(STATE_KEY)).toBe(true);
  });

  it('re-arms only after three consecutive below-threshold checks', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const notify = async (alert: AlertPayload) => {
      sentAlerts.push(alert);
    };

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
      notify
    );

    for (let check = 0; check < 2; check += 1) {
      await evaluateQueueBacklogAlert(
        makeEnv(kv),
        async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket - 1),
        notify
      );
    }

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
      notify
    );
    expect(sentAlerts).toHaveLength(1);

    for (let check = 0; check < 3; check += 1) {
      await evaluateQueueBacklogAlert(
        makeEnv(kv),
        async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket - 1),
        notify
      );
    }

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
      notify
    );
    expect(sentAlerts).toHaveLength(2);
  });

  it('recovers safely from invalid persisted state', async () => {
    const kv = makeKv();
    kv.store.set(
      STATE_KEY,
      JSON.stringify({
        ticket: { active: true, consecutiveBelowCount: 'invalid' },
        page: { active: false, consecutiveBelowCount: 0 },
      })
    );
    const sentAlerts: AlertPayload[] = [];

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(QUEUE_BACKLOG_THRESHOLDS.ticket),
      async alert => {
        sentAlerts.push(alert);
      }
    );

    expect(sentAlerts.map(alert => alert.severity)).toEqual(['ticket']);
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toMatchObject({
      ticket: { active: true },
    });
  });
});
