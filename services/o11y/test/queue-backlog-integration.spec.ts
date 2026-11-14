import { afterEach, describe, expect, it, vi } from 'vitest';
import { MONITORED_QUEUE_ID } from '../src/alerting/queue-backlog';
import { evaluateAlerts } from '../src/alerting/evaluate';
import { NATIVE_CONTAINER_APP } from '../src/alerting/container-allocations';
import { DEAD_LETTER_QUEUE_NAME } from '../src/alerting/dead-letter-queue';

const DLQ_ID = 'd'.repeat(32);

function deadLetterQueueResponse(url: string, backlogCount: number): Response | undefined {
  if (url.includes(`/queues?name=${DEAD_LETTER_QUEUE_NAME}&page=1`)) {
    return Response.json({
      success: true,
      result: [{ queue_name: DEAD_LETTER_QUEUE_NAME, queue_id: DLQ_ID }],
      result_info: { total_pages: 1 },
    });
  }
  if (url.includes(`/queues/${DLQ_ID}/metrics`)) {
    return Response.json({
      success: true,
      result: { backlog_count: backlogCount, backlog_bytes: 0, oldest_message_timestamp_ms: 0 },
    });
  }
  return undefined;
}

function makeSecret(value: string): SecretsStoreSecret {
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

function makeUnavailableAlertConfigNamespace(): Env['ALERT_CONFIG_DO'] {
  return {
    idFromName: () => 'global' as unknown as DurableObjectId,
    get: () => {
      throw new Error('alert config unavailable');
    },
  } as unknown as Env['ALERT_CONFIG_DO'];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evaluateAlerts infrastructure isolation', () => {
  it.each([false, true])(
    'isolates infrastructure failures (native runtime unavailable: %s)',
    async nativeUnavailable => {
      const kv = makeKv();
      const slackMessages: unknown[] = [];
      const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/containers/dash/applications')) {
          return Response.json({ success: true, result: [], result_info: { total_pages: 1 } });
        }
        if (url.includes('/containers/applications/native-id/instances-v2')) {
          return Response.json({
            success: true,
            result: Array.from({ length: 5000 }, (_, index) => ({
              id: `instance-${index}`,
              status: { state: 'running' },
            })),
            result_info: {},
          });
        }
        if (url.includes('/containers/applications?')) {
          if (nativeUnavailable) return new Response(null, { status: 503 });
          return Response.json({
            success: true,
            result: [
              { id: 'native-id', name: NATIVE_CONTAINER_APP, scheduling_policy: 'durable_object' },
            ],
            result_info: {},
          });
        }
        if (url.includes(`/queues/${MONITORED_QUEUE_ID}/metrics`)) {
          return Response.json({
            success: true,
            result: {
              backlog_count: 50_000,
              backlog_bytes: 12_345_678,
              oldest_message_timestamp_ms: 1_780_560_000_000,
            },
          });
        }
        const deadLetterQueue = deadLetterQueueResponse(url, 0);
        if (deadLetterQueue) return deadLetterQueue;
        if (url === 'https://hooks.slack.com/page') {
          slackMessages.push(JSON.parse(String(init?.body)));
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      });
      vi.stubGlobal('fetch', fetchFn);

      const env = {
        ALERT_CONFIG_DO: makeUnavailableAlertConfigNamespace(),
        O11Y_ALERT_STATE: kv,
        O11Y_CF_ACCOUNT_ID: 'test-account',
        O11Y_CF_AE_API_TOKEN: makeSecret('ae-token'),
        O11Y_CF_CONTAINERS_API_TOKEN: makeSecret('read-token'),
        O11Y_SLACK_WEBHOOK_PAGE: makeSecret('https://hooks.slack.com/page'),
        O11Y_SLACK_WEBHOOK_TICKET: makeSecret('https://hooks.slack.com/ticket'),
      } as Env;

      await expect(evaluateAlerts(env)).rejects.toThrow(
        `Alert evaluation failed with ${nativeUnavailable ? 3 : 2} error(s)`
      );

      expect(
        fetchFn.mock.calls.some(([input]) =>
          String(input).includes('/containers/dash/applications')
        )
      ).toBe(true);
      expect(slackMessages).toHaveLength(nativeUnavailable ? 1 : 2);
      expect(JSON.stringify(slackMessages)).toContain('Queue Backlog Alert');
      if (!nativeUnavailable) {
        expect(JSON.stringify(slackMessages)).toContain('Container Allocation Alert');
        expect(
          kv.store.has(
            `o11y:alert:page:container_capacity:cloudflare:${NATIVE_CONTAINER_APP}:containers`
          )
        ).toBe(true);
      }
      expect(kv.store.has(`o11y:queue_backlog:${MONITORED_QUEUE_ID}`)).toBe(true);
      expect(JSON.stringify(slackMessages)).not.toContain('Dead-Letter Queue Alert');
    }
  );
});

