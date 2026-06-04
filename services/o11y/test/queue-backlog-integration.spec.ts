import { afterEach, describe, expect, it, vi } from 'vitest';
import { MONITORED_QUEUE_ID } from '../src/alerting/queue-backlog';
import { evaluateAlerts } from '../src/alerting/evaluate';

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

describe('evaluateAlerts queue backlog integration', () => {
  it('sends a page alert even when SLO configuration is unavailable', async () => {
    const kv = makeKv();
    const slackMessages: unknown[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/containers/dash/applications')) {
        return Response.json({ success: true, result: [], result_info: { total_pages: 1 } });
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

    await expect(evaluateAlerts(env)).rejects.toThrow('Alert evaluation failed with 2 error(s)');

    expect(slackMessages).toHaveLength(1);
    expect(JSON.stringify(slackMessages[0])).toContain('Queue Backlog Alert');
    expect(kv.store.has(`o11y:queue_backlog:${MONITORED_QUEUE_ID}`)).toBe(true);
  });
});
