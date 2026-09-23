import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MockSocket = {
  url: string;
  message: (data: string) => void;
  closeFromServer: (code?: number, reason?: string) => void;
  errorFromServer: (error?: unknown) => void;
  closeCalls: number;
};

const sockets = vi.hoisted(() => ({
  instances: [] as MockSocket[],
}));

vi.mock('ws', () => ({
  default: class {
    private readonly handlers = new Map<string, (...args: unknown[]) => void>();
    private readonly observed: MockSocket;

    constructor(url: string) {
      this.observed = {
        url,
        message: data => this.handlers.get('message')?.(Buffer.from(data)),
        closeFromServer: (code = 1006, reason = '') => this.handlers.get('close')?.(code, reason),
        errorFromServer: error => this.handlers.get('error')?.(error ?? new Error('ws error')),
        closeCalls: 0,
      };
      sockets.instances.push(this.observed);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      this.handlers.set(event, handler);
      return this;
    }

    close(): void {
      this.observed.closeCalls += 1;
      queueMicrotask(() => this.handlers.get('close')?.(1005, ''));
    }
  },
}));

import {
  createWorktreeChat,
  fakeDirective,
  fetchFakeRequests,
  fetchFakeScenarioStatus,
  fetchFakeWaiters,
  getMessageResult,
  isMessageCompleted,
  openConnectedStream,
  openStream,
  prepareBrowserSession,
  releaseGate,
  startSession,
  trpcCall,
  waitForGateEngaged,
  type DriverConfig,
  type StreamEvent,
} from '../../e2e/client.js';

const SESSION_ID = 'workspace_11111111-1111-4111-8111-111111111111';

const baseConfig: DriverConfig = {
  workerUrl: 'http://worker.test',
  user: { id: 'user_1', email: 'user@example.test', api_token_pepper: 'pepper' },
  nextAuthSecret: 'test-secret',
  gitUrl: 'https://example.test/repo.git',
  model: 'kilo/fake-deterministic',
  fakeLlmUrl: 'http://fake.test',
};

function okEnvelope(data: unknown): Response {
  return new Response(JSON.stringify({ result: { data } }), { status: 200 });
}

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

  it('scopes the fake side channel and directives when E2E_FAKE_SCOPE is set', async () => {
    const previous = process.env.E2E_FAKE_SCOPE;
    process.env.E2E_FAKE_SCOPE = 'shardA';
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    try {
      expect(fakeDirective('echo:hi')).toBe('__e2e_scope__:shardA\n__fake__:echo:hi');
      await fetchFakeRequests(config.fakeLlmUrl);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        'http://fake.test/test/requests?scope=shardA'
      );
    } finally {
      if (previous === undefined) delete process.env.E2E_FAKE_SCOPE;
      else process.env.E2E_FAKE_SCOPE = previous;
    }
  });

  it('rejects a malformed E2E_FAKE_SCOPE', () => {
    const previous = process.env.E2E_FAKE_SCOPE;
    process.env.E2E_FAKE_SCOPE = 'bad scope';
    try {
      expect(() => fakeDirective('echo:hi')).toThrow(/E2E_FAKE_SCOPE/);
    } finally {
      if (previous === undefined) delete process.env.E2E_FAKE_SCOPE;
      else process.env.E2E_FAKE_SCOPE = previous;
    }
  });
});

