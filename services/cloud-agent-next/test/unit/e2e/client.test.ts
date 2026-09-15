import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockSocket = {
  message: (data: string) => void;
  closeFromServer: () => void;
  closeCalls: number;
};

const sockets = vi.hoisted(() => ({
  instances: [] as MockSocket[],
}));

vi.mock('ws', () => ({
  default: class {
    private readonly handlers = new Map<string, (value: unknown) => void>();
    private readonly observed: MockSocket;

    constructor() {
      this.observed = {
        message: data => this.handlers.get('message')?.(Buffer.from(data)),
        closeFromServer: () => this.handlers.get('close')?.(undefined),
        closeCalls: 0,
      };
      sockets.instances.push(this.observed);
    }

    on(event: string, handler: (value: unknown) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    close(): void {
      this.observed.closeCalls += 1;
      queueMicrotask(() => this.handlers.get('close')?.(undefined));
    }
  },
}));

import {
  fetchFakeRequests,
  fetchFakeScenarioStatus,
  fetchFakeWaiters,
  isMessageCompleted,
  openStream,
  releaseGate,
  startSession,
  waitForGateEngaged,
  type StreamEvent,
} from '../../e2e/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function event(streamEventType: string, data: Record<string, unknown>): StreamEvent {
  return {
    eventId: 1,
    executionId: null,
    sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
    streamEventType,
    timestamp: new Date(0).toISOString(),
    data,
  };
}

describe('isMessageCompleted', () => {
  beforeEach(() => {
    sockets.instances = [];
  });

  it('accepts matching legacy and cloud completion events only', () => {
    expect(isMessageCompleted(event('complete', { messageIds: ['message_1'] }), 'message_1')).toBe(
      true
    );
    expect(
      isMessageCompleted(event('cloud.message.completed', { messageId: 'message_1' }), 'message_1')
    ).toBe(true);
    expect(isMessageCompleted(event('complete', { messageIds: ['other'] }), 'message_1')).toBe(
      false
    );
    expect(
      isMessageCompleted(event('cloud.message.completed', { messageId: 'other' }), 'message_1')
    ).toBe(false);
  });

  it.each([
    ['complete', { messageIds: ['message_1'] }],
    ['cloud.message.completed', { messageId: 'message_1' }],
  ])('waitForTerminal resolves matching %s events', async (streamEventType, data) => {
    const stream = openStream(
      {
        workerUrl: 'http://worker.test',
        user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
        nextAuthSecret: 'test-secret',
        gitUrl: 'https://example.test/repo.git',
        model: 'kilo/fake-deterministic',
        fakeLlmUrl: 'http://fake.test',
      },
      'workspace_11111111-1111-4111-8111-111111111111'
    );
    const socket = sockets.instances[0];
    if (!socket) throw new Error('Missing stream socket');
    const terminal = stream.waitForTerminal(100, 'message_1');
    socket.message(JSON.stringify(event(streamEventType, data)));
    await expect(terminal).resolves.toMatchObject({ streamEventType, data });
    stream.close();
  });
});

