import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateAlerts } from '../src/alerting/evaluate';
import { MONITORED_QUEUE_ID } from '../src/alerting/queue-backlog';
import { DEAD_LETTER_QUEUE_NAME } from '../src/alerting/dead-letter-queue';

const NAME = 'usage-ingest-processing-eu';
const ID = 'a'.repeat(32);
const DLQ_ID = 'd'.repeat(32);
const KEY = `o11y:queue_backlog:${ID}`;
const secret = (value: string) => ({ get: async () => value }) as SecretsStoreSecret;

function harness() {
  const store = new Map<string, string>();
  const sent: Array<{ url: string; body: string }> = [];
  let count = 0;
  let failure = '';
  const calls: string[] = [];
  const metrics = (backlog: number) =>
    Response.json({
      success: true,
      result: {
        backlog_count: backlog,
        backlog_bytes: 123456,
        oldest_message_timestamp_ms: 1780560000000,
      },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.includes(`/queues?name=${NAME}&`)) {
        if (failure === 'lookup-http') return new Response(null, { status: 403 });
        if (failure === 'lookup-api') return Response.json({ success: false });
        if (failure === 'schema') return Response.json({ success: true, result: [] });
        const page = new URL(url).searchParams.get('page');
        const queue = { queue_name: NAME, queue_id: failure === 'id' ? '../bad' : ID };
        return Response.json({
          success: true,
          result:
            failure === 'missing'
              ? []
              : failure === 'ambiguous'
                ? [queue, queue]
                : page === '1'
                  ? [{ queue_name: `${NAME}-other`, queue_id: ID }]
                  : [queue],
          result_info: {
            total_pages: failure === 'pagination' ? 21 : failure === 'fraction' ? 1.5 : 2,
          },
        });
      }
      if (url.includes(`/queues/${ID}/metrics`)) {
        if (failure === 'metrics-http') return new Response(null, { status: 503 });
        if (failure === 'metrics-api') return Response.json({ success: false });
        if (failure === 'metrics-schema') return Response.json({ success: true, result: {} });
        return metrics(count);
      }
      if (url.includes(`/queues/${MONITORED_QUEUE_ID}/metrics`)) return metrics(50000);
      if (url.includes(`/queues?name=${DEAD_LETTER_QUEUE_NAME}&`))
        return Response.json({
          success: true,
          result: [{ queue_name: DEAD_LETTER_QUEUE_NAME, queue_id: DLQ_ID }],
          result_info: { total_pages: 1 },
        });
      if (url.includes(`/queues/${DLQ_ID}/metrics`)) return metrics(1);
      if (url.startsWith('https://hooks.slack.com/')) {
        const body = String(init?.body);
        if (failure === 'notify' && body.includes(NAME)) return new Response(null, { status: 503 });
        sent.push({ url, body });
        return new Response(null, { status: 200 });
      }
      if (url.includes('/containers/dash/applications'))
        return Response.json({
          success: true,
          result: [],
          result_info: { total_pages: 1 },
        });
      return new Response(null, { status: 503 });
    })
  );
  const env = {
    ALERT_CONFIG_DO: {
      idFromName: () => 'global',
      get: () => {
        throw new Error('config unavailable');
      },
    },
    O11Y_ALERT_STATE: {
      get: async (key: string) => store.get(key) ?? null,
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
    },
    O11Y_CF_ACCOUNT_ID: 'test-account',
    O11Y_CF_CONTAINERS_API_TOKEN: secret('synthetic-token'),
    O11Y_SLACK_WEBHOOK_PAGE: secret('https://hooks.slack.com/page'),
    O11Y_SLACK_WEBHOOK_TICKET: secret('https://hooks.slack.com/ticket'),
  } as unknown as Env;
  return {
    store,
    sent,
    calls,
    usage: () => sent.filter(item => item.body.includes(NAME)),
    tick: async (backlog: number, fail = '') => {
      count = backlog;
      failure = fail;
      // Other infrastructure deliberately fails: the real scheduled evaluator must continue.
      return evaluateAlerts(env).then(
        () => '',
        (error: Error) => error.message
      );
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('scheduled main usage queue backlog alert', () => {
  it('polls exact paginated name without logs, crosses thresholds and pages only once while active', async () => {
    const h = harness();
    for (const n of [24999, 25000, 25000, 50000, 149999, 150000, 150000, 250000]) await h.tick(n);
    expect(h.usage().map(item => item.url)).toEqual([
      'https://hooks.slack.com/ticket',
      'https://hooks.slack.com/page',
    ]);
    const body = h.usage()[0].body;
    for (const value of [
      NAME,
      ID,
      '25,000',
      '123,456',
      '2026-06-04T08:00:00.000Z',
      'services/usage-ingest/README.md#main-queue-backlog-alert',
    ])
      expect(body).toContain(value);
    expect(h.calls.some(url => url.includes(`name=${NAME}&page=2`))).toBe(true);
    expect(h.store.has(KEY)).toBe(true);
    expect(h.store.has(`o11y:queue_backlog:${MONITORED_QUEUE_ID}`)).toBe(true);
    expect(h.sent.some(item => item.body.includes('Dead-Letter Queue Alert'))).toBe(true);
  });

  it('re-arms only after three below-threshold observations', async () => {
    const h = harness();
    for (const n of [50000, 0, 0, 50000]) await h.tick(n);
    expect(h.usage()).toHaveLength(1);
    for (const n of [0, 0, 0, 25000, 50000]) await h.tick(n);
    expect(h.usage()).toHaveLength(3);
  });

  it('pages at 50k even when the first sample is much higher, then re-arms after recovery', async () => {
    const h = harness();
    await h.tick(920000);
    expect(h.usage()).toHaveLength(1);
    expect(h.usage()[0].body).toContain('PAGE');
    expect(h.usage()[0].body).toContain('*Threshold:*\\n50,000 messages');
    for (const n of [150000, 250000, 49999, 49999, 50000, 49999, 49999]) await h.tick(n);
    expect(h.usage()).toHaveLength(1);
    await h.tick(49999);
    await h.tick(250000);
    expect(h.usage()).toHaveLength(2);
    expect(h.usage()[1].body).toContain('*Threshold:*\\n50,000 messages');
  });

  it('preserves a previously persisted active page and resets its recovery streak above 50k', async () => {
    const h = harness();
    h.store.set(
      KEY,
      JSON.stringify({
        ticket: { active: true, consecutiveBelowCount: 0 },
        page: { active: true, consecutiveBelowCount: 2, nextThresholdCount: 150000 },
      })
    );
    await h.tick(250000);
    expect(h.usage()).toHaveLength(0);
    expect(JSON.parse(h.store.get(KEY) ?? '').page.consecutiveBelowCount).toBe(0);
    for (const n of [49999, 49999]) await h.tick(n);
    expect(h.usage()).toHaveLength(0);
    await h.tick(50000);
    expect(h.usage()).toHaveLength(0);
    for (const n of [49999, 49999, 49999, 50000]) await h.tick(n);
    expect(h.usage()).toHaveLength(1);
  });

  it('retries failed first and re-armed pages without recording them as sent', async () => {
    const h = harness();
    expect(await h.tick(250000, 'notify')).toContain('usage_queue_backlog evaluation');
    expect(h.store.has(KEY)).toBe(false);
    await h.tick(250000);
    expect(h.usage()).toHaveLength(1);
    for (const n of [49999, 49999, 49999]) await h.tick(n);
    const before = h.store.get(KEY);
    expect(await h.tick(150000, 'notify')).toContain('usage_queue_backlog evaluation');
    expect(h.store.get(KEY)).toBe(before);
    await h.tick(150000);
    expect(h.usage()).toHaveLength(2);
    await h.tick(250000);
    expect(h.usage()).toHaveLength(2);
  });

  it.each([
    'lookup-http',
    'lookup-api',
    'schema',
    'missing',
    'ambiguous',
    'id',
    'pagination',
    'fraction',
    'metrics-http',
    'metrics-api',
    'metrics-schema',
  ])('surfaces %s without healthy state or blocking other queue checks', async failure => {
    const h = harness();
    expect(await h.tick(50000, failure)).toContain('usage_queue_backlog evaluation');
    expect(h.store.has(KEY)).toBe(false);
    expect(h.usage()).toHaveLength(0);
    expect(h.store.has(`o11y:queue_backlog:${MONITORED_QUEUE_ID}`)).toBe(true);
    expect(h.sent.some(item => item.body.includes('Dead-Letter Queue Alert'))).toBe(true);
  });
});