describe('deadline cancellation', () => {
  it('cancels the in-flight getMessageResult request at the transport, not just the await', async () => {
    let resolveReceived: (() => void) | undefined;
    const received = new Promise<void>(resolve => {
      resolveReceived = resolve;
    });
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>(resolve => {
      resolveClosed = resolve;
    });
    // A real socket that never answers: the request stays pending until the
    // client aborts it. The server-side close is the proof that cancellation
    // reached the transport rather than only rejecting the awaited promise.
    const server = createServer((req, res) => {
      resolveReceived?.();
      req.on('close', () => resolveClosed?.());
      void res;
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no server port');
      const config: DriverConfig = {
        ...baseConfig,
        bearerToken: 'unit-token',
        nextAuthSecret: undefined,
        workerUrl: `http://127.0.0.1:${address.port}`,
      };
      const controller = new AbortController();
      const pending = getMessageResult(config, SESSION_ID, 'message_pending', controller.signal);
      await received;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await closed;
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('forwards the deadline signal into the gate poll and stops on abort', async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      observedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const pending = waitForGateEngaged(baseConfig, 'tag', 30_000, 5, controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    controller.abort();
    await expect(pending).resolves.toBe(false);
    expect(observedSignal?.aborted).toBe(true);
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

describe('trpcCall auth headers', () => {
  it('uses bearerToken verbatim and does not mint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okEnvelope({}));
    vi.stubGlobal('fetch', fetchMock);

    await trpcCall(
      { ...baseConfig, bearerToken: 'deployed-token', nextAuthSecret: undefined },
      'start',
      {}
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer deployed-token',
      'x-skip-balance-check': 'true',
    });
  });

  it('omits x-skip-balance-check only when skipBalanceCheck is false', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okEnvelope({})));
    vi.stubGlobal('fetch', fetchMock);

    await trpcCall({ ...baseConfig, bearerToken: 'token' }, 'start', {});
    const firstRequest = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(firstRequest?.headers).toMatchObject({ 'x-skip-balance-check': 'true' });

    await trpcCall({ ...baseConfig, bearerToken: 'token', skipBalanceCheck: false }, 'start', {});
    const secondRequest = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    const headers = secondRequest?.headers as Record<string, string> | undefined;
    if (!headers) throw new Error('Expected a second request');
    expect(headers['x-skip-balance-check']).toBeUndefined();
    expect(headers.Authorization).toBe('Bearer token');
  });
});

describe('openStream tickets', () => {
  beforeEach(() => {
    sockets.instances = [];
  });

  it('connects with options.ticket and does not mint', () => {
    const stream = openStream({ ...baseConfig, nextAuthSecret: undefined }, SESSION_ID, {
      ticket: 'prefetched-ticket',
    });
    expect(sockets.instances).toHaveLength(1);
    expect(sockets.instances[0]?.url).toContain('ticket=prefetched-ticket');
    stream.close();
  });

  it('fails closed without a ticket or nextAuthSecret', () => {
    expect(() => openStream({ ...baseConfig, nextAuthSecret: undefined }, SESSION_ID)).toThrow(
      /ticket/
    );
    expect(sockets.instances).toHaveLength(0);
  });
});

describe('openStream initial ticket resolution', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sockets.instances = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('creates no socket when the stream is closed while the initial ticket is pending', async () => {
    let resolveTicket: ((ticket: string) => void) | undefined;
    const fetchStreamTicket = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolveTicket = resolve;
        })
    );
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID
    );
    expect(sockets.instances).toHaveLength(0);

    stream.close();
    resolveTicket?.('late-ticket');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(sockets.instances).toHaveLength(0);
    expect(stream.isOpen).toBe(false);
  });

  it('creates no socket when aborted while the initial ticket is pending', async () => {
    const controller = new AbortController();
    let resolveTicket: ((ticket: string) => void) | undefined;
    const fetchStreamTicket = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolveTicket = resolve;
        })
    );
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      { signal: controller.signal }
    );

    controller.abort();
    resolveTicket?.('late-ticket');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(sockets.instances).toHaveLength(0);
    expect(stream.isOpen).toBe(false);
  });

  it('creates no socket and stays settled when the initial ticket rejects after close', async () => {
    let rejectTicket: ((error: unknown) => void) | undefined;
    const fetchStreamTicket = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectTicket = reject;
        })
    );
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID
    );

    stream.close();
    rejectTicket?.(new Error('ticket fetch failed after close'));
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(sockets.instances).toHaveLength(0);
    expect(stream.isOpen).toBe(false);
  });

  it('settles the connection and pending waits when the initial ticket is rejected', async () => {
    const failure = new Error('ticket fetch failed');
    const fetchStreamTicket = vi.fn().mockRejectedValue(failure);
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID
    );
    const pending = stream.waitFor(() => false, 30_000);

    await expect(pending).resolves.toBeNull();
    expect(stream.isOpen).toBe(false);
    expect(sockets.instances).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith('session stream connection failed', failure);
  });

  it('uses fetchStreamTicket over nextAuthSecret for the initial ticket and the retry', async () => {
    const fetchStreamTicket = vi.fn().mockResolvedValue('fetched-ticket');
    const stream = openStream({ ...baseConfig, fetchStreamTicket }, SESSION_ID);

    await vi.waitFor(() => expect(sockets.instances).toHaveLength(1));
    expect(fetchStreamTicket).toHaveBeenCalledTimes(1);
    expect(sockets.instances[0]?.url).toContain('ticket=fetched-ticket');

    sockets.instances[0]?.errorFromServer(new Error('handshake rejected'));
    await vi.waitFor(() => expect(sockets.instances).toHaveLength(2));

    expect(fetchStreamTicket).toHaveBeenCalledTimes(2);
    expect(sockets.instances[1]?.url).toContain('ticket=fetched-ticket');
    stream.close();
  });
});