describe('evaluateAlerts dead-letter queue', () => {
  function stubFetch(deadLetterQueue: 'messages' | 'unavailable') {
    const slackMessages: Array<{ webhook: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/queues/${MONITORED_QUEUE_ID}/metrics`)) {
          return Response.json({
            success: true,
            result: { backlog_count: 50_000, backlog_bytes: 1, oldest_message_timestamp_ms: 0 },
          });
        }
        if (deadLetterQueue === 'messages') {
          const response = deadLetterQueueResponse(url, 4);
          if (response) return response;
        }
        if (url.startsWith('https://hooks.slack.com/')) {
          slackMessages.push({ webhook: url, body: JSON.parse(String(init?.body)) });
          return new Response(null, { status: 200 });
        }
        return new Response(null, { status: 404 });
      })
    );
    return slackMessages;
  }

  function makeEnv(kv: KVNamespace): Env {
    return {
      ALERT_CONFIG_DO: makeUnavailableAlertConfigNamespace(),
      O11Y_ALERT_STATE: kv,
      O11Y_CF_ACCOUNT_ID: 'test-account',
      O11Y_CF_AE_API_TOKEN: makeSecret('ae-token'),
      O11Y_CF_CONTAINERS_API_TOKEN: makeSecret('read-token'),
      O11Y_SLACK_WEBHOOK_PAGE: makeSecret('https://hooks.slack.com/page'),
      O11Y_SLACK_WEBHOOK_TICKET: makeSecret('https://hooks.slack.com/ticket'),
    } as unknown as Env;
  }

  it('pages the on-call webhook when the usage-ingest DLQ holds messages', async () => {
    const kv = makeKv();
    const slackMessages = stubFetch('messages');
    await expect(evaluateAlerts(makeEnv(kv))).rejects.toThrow('Alert evaluation failed');
    const deadLetter = slackMessages.filter(message =>
      JSON.stringify(message.body).includes('Dead-Letter Queue Alert')
    );
    expect(deadLetter.map(message => message.webhook)).toEqual(['https://hooks.slack.com/page']);
    expect(JSON.stringify(slackMessages)).toContain('Queue Backlog Alert');
    expect(kv.store.get(`o11y:dead_letter_queue:${DEAD_LETTER_QUEUE_NAME}`)).toBe('4');
  });

  it('reports a DLQ lookup failure without blocking the queue backlog alert', async () => {
    const kv = makeKv();
    const slackMessages = stubFetch('unavailable');
    const error = await evaluateAlerts(makeEnv(kv)).then(
      () => expect.fail('expected a failure'),
      (caught: unknown) => caught
    );
    expect(String((error as Error).message)).toContain('dead_letter_queue evaluation');
    expect(JSON.stringify(slackMessages)).toContain('Queue Backlog Alert');
    expect(JSON.stringify(slackMessages)).not.toContain('Dead-Letter Queue Alert');
  });
});