describe('stream cancellation', () => {
  beforeEach(() => {
    sockets.instances = [];
  });

  it('detaches the abort listener when the server closes the socket', () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, 'addEventListener');
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const stream = openStream(
      {
        workerUrl: 'http://worker.test',
        user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
        nextAuthSecret: 'test-secret',
        gitUrl: 'https://example.test/repo.git',
        model: 'kilo/fake-deterministic',
        fakeLlmUrl: 'http://fake.test',
      },
      'workspace_11111111-1111-4111-8111-111111111111',
      { signal: controller.signal }
    );
    const socket = sockets.instances[0];
    if (!socket) throw new Error('Missing stream socket');
    const listener = addListener.mock.calls[0]?.[1];
    if (typeof listener !== 'function') throw new Error('Missing abort listener');

    socket.closeFromServer();
    expect(removeListener).toHaveBeenCalledWith('abort', listener);

    stream.close();
    controller.abort();
    expect(socket.closeCalls).toBe(0);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('settles pending waits when explicit close is followed by an async socket close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const controller = new AbortController();
      const addListener = vi.spyOn(controller.signal, 'addEventListener');
      const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
      const stream = openStream(
        {
          workerUrl: 'http://worker.test',
          user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
          nextAuthSecret: 'test-secret',
          gitUrl: 'https://example.test/repo.git',
          model: 'kilo/fake-deterministic',
          fakeLlmUrl: 'http://fake.test',
        },
        'workspace_11111111-1111-4111-8111-111111111111',
        { signal: controller.signal }
      );
      const socket = sockets.instances[0];
      if (!socket) throw new Error('Missing stream socket');
      const abortListener = addListener.mock.calls[0]?.[1];
      if (typeof abortListener !== 'function') throw new Error('Missing abort listener');

      let result: StreamEvent | null | undefined;
      const pending = stream.waitFor(() => false, 30_000);
      void pending.then(value => {
        result = value;
      });

      stream.close();
      controller.abort();
      stream.close();
      await new Promise<void>(resolve => queueMicrotask(resolve));
      await Promise.resolve();

      expect(result).toBeNull();
      expect(socket.closeCalls).toBe(1);
      expect(removeListener).toHaveBeenCalledWith('abort', abortListener);
      expect(removeListener).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fake LLM control helpers', () => {
  const config = {
    workerUrl: 'http://worker.test',
    user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
    nextAuthSecret: 'test-secret',
    gitUrl: 'https://example.test/repo.git',
    model: 'kilo/fake-deterministic',
    fakeLlmUrl: 'http://fake.test',
  };

  it('sends the resolved admin bearer on every /test/* side channel', async () => {
    const previous = process.env.FAKE_LLM_ADMIN_TOKEN;
    process.env.FAKE_LLM_ADMIN_TOKEN = 'configured-control-token';
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await releaseGate(config.fakeLlmUrl, 'tag with space');
      await fetchFakeWaiters(config.fakeLlmUrl);
      await fetchFakeRequests(config.fakeLlmUrl);
      await fetchFakeScenarioStatus(config.fakeLlmUrl, 'tag with space');
      const engaged = await waitForGateEngaged(config, 'tag with space', 20, 1);

      expect(engaged).toBe(false);
      expect(fetchMock.mock.calls.map(([url]) => String(url)).slice(0, 4)).toEqual([
        'http://fake.test/test/release?tag=tag%20with%20space',
        'http://fake.test/test/waiters',
        'http://fake.test/test/requests',
        'http://fake.test/test/scenario-status?tag=tag%20with%20space',
      ]);

      for (const [url, init] of fetchMock.mock.calls) {
        const headers = new Headers((init as RequestInit | undefined)?.headers);
        expect(headers.get('Authorization'), String(url)).toBe('Bearer configured-control-token');
      }
      expect(fetchMock.mock.calls.length).toBeGreaterThan(4);
    } finally {
      if (previous === undefined) delete process.env.FAKE_LLM_ADMIN_TOKEN;
      else process.env.FAKE_LLM_ADMIN_TOKEN = previous;
    }
  });
});

describe('startSession unified repository branch', () => {
  const config = {
    workerUrl: 'http://worker.test',
    user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
    nextAuthSecret: 'test-secret',
    gitUrl: 'https://example.test/repo.git',
    model: 'kilo/fake-deterministic',
    fakeLlmUrl: 'http://fake.test',
  };

  it.each([
    ['omitted', undefined, { type: 'git', url: config.gitUrl }],
    [
      'provided',
      'refs/pull/23/head',
      { type: 'git', url: config.gitUrl, branch: 'refs/pull/23/head' },
    ],
  ] as const)('keeps repository shape when branch is %s', async (_name, branch, repository) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            data: {
              cloudAgentSessionId: 'workspace_11111111-1111-4111-8111-111111111111',
              kiloSessionId: 'kilo_1',
              messageId: 'message_1',
              delivery: 'queued',
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    await startSession(config, {
      prompt: 'start session',
      ...(branch === undefined ? {} : { branch }),
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    if (typeof request?.body !== 'string') throw new Error('Expected a JSON request body');
    const body = JSON.parse(request.body);
    expect(body.repository).toEqual(repository);
  });
});