describe('openConnectedStream', () => {
  beforeEach(() => {
    sockets.instances = [];
  });

  it('fetches the ticket and opens the connected stream for the deployed profile', async () => {
    const fetchStreamTicket = vi.fn().mockResolvedValue('connected-ticket');
    const streamPromise = openConnectedStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      false
    );

    await vi.waitFor(() => expect(sockets.instances).toHaveLength(1));
    const socket = sockets.instances[0];
    if (!socket) throw new Error('Missing stream socket');
    expect(socket.url).toContain('ticket=connected-ticket');
    expect(socket.url).toContain('replay=false');

    socket.message(JSON.stringify(event('connected', {})));
    const stream = await streamPromise;
    expect(stream.isOpen).toBe(true);
    stream.close();
  });
});

describe('openStream handshake retry', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    sockets.instances = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('retries exactly once with a fresh ticket, then surfaces the error', async () => {
    const fetchStreamTicket = vi.fn().mockResolvedValue('fresh-ticket');
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      { ticket: 'stale-ticket' }
    );
    expect(sockets.instances).toHaveLength(1);

    sockets.instances[0]?.errorFromServer(new Error('handshake rejected'));
    await vi.waitFor(() => expect(sockets.instances).toHaveLength(2));

    expect(fetchStreamTicket).toHaveBeenCalledTimes(1);
    expect(sockets.instances[1]?.url).toContain('ticket=fresh-ticket');

    const secondError = new Error('second failure');
    sockets.instances[1]?.errorFromServer(secondError);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sockets.instances).toHaveLength(2);
    expect(fetchStreamTicket).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('session stream connection failed', secondError);
    stream.close();
  });

  it('settles pending waits on explicit close while a ticket refresh is unresolved', async () => {
    let resolveTicket: ((ticket: string) => void) | undefined;
    const fetchStreamTicket = vi.fn(
      () =>
        new Promise<string>(resolve => {
          resolveTicket = resolve;
        })
    );
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      { ticket: 'stale-ticket' }
    );
    const pending = stream.waitFor(() => false, 30_000);

    sockets.instances[0]?.errorFromServer(new Error('handshake rejected'));
    expect(fetchStreamTicket).toHaveBeenCalledTimes(1);

    stream.close();
    await expect(pending).resolves.toBeNull();
    expect(sockets.instances).toHaveLength(1);

    resolveTicket?.('fresh-ticket');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(sockets.instances).toHaveLength(1);
  });

  it('still retries when ws emits close after the handshake error', async () => {
    const fetchStreamTicket = vi.fn().mockResolvedValue('fresh-ticket');
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      { ticket: 'stale-ticket' }
    );

    const firstSocket = sockets.instances[0];
    firstSocket?.errorFromServer(new Error('handshake rejected'));
    firstSocket?.closeFromServer();

    await vi.waitFor(() => expect(sockets.instances).toHaveLength(2));
    expect(sockets.instances[1]?.url).toContain('ticket=fresh-ticket');
    stream.close();
  });

  it('keeps pending waits and routes events through the reconnected socket', async () => {
    const fetchStreamTicket = vi.fn().mockResolvedValue('fresh-ticket');
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      { ticket: 'stale-ticket' }
    );
    const terminal = stream.waitForTerminal(1_000, 'message_1');

    sockets.instances[0]?.errorFromServer(new Error('handshake rejected'));
    await vi.waitFor(() => expect(sockets.instances).toHaveLength(2));

    sockets.instances[1]?.message(JSON.stringify(event('complete', { messageIds: ['message_1'] })));
    await expect(terminal).resolves.toMatchObject({ streamEventType: 'complete' });
    stream.close();
  });

  it('logs the ticket-refresh error and creates no replacement socket when the refresh rejects', async () => {
    const refreshError = new Error('Failed to fetch stream ticket: 401 Unauthorized');
    const fetchStreamTicket = vi.fn().mockRejectedValue(refreshError);
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      { ticket: 'stale-ticket' }
    );
    const pending = stream.waitFor(() => false, 30_000);

    sockets.instances[0]?.errorFromServer(new Error('handshake rejected'));

    await vi.waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('session stream connection failed', refreshError)
    );
    await expect(pending).resolves.toBeNull();
    expect(sockets.instances).toHaveLength(1);
    expect(fetchStreamTicket).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it('falls back to null when no retry ticket source is configured', async () => {
    const stream = openStream({ ...baseConfig, nextAuthSecret: undefined }, SESSION_ID, {
      ticket: 'stale-ticket',
    });
    const pending = stream.waitFor(() => false, 30_000);
    const handshakeError = new Error('handshake rejected');

    sockets.instances[0]?.errorFromServer(handshakeError);

    await expect(pending).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith('session stream connection failed', handshakeError);
    expect(sockets.instances).toHaveLength(1);
    stream.close();
  });
});

