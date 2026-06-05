import { describe, expect, it } from 'vitest';
import { evaluateQueueBacklogAlert } from '../src/alerting/queue-backlog-evaluate';
import {
  MONITORED_QUEUE_ID,
  QUEUE_BACKLOG_PAGE_INTERVAL,
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

async function evaluateAt(
  kv: KVNamespace,
  backlogCount: number,
  notify: (alert: AlertPayload) => Promise<void>
): Promise<void> {
  await evaluateQueueBacklogAlert(makeEnv(kv), async () => makeMetrics(backlogCount), notify);
}

describe('evaluateQueueBacklogAlert', () => {
  it('sends one ticket alert and persists queue-scoped state', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const notify = async (alert: AlertPayload) => {
      sentAlerts.push(alert);
    };

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.ticket, notify);
    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.ticket, notify);

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

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.ticket - 1, async alert => {
      sentAlerts.push(alert);
    });

    expect(sentAlerts).toEqual([]);
    expect(kv.store.size).toBe(0);
    expect(kv.putCount).toBe(0);
  });

  it('pages at 50k and each subsequent 100k escalation interval', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const notify = async (alert: AlertPayload) => {
      sentAlerts.push(alert);
    };

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page, notify);
    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL - 1, notify);
    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL, notify);
    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page + 2 * QUEUE_BACKLOG_PAGE_INTERVAL, notify);

    expect(sentAlerts.map(alert => [alert.severity, alert.thresholdCount])).toEqual([
      ['page', 50_000],
      ['page', 150_000],
      ['page', 250_000],
    ]);
  });

  it('sends one page and advances all intervals on a direct jump', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const notify = async (alert: AlertPayload) => {
      sentAlerts.push(alert);
    };
    const backlogCount = QUEUE_BACKLOG_THRESHOLDS.page + 2 * QUEUE_BACKLOG_PAGE_INTERVAL + 10_000;

    await evaluateAt(kv, backlogCount, notify);
    await evaluateAt(kv, backlogCount, notify);

    expect(sentAlerts.map(alert => [alert.severity, alert.thresholdCount])).toEqual([
      ['page', 250_000],
    ]);
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '')).toEqual({
      ticket: { active: true, consecutiveBelowCount: 0 },
      page: {
        active: true,
        consecutiveBelowCount: 0,
        nextThresholdCount: 350_000,
      },
    });
  });

  it('retries an escalation page when notification delivery fails', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    let failNext = false;
    const notify = async (alert: AlertPayload) => {
      if (failNext) {
        failNext = false;
        throw new Error('Slack unavailable');
      }
      sentAlerts.push(alert);
    };

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page, notify);
    failNext = true;

    await expect(
      evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL, notify)
    ).rejects.toThrow('Slack unavailable');
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '').page.nextThresholdCount).toBe(150_000);

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page + QUEUE_BACKLOG_PAGE_INTERVAL, notify);
    expect(sentAlerts.map(alert => alert.thresholdCount)).toEqual([50_000, 150_000]);
  });

  it('re-arms the initial page only after three consecutive checks below 50k', async () => {
    const kv = makeKv();
    const sentAlerts: AlertPayload[] = [];
    const notify = async (alert: AlertPayload) => {
      sentAlerts.push(alert);
    };

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page, notify);
    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page - 1, notify);
    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page - 1, notify);
    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page, notify);
    expect(sentAlerts).toHaveLength(1);

    for (let check = 0; check < 3; check += 1) {
      await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page - 1, notify);
    }

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page, notify);
    expect(sentAlerts.map(alert => alert.thresholdCount)).toEqual([50_000, 50_000]);
  });

  it('recovers safely from invalid persisted state', async () => {
    const kv = makeKv();
    kv.store.set(
      STATE_KEY,
      JSON.stringify({
        ticket: { active: true, consecutiveBelowCount: 0 },
        page: { active: true, consecutiveBelowCount: 0 },
      })
    );
    const sentAlerts: AlertPayload[] = [];

    await evaluateAt(kv, QUEUE_BACKLOG_THRESHOLDS.page, async alert => {
      sentAlerts.push(alert);
    });

    expect(sentAlerts.map(alert => alert.severity)).toEqual(['page']);
    expect(JSON.parse(kv.store.get(STATE_KEY) ?? '').page.nextThresholdCount).toBe(150_000);
  });
});
