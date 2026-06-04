import { describe, expect, it } from 'vitest';
import { evaluateQueueBacklogAlert } from '../src/alerting/queue-backlog-evaluate';
import { MONITORED_QUEUE_ID, type QueueBacklogMetrics } from '../src/alerting/queue-backlog';
import type { AlertPayload } from '../src/alerting/notify';

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
  it('sends a ticket alert and records its dedup marker', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(25_000),
      async alert => {
        sentAlerts.push(alert);
      }
    );

    expect(sentAlerts).toEqual([
      {
        alertType: 'queue_backlog',
        severity: 'ticket',
        provider: 'cloudflare',
        model: MONITORED_QUEUE_ID,
        clientName: 'queues',
        backlogCount: 25_000,
        backlogBytes: 12_345_678,
        thresholdCount: 25_000,
        oldestMessageTimestamp: new Date('2026-06-04T08:00:00.000Z'),
      },
    ]);
    expect(
      kv.store.has(`o11y:alert:ticket:queue_backlog:cloudflare:${MONITORED_QUEUE_ID}:queues`)
    ).toBe(true);
  });

  it('does not send an alert below the ticket threshold', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(24_999),
      async alert => {
        sentAlerts.push(alert);
      }
    );

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('suppresses a ticket while a page cooldown marker is active', async () => {
    const kv = makeKv();
    kv.store.set(
      `o11y:alert:page:queue_backlog:cloudflare:${MONITORED_QUEUE_ID}:queues`,
      new Date().toISOString()
    );
    const sentAlerts: AlertPayload[] = [];

    await evaluateQueueBacklogAlert(
      makeEnv(kv),
      async () => makeMetrics(25_000),
      async alert => {
        sentAlerts.push(alert);
      }
    );

    expect(sentAlerts).toEqual([]);
  });

  it('does not record a cooldown marker when notification fails', async () => {
    const kv = makeKv();

    await expect(
      evaluateQueueBacklogAlert(
        makeEnv(kv),
        async () => makeMetrics(25_000),
        async () => {
          throw new Error('Slack unavailable');
        }
      )
    ).rejects.toThrow('Slack unavailable');

    expect(kv.store.size).toBe(0);
  });
});
