import { describe, expect, it } from 'vitest';
import { MONITORED_QUEUE_ID } from '../src/alerting/queue-backlog';
import { queryQueueBacklog } from '../src/alerting/queue-backlog-query';

const ACCOUNT_ID = 'test-account-123';
const API_TOKEN = 'test-token-abc';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function makeSecret(value: string | null): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeEnv(token: string | null = API_TOKEN) {
  return {
    O11Y_CF_ACCOUNT_ID: ACCOUNT_ID,
    O11Y_CF_CONTAINERS_API_TOKEN: makeSecret(token),
  };
}

describe('queryQueueBacklog', () => {
  it('fetches realtime metrics for the monitored queue', async () => {
    let calledUrl = '';
    let calledHeaders: HeadersInit | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      calledUrl = url;
      calledHeaders = init?.headers;
      return Response.json({
        success: true,
        result: {
          backlog_count: 30_000,
          backlog_bytes: 4_000_000,
          oldest_message_timestamp_ms: 1_780_560_000_000,
        },
      });
    };

    await expect(queryQueueBacklog(makeEnv(), fetchFn)).resolves.toEqual({
      queueId: MONITORED_QUEUE_ID,
      backlogCount: 30_000,
      backlogBytes: 4_000_000,
      oldestMessageTimestamp: new Date(1_780_560_000_000),
    });
    expect(calledUrl).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues/${MONITORED_QUEUE_ID}/metrics`
    );
    expect(new Headers(calledHeaders).get('Authorization')).toBe(`Bearer ${API_TOKEN}`);
  });

  it('omits the oldest timestamp when Cloudflare reports it as unknown', async () => {
    const fetchFn: FetchFn = async () =>
      Response.json({
        success: true,
        result: {
          backlog_count: 0,
          backlog_bytes: 0,
          oldest_message_timestamp_ms: 0,
        },
      });

    await expect(queryQueueBacklog(makeEnv(), fetchFn)).resolves.toEqual({
      queueId: MONITORED_QUEUE_ID,
      backlogCount: 0,
      backlogBytes: 0,
      oldestMessageTimestamp: undefined,
    });
  });

  it('throws when the Queue API rejects the request', async () => {
    const fetchFn: FetchFn = async () => new Response(null, { status: 403 });

    await expect(queryQueueBacklog(makeEnv(), fetchFn)).rejects.toThrow(
      'Queue metrics request failed (403)'
    );
  });

  it('includes Cloudflare errors from a successful HTTP response', async () => {
    const fetchFn: FetchFn = async () =>
      Response.json({
        success: false,
        errors: [{ code: 10000, message: 'Authentication error' }],
      });

    await expect(queryQueueBacklog(makeEnv(), fetchFn)).rejects.toThrow(
      'Queue metrics request failed: Authentication error'
    );
  });

  it('throws when the API token is not configured', async () => {
    const fetchFn: FetchFn = async () => Response.json({});

    await expect(queryQueueBacklog(makeEnv(null), fetchFn)).rejects.toThrow(
      'O11Y_CF_CONTAINERS_API_TOKEN secret is not configured'
    );
  });
});