describe('openStream closeInfo', () => {
  beforeEach(() => {
    sockets.instances = [];
  });

  it('records the first close code/reason and ignores a superseded socket', async () => {
    const fetchStreamTicket = vi.fn().mockResolvedValue('fresh-ticket');
    const stream = openStream(
      { ...baseConfig, nextAuthSecret: undefined, fetchStreamTicket },
      SESSION_ID,
      { ticket: 'stale-ticket' }
    );

    const superseded = sockets.instances[0];
    if (!superseded) throw new Error('Missing stream socket');
    // The handshake fails and the single retry opens a second socket, so the
    // first socket is now a superseded generation.
    superseded.errorFromServer(new Error('handshake rejected'));
    await vi.waitFor(() => expect(sockets.instances).toHaveLength(2));
    const current = sockets.instances[1];
    if (!current) throw new Error('Missing retried stream socket');

    current.closeFromServer(1011, 'server internal error');
    expect(stream.closeInfo).toEqual({ code: 1011, reason: 'server internal error' });
    expect(stream.isOpen).toBe(false);

    // The superseded socket's later close must not overwrite the first cause.
    superseded.closeFromServer(1006, 'superseded');
    expect(stream.closeInfo).toEqual({ code: 1011, reason: 'server internal error' });

    stream.close();
  });

  it('keeps the first close when the current socket closes again', () => {
    const stream = openStream({ ...baseConfig, nextAuthSecret: undefined }, SESSION_ID, {
      ticket: 'ticket',
    });
    const socket = sockets.instances[0];
    if (!socket) throw new Error('Missing stream socket');

    socket.closeFromServer(1006, 'first close');
    expect(stream.closeInfo).toEqual({ code: 1006, reason: 'first close' });

    // A second close from the same (current) generation must not overwrite it.
    socket.closeFromServer(1011, 'second close');
    expect(stream.closeInfo).toEqual({ code: 1006, reason: 'first close' });

    stream.close();
  });
});

