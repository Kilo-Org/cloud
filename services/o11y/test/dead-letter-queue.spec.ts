import { describe, expect, it } from 'vitest';
import {
  DEAD_LETTER_QUEUE_NAME,
  DEAD_LETTER_QUEUE_SEVERITY,
} from '../src/alerting/dead-letter-queue';
import { queryDeadLetterQueue } from '../src/alerting/dead-letter-queue-query';
import { evaluateDeadLetterQueueAlert } from '../src/alerting/dead-letter-queue-evaluate';
import { buildSlackMessage, type AlertPayload } from '../src/alerting/notify';
import type { QueueBacklogMetrics } from '../src/alerting/queue-backlog';

const ACCOUNT_ID = 'test-account-123';
const API_TOKEN = 'synthetic-queues-read-token';
const DLQ_ID = 'a'.repeat(32);
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues`;
const MARK_KEY = `o11y:dead_letter_queue:${DEAD_LETTER_QUEUE_NAME}`;
const COOLDOWN_KEY = `o11y:alert:page:dead_letter_queue:cloudflare:${DEAD_LETTER_QUEUE_NAME}:queues`;

function makeSecret(value: string | null): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

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

function makeEnv(kv: KVNamespace = makeKv(), token: string | null = API_TOKEN) {
  return {
    O11Y_ALERT_STATE: kv,
    O11Y_CF_ACCOUNT_ID: ACCOUNT_ID,
    O11Y_CF_CONTAINERS_API_TOKEN: makeSecret(token),
    O11Y_SLACK_WEBHOOK_PAGE: makeSecret('https://hooks.slack.com/page'),
    O11Y_SLACK_WEBHOOK_TICKET: makeSecret('https://hooks.slack.com/ticket'),
  };
}

function queuePage(queues: Array<{ queue_name: string; queue_id: string }>, totalPages = 1) {
  return Response.json({ success: true, result: queues, result_info: { total_pages: totalPages } });
}

function metrics(backlogCount: number) {
  return Response.json({
    success: true,
    result: {
      backlog_count: backlogCount,
      backlog_bytes: backlogCount * 100,
      oldest_message_timestamp_ms: backlogCount > 0 ? 1_780_560_000_000 : 0,
    },
  });
}

describe('dead-letter queue config', () => {
  it('pages for the production usage-ingest DLQ', () => {
    expect(DEAD_LETTER_QUEUE_NAME).toBe('usage-ingest-processing-dlq-eu');
    expect(DEAD_LETTER_QUEUE_SEVERITY).toBe('page');
  });
});

describe('queryDeadLetterQueue', () => {
  it('resolves the queue id by exact name and reads its realtime backlog', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, authorization: new Headers(init?.headers).get('Authorization') });
      if (url.includes('/metrics')) return metrics(3);
      const page = new URL(url).searchParams.get('page');
      return page === '1'
        ? queuePage(
            [{ queue_name: `${DEAD_LETTER_QUEUE_NAME}-other`, queue_id: 'b'.repeat(32) }],
            2
          )
        : queuePage([{ queue_name: DEAD_LETTER_QUEUE_NAME, queue_id: DLQ_ID }], 2);
    };

    await expect(queryDeadLetterQueue(makeEnv(), fetchFn)).resolves.toEqual({
      queueId: DLQ_ID,
      backlogCount: 3,
      backlogBytes: 300,
      oldestMessageTimestamp: new Date(1_780_560_000_000),
    });
    expect(calls.map(call => call.url)).toEqual([
      `${BASE}?name=${DEAD_LETTER_QUEUE_NAME}&page=1`,
      `${BASE}?name=${DEAD_LETTER_QUEUE_NAME}&page=2`,
      `${BASE}/${DLQ_ID}/metrics`,
    ]);
    expect(calls.every(call => call.authorization === `Bearer ${API_TOKEN}`)).toBe(true);
  });

  it.each([
    ['the queue is missing', queuePage([])],
    [
      'two queues share the name',
      queuePage([
        { queue_name: DEAD_LETTER_QUEUE_NAME, queue_id: DLQ_ID },
        { queue_name: DEAD_LETTER_QUEUE_NAME, queue_id: 'b'.repeat(32) },
      ]),
    ],
    [
      'the queue id is malformed',
      queuePage([{ queue_name: DEAD_LETTER_QUEUE_NAME, queue_id: '../x' }]),
    ],
    ['the lookup returns HTTP 403', new Response(null, { status: 403 })],
    [
      'the lookup reports success false',
      Response.json({ success: false, errors: [{ message: 'denied' }] }),
    ],
    ['pagination is incomplete', queuePage([], 0.5)],
  ])('fails closed when %s', async (_label, lookup) => {
    let metricsCalls = 0;
    const fetchFn = async (url: string) => {
      if (url.includes('/metrics')) {
        metricsCalls += 1;
        return metrics(1);
      }
      return lookup.clone();
    };
    const error = await queryDeadLetterQueue(makeEnv(), fetchFn).then(
      () => expect.fail('expected a failure'),
      (caught: unknown) => caught
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(API_TOKEN);
    expect(metricsCalls).toBe(0);
  });

  it('fails before any request when the token is missing', async () => {
    let calls = 0;
    const fetchFn = async () => {
      calls += 1;
      return metrics(0);
    };
    await expect(queryDeadLetterQueue(makeEnv(makeKv(), null), fetchFn)).rejects.toThrow(
      'O11Y_CF_CONTAINERS_API_TOKEN secret is not configured'
    );
    expect(calls).toBe(0);
  });
});

describe('evaluateDeadLetterQueueAlert', () => {
  function harness() {
    const kv = makeKv();
    const sent: AlertPayload[] = [];
    let backlog = 0;
    const query = async (): Promise<QueueBacklogMetrics> => ({
      queueId: DLQ_ID,
      backlogCount: backlog,
      backlogBytes: backlog * 100,
      oldestMessageTimestamp: backlog > 0 ? new Date('2026-11-10T12:00:00.000Z') : undefined,
    });
    const notify = async (alert: AlertPayload) => {
      sent.push(alert);
    };
    const tick = async (count: number) => {
      backlog = count;
      await evaluateDeadLetterQueueAlert(makeEnv(kv), query, notify);
    };
    const expireCooldown = () => kv.store.delete(COOLDOWN_KEY);
    return { kv, sent, tick, expireCooldown };
  }

  it('stays silent while the DLQ is empty', async () => {
    const { kv, sent, tick } = harness();
    await tick(0);
    await tick(0);
    expect(sent).toEqual([]);
    expect(kv.store.size).toBe(0);
  });

  it('pages once when a message arrives and records the count and cooldown', async () => {
    const { kv, sent, tick } = harness();
    await tick(2);
    await tick(2);
    expect(sent).toEqual([
      {
        alertType: 'dead_letter_queue',
        severity: 'page',
        provider: 'cloudflare',
        model: DEAD_LETTER_QUEUE_NAME,
        clientName: 'queues',
        queueId: DLQ_ID,
        backlogCount: 2,
        newMessages: 2,
        backlogBytes: 200,
        oldestMessageTimestamp: new Date('2026-11-10T12:00:00.000Z'),
      },
    ]);
    expect(kv.store.get(MARK_KEY)).toBe('2');
    expect(kv.store.has(COOLDOWN_KEY)).toBe(true);
  });

  it('pages again for new arrivals only after the page cooldown', async () => {
    const { sent, tick, expireCooldown } = harness();
    await tick(2);
    await tick(5);
    expect(sent).toHaveLength(1);
    expireCooldown();
    await tick(5);
    expect(sent.map(alert => 'newMessages' in alert && alert.newMessages)).toEqual([2, 3]);
  });

  it('pages for arrivals after the backlog shrank by replay or expiry', async () => {
    const { sent, tick, expireCooldown } = harness();
    await tick(10);
    await tick(1);
    expireCooldown();
    await tick(4);
    expect(sent.map(alert => 'backlogCount' in alert && alert.backlogCount)).toEqual([10, 4]);
    expect(sent.map(alert => 'newMessages' in alert && alert.newMessages)).toEqual([10, 3]);
  });

  it('re-arms after the DLQ empties', async () => {
    const { sent, tick, expireCooldown } = harness();
    await tick(1);
    await tick(0);
    expireCooldown();
    await tick(1);
    expect(sent).toHaveLength(2);
  });

  it('treats an unreadable stored count as empty', async () => {
    const { kv, sent, tick } = harness();
    kv.store.set(MARK_KEY, 'not-a-count');
    await tick(1);
    expect(sent).toHaveLength(1);
    expect(kv.store.get(MARK_KEY)).toBe('1');
  });

  it('keeps no new state when notification fails, so the next run retries', async () => {
    const kv = makeKv();
    const query = async (): Promise<QueueBacklogMetrics> => ({
      queueId: DLQ_ID,
      backlogCount: 1,
      backlogBytes: 100,
    });
    const failing = async () => {
      throw new Error('Slack webhook failed (500)');
    };
    await expect(evaluateDeadLetterQueueAlert(makeEnv(kv), query, failing)).rejects.toThrow(
      'Slack webhook failed (500)'
    );
    expect(kv.store.size).toBe(0);
  });
});

describe('buildSlackMessage — dead_letter_queue alert', () => {
  it('names the queue, the counts and the runbook', () => {
    const message = buildSlackMessage({
      alertType: 'dead_letter_queue',
      severity: 'page',
      provider: 'cloudflare',
      model: DEAD_LETTER_QUEUE_NAME,
      clientName: 'queues',
      queueId: DLQ_ID,
      backlogCount: 1_500,
      newMessages: 3,
      backlogBytes: 150_000,
      oldestMessageTimestamp: new Date('2026-11-10T12:00:00.000Z'),
    });
    const text = JSON.stringify(message);
    expect(text).toContain(':rotating_light: PAGE');
    expect(text).toContain('Dead-Letter Queue Alert');
    expect(text).toContain(DEAD_LETTER_QUEUE_NAME);
    expect(text).toContain('1,500 messages');
    expect(text).toContain('3 since last alert');
    expect(text).toContain('2026-11-10T12:00:00.000Z');
    expect(text).toContain('services/usage-ingest/README.md#dead-letter-alert');
  });
});
