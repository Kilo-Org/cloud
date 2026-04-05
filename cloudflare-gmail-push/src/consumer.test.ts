import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleQueue } from './consumer';
import type { AppEnv, GmailPushQueueMessage } from './types';

const TEST_USER = 'user123';
const TEST_MESSAGE_ID = 'pubsub-msg-1';
const TEST_PUBSUB_BODY = JSON.stringify({ message: { data: 'dGVzdA==' } });
const TEST_HISTORY_ID = '3525';
const TEST_PUBSUB_DATA = btoa(
  JSON.stringify({ emailAddress: 'user@gmail.com', historyId: TEST_HISTORY_ID })
);
const TEST_PUBSUB_BODY_WITH_HISTORY = JSON.stringify({
  message: { data: TEST_PUBSUB_DATA, messageId: '123' },
  subscription: 'projects/test/subscriptions/test-sub',
});

function createMockMessage(body: GmailPushQueueMessage): {
  body: GmailPushQueueMessage;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
} {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function createMockIdempotencyStub(isDuplicate = false) {
  return {
    checkAndMark: vi.fn().mockResolvedValue(isDuplicate),
  };
}

function createMockEnv(
  kiloclawFetch: ReturnType<typeof vi.fn>,
  idempotencyStub = createMockIdempotencyStub()
) {
  const queueSend = vi.fn().mockResolvedValue(undefined);
  const idFromName = vi.fn().mockReturnValue('do-id');
  const env = {
    KILOCLAW: { fetch: kiloclawFetch } as unknown as Fetcher,
    OIDC_AUDIENCE_BASE: 'https://kiloclaw-gmail.kiloapps.io',
    INTERNAL_API_SECRET: { get: () => Promise.resolve('test-internal-secret') },
    GMAIL_PUSH_QUEUE: { send: queueSend } as unknown as Queue<GmailPushQueueMessage>,
    IDEMPOTENCY: {
      idFromName,
      get: vi.fn().mockReturnValue(idempotencyStub),
    },
  } as unknown as AppEnv;
  return { env, queueSend, idFromName };
}

function createBatch(
  messages: ReturnType<typeof createMockMessage>[]
): MessageBatch<GmailPushQueueMessage> {
  return {
    messages,
    queue: 'gmail-push-notifications',
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<GmailPushQueueMessage>;
}

function mockKiloclawResponses(
  status: {
    flyAppName: string | null;
    flyMachineId: string | null;
    status: string | null;
    gmailNotificationsEnabled?: boolean;
  },
  gatewayToken?: string
) {
  return vi.fn((req: Request) => {
    const url = new URL(req.url);
    if (url.pathname.includes('status')) {
      return Promise.resolve(new Response(JSON.stringify(status)));
    }
    if (url.pathname.includes('gateway-token') && gatewayToken) {
      return Promise.resolve(new Response(JSON.stringify({ gatewayToken })));
    }
    if (url.pathname.includes('gmail-history-id')) {
      return Promise.resolve(new Response('ok', { status: 200 }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

describe('handleQueue', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('re-enqueues with backoff when machine is not running', async () => {
    const kiloclawFetch = mockKiloclawResponses({
      flyAppName: null,
      flyMachineId: null,
      status: 'stopped',
    });
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ delaySeconds: 60 })
    );
  });

  it('acks without forwarding when gmail notifications are disabled', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      {
        flyAppName: 'test-app',
        flyMachineId: 'machine-abc',
        status: 'running',
        gmailNotificationsEnabled: false,
      },
      'gw-token-xyz'
    );
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn();
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
    // Should NOT forward to controller
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('re-enqueues with backoff when kiloclaw status lookup fails', async () => {
    const kiloclawFetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it('re-enqueues with backoff when gateway token lookup fails', async () => {
    const kiloclawFetch = vi.fn((req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.includes('status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              flyAppName: 'test-app',
              flyMachineId: 'machine-abc',
              status: 'running',
              gmailNotificationsEnabled: true,
            })
          )
        );
      }
      // gateway-token returns error
      return Promise.resolve(new Response('error', { status: 500 }));
    });
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it('acks on successful controller delivery', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      {
        flyAppName: 'test-app',
        flyMachineId: 'machine-abc',
        status: 'running',
        gmailNotificationsEnabled: true,
      },
      'gw-token-xyz'
    );
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();

    // Verify correct headers on controller request
    const fetchCalls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const [url, init] = fetchCalls[0] as [string, RequestInit];
    expect(url).toBe('https://test-app.fly.dev/_kilo/gmail-pubsub');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers['authorization']).toBe('Bearer gw-token-xyz');
    expect(headers['fly-force-instance-id']).toBe('machine-abc');
    expect(init.body).toBe(TEST_PUBSUB_BODY);
  });

  it('acks on controller 400 (permanent error)', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      {
        flyAppName: 'test-app',
        flyMachineId: 'machine-abc',
        status: 'running',
        gmailNotificationsEnabled: true,
      },
      'gw-token-xyz'
    );
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('bad request', { status: 400 }));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('retries on controller 401 (transient auth error)', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      {
        flyAppName: 'test-app',
        flyMachineId: 'machine-abc',
        status: 'running',
        gmailNotificationsEnabled: true,
      },
      'gw-token-xyz'
    );
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ delaySeconds: 60 })
    );
  });

  it('re-enqueues with backoff on controller 5xx', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      {
        flyAppName: 'test-app',
        flyMachineId: 'machine-abc',
        status: 'running',
        gmailNotificationsEnabled: true,
      },
      'gw-token-xyz'
    );
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ delaySeconds: 60 })
    );
  });

  it('re-enqueues with backoff on controller network error', async () => {
    const kiloclawFetch = mockKiloclawResponses(
      {
        flyAppName: 'test-app',
        flyMachineId: 'machine-abc',
        status: 'running',
        gmailNotificationsEnabled: true,
      },
      'gw-token-xyz'
    );
    const { env, queueSend } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network error'));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
    expect(queueSend).toHaveBeenCalledOnce();
  });

  it('updates gmail history id on DO after successful delivery', async () => {
    const kiloclawFetch = vi.fn((req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.includes('status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              flyAppName: 'test-app',
              flyMachineId: 'machine-abc',
              status: 'running',
              gmailNotificationsEnabled: true,
            })
          )
        );
      }
      if (url.pathname.includes('gateway-token')) {
        return Promise.resolve(new Response(JSON.stringify({ gatewayToken: 'gw-token-xyz' })));
      }
      if (url.pathname.includes('gmail-history-id')) {
        return Promise.resolve(new Response('ok', { status: 200 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const { env } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY_WITH_HISTORY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();

    const historyIdCall = kiloclawFetch.mock.calls.find((call: [Request]) =>
      new URL(call[0].url).pathname.includes('gmail-history-id')
    );
    expect(historyIdCall).toBeDefined();
    const historyIdReq = historyIdCall![0];
    const body = JSON.parse(await historyIdReq.text()) as { userId: string; historyId: string };
    expect(body.userId).toBe(TEST_USER);
    expect(body.historyId).toBe(TEST_HISTORY_ID);
  });

  it('still acks if gmail-history-id update fails', async () => {
    const kiloclawFetch = vi.fn((req: Request) => {
      const url = new URL(req.url);
      if (url.pathname.includes('status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              flyAppName: 'test-app',
              flyMachineId: 'machine-abc',
              status: 'running',
              gmailNotificationsEnabled: true,
            })
          )
        );
      }
      if (url.pathname.includes('gateway-token')) {
        return Promise.resolve(new Response(JSON.stringify({ gatewayToken: 'gw-token-xyz' })));
      }
      if (url.pathname.includes('gmail-history-id')) {
        return Promise.resolve(new Response('server error', { status: 500 }));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });
    const { env } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: TEST_PUBSUB_BODY_WITH_HISTORY,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('still acks if pubsub data cannot be decoded', async () => {
    const invalidBody = JSON.stringify({ message: { data: '!!!invalid!!!' } });
    const kiloclawFetch = mockKiloclawResponses(
      {
        flyAppName: 'test-app',
        flyMachineId: 'machine-abc',
        status: 'running',
        gmailNotificationsEnabled: true,
      },
      'gw-token-xyz'
    );
    const { env } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const msg = createMockMessage({
      userId: TEST_USER,
      pubSubBody: invalidBody,
      messageId: TEST_MESSAGE_ID,
    });
    const batch = createBatch([msg]);

    await handleQueue(batch, env);

    expect(msg.ack).toHaveBeenCalledOnce();
    expect(msg.retry).not.toHaveBeenCalled();
  });

  it('handles multiple messages independently', async () => {
    const kiloclawFetch = vi.fn((req: Request) => {
      const url = new URL(req.url);
      const userId = url.searchParams.get('userId');
      if (url.pathname.includes('status')) {
        if (userId === 'user-ok') {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                flyAppName: 'app-ok',
                flyMachineId: 'machine-ok',
                status: 'running',
                gmailNotificationsEnabled: true,
              })
            )
          );
        }
        // user-stopped has no machine
        return Promise.resolve(
          new Response(JSON.stringify({ flyAppName: null, flyMachineId: null, status: 'stopped' }))
        );
      }
      if (url.pathname.includes('gateway-token')) {
        return Promise.resolve(new Response(JSON.stringify({ gatewayToken: 'gw-ok' })));
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    });

    const { env, queueSend } = createMockEnv(kiloclawFetch);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));

    const msgOk = createMockMessage({
      userId: 'user-ok',
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: 'msg-ok',
    });
    const msgStopped = createMockMessage({
      userId: 'user-stopped',
      pubSubBody: TEST_PUBSUB_BODY,
      messageId: 'msg-stopped',
    });
    const batch = createBatch([msgOk, msgStopped]);

    await handleQueue(batch, env);

    expect(msgOk.ack).toHaveBeenCalledOnce();
    expect(msgOk.retry).not.toHaveBeenCalled();
    expect(msgStopped.ack).toHaveBeenCalledOnce();
    expect(msgStopped.retry).not.toHaveBeenCalled();
    // msgStopped should have triggered a re-enqueue
    expect(queueSend).toHaveBeenCalled();
  });

  describe('exponential backoff', () => {
    it('doubles delay on each retry attempt', async () => {
      const kiloclawFetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
      const { env, queueSend } = createMockEnv(kiloclawFetch);

      // Attempt 2 → delay = 60 * 2^2 = 240s
      const msg = createMockMessage({
        userId: TEST_USER,
        pubSubBody: TEST_PUBSUB_BODY,
        messageId: TEST_MESSAGE_ID,
        attempt: 2,
      });
      const batch = createBatch([msg]);

      await handleQueue(batch, env);

      expect(queueSend).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 3 }),
        expect.objectContaining({ delaySeconds: 240 })
      );
    });

    it('drops message after max retries exceeded', async () => {
      const kiloclawFetch = vi.fn().mockResolvedValue(new Response('error', { status: 500 }));
      const { env, queueSend } = createMockEnv(kiloclawFetch);

      const msg = createMockMessage({
        userId: TEST_USER,
        pubSubBody: TEST_PUBSUB_BODY,
        messageId: TEST_MESSAGE_ID,
        attempt: 6,
      });
      const batch = createBatch([msg]);

      await handleQueue(batch, env);

      expect(msg.ack).toHaveBeenCalledOnce();
      expect(queueSend).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('skips duplicate messages on first delivery (attempt 0)', async () => {
      const kiloclawFetch = vi.fn();
      const idempotencyStub = createMockIdempotencyStub(true);
      const { env } = createMockEnv(kiloclawFetch, idempotencyStub);
      const msg = createMockMessage({
        userId: TEST_USER,
        pubSubBody: TEST_PUBSUB_BODY,
        messageId: TEST_MESSAGE_ID,
      });
      const batch = createBatch([msg]);

      await handleQueue(batch, env);

      expect(msg.ack).toHaveBeenCalledOnce();
      expect(kiloclawFetch).not.toHaveBeenCalled();
    });

    it('skips idempotency check on retry attempts (attempt > 0)', async () => {
      const kiloclawFetch = mockKiloclawResponses(
        {
          flyAppName: 'test-app',
          flyMachineId: 'machine-abc',
          status: 'running',
          gmailNotificationsEnabled: true,
        },
        'gw-token-xyz'
      );
      const idempotencyStub = createMockIdempotencyStub(true); // would block if called
      const { env } = createMockEnv(kiloclawFetch, idempotencyStub);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const msg = createMockMessage({
        userId: TEST_USER,
        pubSubBody: TEST_PUBSUB_BODY,
        messageId: TEST_MESSAGE_ID,
        attempt: 1,
      });
      const batch = createBatch([msg]);

      await handleQueue(batch, env);

      expect(idempotencyStub.checkAndMark).not.toHaveBeenCalled();
      expect(msg.ack).toHaveBeenCalledOnce();
    });

    it('keys idempotency DO by userId', async () => {
      const kiloclawFetch = mockKiloclawResponses(
        {
          flyAppName: 'test-app',
          flyMachineId: 'machine-abc',
          status: 'running',
          gmailNotificationsEnabled: true,
        },
        'gw-token-xyz'
      );
      const { env, idFromName } = createMockEnv(kiloclawFetch);
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
      const msg = createMockMessage({
        userId: TEST_USER,
        pubSubBody: TEST_PUBSUB_BODY,
        messageId: TEST_MESSAGE_ID,
      });
      const batch = createBatch([msg]);

      await handleQueue(batch, env);

      expect(idFromName).toHaveBeenCalledWith(TEST_USER);
    });
  });
});