describe('prepare transport', () => {
  const SECRET = 'e2e-internal-secret-0123456789';
  const prepareConfig: DriverConfig = {
    ...baseConfig,
    internalApiSecret: SECRET,
  };

  type SeenRequest = { url: string; headers: Record<string, string> };
  const seen: SeenRequest[] = [];

  beforeEach(() => {
    seen.length = 0;
  });

  function installFetch(responses: Array<(request: SeenRequest) => Response>): void {
    let index = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        const request = {
          url: String(url),
          headers: (init?.headers ?? {}) as Record<string, string>,
        };
        seen.push(request);
        const respond = responses[Math.min(index, responses.length - 1)];
        index += 1;
        if (!respond) throw new Error('unexpected fetch');
        return respond(request);
      })
    );
  }

  it('routes the legacy prepareSession to /trpc/prepareSession with the internal key', async () => {
    installFetch([
      () => okEnvelope({ cloudAgentSessionId: SESSION_ID, kiloSessionId: 'ses_prepare_1' }),
      () =>
        okEnvelope({
          cloudAgentSessionId: SESSION_ID,
          executionId: 'exec_1',
          messageId: 'message_1',
          delivery: 'sent',
        }),
    ]);

    const started = await startSession(prepareConfig, { prompt: 'echo:hi' }, 'legacy');

    expect(seen[0].url).toBe('http://worker.test/trpc/prepareSession');
    expect(seen[0].headers['x-internal-api-key']).toBe(SECRET);
    expect(seen[1].url).toBe('http://worker.test/trpc/initiateFromKilocodeSessionV2');
    expect(started).toMatchObject({ cloudAgentSessionId: SESSION_ID, messageId: 'message_1' });
  });

  it('routes prepareBrowserSession to /trpc/prepareSession with the internal key', async () => {
    installFetch([
      () => okEnvelope({ cloudAgentSessionId: SESSION_ID, kiloSessionId: 'ses_prepare_2' }),
    ]);

    const prepared = await prepareBrowserSession(prepareConfig, { prompt: 'echo:hi' });

    expect(seen[0].url).toBe('http://worker.test/trpc/prepareSession');
    expect(seen[0].headers['x-internal-api-key']).toBe(SECRET);
    expect(prepared.cloudAgentSessionId).toBe(SESSION_ID);
  });

  it('never targets the removed surface prepare route', async () => {
    installFetch([
      () => okEnvelope({ cloudAgentSessionId: SESSION_ID, kiloSessionId: 'ses_prepare_3' }),
      () =>
        okEnvelope({
          cloudAgentSessionId: SESSION_ID,
          executionId: 'exec_1',
          messageId: 'message_1',
          delivery: 'sent',
        }),
    ]);

    await startSession(prepareConfig, { prompt: 'echo:hi' }, 'legacy');

    expect(seen.some(request => request.url.includes('/__e2e/'))).toBe(false);
  });

  it('makes no prepare request without an internal secret', async () => {
    installFetch([() => okEnvelope({})]);

    await expect(startSession(baseConfig, { prompt: 'echo:hi' }, 'legacy')).rejects.toThrow(
      /INTERNAL_API_SECRET/
    );
    await expect(prepareBrowserSession(baseConfig, { prompt: 'echo:hi' })).rejects.toThrow(
      /INTERNAL_API_SECRET/
    );
    expect(seen).toHaveLength(0);
  });

  it('does not route createWorktreeChat to the surface', async () => {
    installFetch([() => okEnvelope({ cloudAgentSessionId: SESSION_ID })]);

    await createWorktreeChat(prepareConfig, {
      sourceKiloSessionId: 'ses_1',
      sourceCloudAgentSessionId: SESSION_ID,
    });

    expect(seen[0].url).toBe('http://worker.test/trpc/createWorktreeChat');
    expect(seen[0].headers['x-internal-api-key']).toBe(SECRET);
  });
});

describe('create helper session tracking', () => {
  const SECRET = 'e2e-internal-secret-0123456789';
  const trackingConfig: DriverConfig = { ...baseConfig, internalApiSecret: SECRET };

  it('reports the returned id after prepareBrowserSession resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okEnvelope({ cloudAgentSessionId: SESSION_ID, kiloSessionId: 'ses_1' }))
    );
    const onSessionCreated = vi.fn();

    const prepared = await prepareBrowserSession(
      { ...trackingConfig, onSessionCreated },
      { prompt: 'echo:hi' }
    );

    expect(prepared.cloudAgentSessionId).toBe(SESSION_ID);
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
    expect(onSessionCreated).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not report an id when prepareBrowserSession rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const onSessionCreated = vi.fn();

    await expect(
      prepareBrowserSession({ ...trackingConfig, onSessionCreated }, { prompt: 'echo:hi' })
    ).rejects.toThrow();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });

  it('reports the returned id after createWorktreeChat resolves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okEnvelope({ cloudAgentSessionId: SESSION_ID, kiloSessionId: 'ses_2' }))
    );
    const onSessionCreated = vi.fn();

    const created = await createWorktreeChat(
      { ...trackingConfig, onSessionCreated },
      { sourceKiloSessionId: 'ses_1', sourceCloudAgentSessionId: SESSION_ID }
    );

    expect(created.cloudAgentSessionId).toBe(SESSION_ID);
    expect(onSessionCreated).toHaveBeenCalledTimes(1);
    expect(onSessionCreated).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not report an id when createWorktreeChat rejects', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
    const onSessionCreated = vi.fn();

    await expect(
      createWorktreeChat(
        { ...trackingConfig, onSessionCreated },
        { sourceKiloSessionId: 'ses_1', sourceCloudAgentSessionId: SESSION_ID }
      )
    ).rejects.toThrow();
    expect(onSessionCreated).not.toHaveBeenCalled();
  });
});
