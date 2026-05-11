import { createUserWebConnection } from './user-web-connection';

const WS_URL = 'wss://localhost:9999/api/user/web';

type MockWebSocket = {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close: jest.Mock;
  send: jest.Mock;
  readyState: number;
};

let sockets: MockWebSocket[];
let webSocketConstructor: jest.Mock;

beforeEach(() => {
  sockets = [];
  webSocketConstructor = jest.fn(() => {
    const ws: MockWebSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close: jest.fn(() => {
        ws.readyState = 3;
      }),
      send: jest.fn(),
      readyState: 0,
    };
    sockets.push(ws);
    return ws;
  });
  // @ts-expect-error minimal WebSocket mock
  global.WebSocket = webSocketConstructor;
  (global.WebSocket as unknown as Record<string, number>).OPEN = 1;
  jest
    .spyOn(crypto, 'randomUUID')
    .mockReturnValue('req-1' as `${string}-${string}-${string}-${string}-${string}`);
});

afterEach(() => {
  // @ts-expect-error cleanup global mock
  delete global.WebSocket;
  jest.restoreAllMocks();
});

function open(ws = sockets.at(-1)): void {
  if (ws) ws.readyState = 1;
  ws?.onopen?.({} as Event);
}

function inbound(msg: Record<string, unknown>, ws = sockets.at(-1)): void {
  ws?.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
}

function createDeferred<T>() {
  let resolvePromise: ((value: T) => void) | null = null;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!resolvePromise) throw new Error('Deferred promise was not initialized');
      resolvePromise(value);
    },
  };
}

describe('createUserWebConnection', () => {
  it('uses one socket for multiple consumers', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });

    client.connect();
    client.connect();

    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    expect(webSocketConstructor).toHaveBeenCalledWith(`${WS_URL}?token=token`);
    client.destroy();
  });

  it('deduplicates async auth and socket startup for concurrent connect calls', async () => {
    const auth = createDeferred<string>();
    const getAuthToken = jest.fn(() => auth.promise);
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });

    client.connect();
    client.connect();
    client.connect();

    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(webSocketConstructor).not.toHaveBeenCalled();

    auth.resolve('async-token');
    await Promise.resolve();
    await Promise.resolve();

    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    expect(webSocketConstructor).toHaveBeenCalledWith(`${WS_URL}?token=async-token`);
    client.destroy();
  });

  it('shares one pending startup across provider, hooks, transport, and commands', async () => {
    const auth = createDeferred<string>();
    const getAuthToken = jest.fn(() => auth.promise);
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });

    client.connect();
    const release = client.subscribeToCliSession('ses-1');
    const command = client.sendCommand('ses-1', 'send_message', { ok: true });

    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(webSocketConstructor).not.toHaveBeenCalled();

    auth.resolve('shared-token');
    await Promise.resolve();
    await Promise.resolve();

    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    open();
    await Promise.resolve();

    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
    );
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command',
        id: 'req-1',
        command: 'send_message',
        sessionId: 'ses-1',
        data: { ok: true },
      })
    );

    inbound({ type: 'response', id: 'req-1', result: { done: true } });
    await expect(command).resolves.toEqual({ done: true });
    release();
    client.destroy();
  });

  it('does not open a late socket after disconnect during pending auth', async () => {
    const auth = createDeferred<string>();
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: () => auth.promise,
    });

    client.connect();
    client.disconnect();
    auth.resolve('late-token');
    await Promise.resolve();
    await Promise.resolve();

    expect(webSocketConstructor).not.toHaveBeenCalled();
  });

  it('does not open a late socket after destroy during pending auth', async () => {
    const auth = createDeferred<string>();
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: () => auth.promise,
    });

    client.connect();
    client.destroy();
    auth.resolve('late-token');
    await Promise.resolve();
    await Promise.resolve();

    expect(webSocketConstructor).not.toHaveBeenCalled();
  });

  it('connect is a no-op after destroy', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();
    client.destroy();

    // After destroy, connect() should be a no-op
    client.connect();

    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
  });

  it('connect works after disconnect (unlike destroy)', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    client.disconnect();

    // After disconnect, connect() should open a new socket
    client.connect();
    open();

    expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it('ref-counts subscribe and unsubscribe for one session', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const releaseA = client.subscribeToCliSession('ses-1');
    const releaseB = client.subscribeToCliSession('ses-1');
    open();

    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
    );

    releaseA();
    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    releaseB();
    expect(sockets[0].send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: 'ses-1' })
    );
    client.destroy();
  });

  it('keeps independent ref counts for different sessions', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const releaseA = client.subscribeToCliSession('ses-1');
    const releaseB = client.subscribeToCliSession('ses-2');
    open();

    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
    );
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'ses-2' })
    );

    releaseA();
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: 'ses-1' })
    );
    expect(sockets[0].send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: 'ses-2' })
    );
    releaseB();
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: 'ses-2' })
    );
    client.destroy();
  });

  it('resubscribes retained sessions and calls reconnect listeners', () => {
    jest.useFakeTimers();
    try {
      const onReconnect = jest.fn();
      const client = createUserWebConnection({
        websocketUrl: WS_URL,
        getAuthToken: () => 'token',
        onReconnect,
      });
      client.subscribeToCliSession('ses-1');
      open();
      inbound({
        type: 'system',
        event: 'sessions.list',
        data: { connectionId: 'c1', sessions: [] },
      });
      sockets[0].onclose?.({ code: 1006 } as CloseEvent);
      jest.advanceTimersByTime(60_000);
      open(sockets[1]);
      inbound(
        { type: 'system', event: 'sessions.list', data: { connectionId: 'c2', sessions: [] } },
        sockets[1]
      );

      expect(sockets[1].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
      );
      expect(onReconnect).toHaveBeenCalledTimes(1);
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('reopens cleanly after disconnect', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    client.disconnect();
    client.connect();

    expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('reconnects stale shared sockets through browser lifecycle hooks', async () => {
    const lifecycleHandler: { current: ((event: { persisted: boolean }) => void) | null } = {
      current: null,
    };
    const removePageshow = jest.fn();
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: () => 'token',
      lifecycleHooks: {
        onPageshow: handler => {
          lifecycleHandler.current = handler;
          return removePageshow;
        },
      },
    });

    client.connect();
    open();
    const handlePageshow = lifecycleHandler.current;
    if (!handlePageshow) throw new Error('Expected pageshow lifecycle handler');

    handlePageshow({ persisted: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    client.destroy();
    expect(removePageshow).toHaveBeenCalledTimes(1);
  });

  it('routes command responses by request id', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', { ok: true });
    await Promise.resolve();
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command',
        id: 'req-1',
        command: 'send_message',
        sessionId: 'ses-1',
        data: { ok: true },
      })
    );
    inbound({ type: 'response', id: 'req-1', result: { done: true } });

    await expect(promise).resolves.toEqual({ done: true });
    client.destroy();
  });

  it('routes CLI events by sessionId or parentSessionId', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const events: unknown[] = [];
    client.onCliEvent('ses-1', event => events.push(event));
    client.connect();
    open();

    inbound({ type: 'event', sessionId: 'ses-1', event: 'message.updated', data: { a: 1 } });
    inbound({
      type: 'event',
      sessionId: 'child',
      parentSessionId: 'ses-1',
      event: 'message.part.updated',
      data: { b: 2 },
    });
    inbound({ type: 'event', sessionId: 'other', event: 'message.updated', data: { c: 3 } });

    expect(events).toHaveLength(2);
    client.destroy();
  });

  it('routes semantic session events to typed listeners', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const created = jest.fn();
    const updated = jest.fn();
    const status = jest.fn();
    const deleted = jest.fn();
    client.onSessionEvent('session.created', created);
    client.onSessionEvent('session.updated', updated);
    client.onSessionEvent('session.status.updated', status);
    client.onSessionEvent('session.deleted', deleted);
    client.connect();
    open();

    inbound({
      type: 'system',
      event: 'session.created',
      data: {
        source: 'v2',
        changedAt: 'now',
        session: {
          source: 'v2',
          sessionId: 'ses-1',
          createdAt: 'now',
          updatedAt: 'now',
          title: null,
          createdOnPlatform: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          parentSessionId: null,
          status: null,
          statusUpdatedAt: null,
        },
      },
    });
    inbound({
      type: 'system',
      event: 'session.updated',
      data: {
        source: 'v2',
        changedAt: 'now',
        session: {
          source: 'v2',
          sessionId: 'ses-1',
          createdAt: 'now',
          updatedAt: 'now',
          title: 't',
          createdOnPlatform: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          parentSessionId: null,
          status: null,
          statusUpdatedAt: null,
        },
      },
    });
    inbound({
      type: 'system',
      event: 'session.status.updated',
      data: {
        source: 'v2',
        sessionId: 'ses-1',
        previousStatus: null,
        status: 'busy',
        statusUpdatedAt: 'now',
        changedAt: 'now',
      },
    });
    inbound({
      type: 'system',
      event: 'session.status.updated',
      data: {
        source: 'v2',
        session: {
          source: 'v2',
          sessionId: 'ses-1',
          createdAt: 'now',
          updatedAt: 'now',
          title: 't',
          createdOnPlatform: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          parentSessionId: null,
          status: 'idle',
          statusUpdatedAt: 'now',
        },
        previousStatus: 'busy',
        status: 'idle',
        statusUpdatedAt: 'now',
        changedAt: 'now',
      },
    });
    inbound({
      type: 'system',
      event: 'session.deleted',
      data: {
        source: 'v2',
        sessionId: 'ses-1',
        parentSessionId: null,
        organizationId: null,
        gitUrl: null,
        gitBranch: null,
        createdOnPlatform: null,
        deletedAt: 'now',
      },
    });

    expect(created).toHaveBeenCalledTimes(1);
    expect(updated).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
    expect(deleted).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('waits for connecting socket before sending commands', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });

    const promise = client.sendCommand('ses-1', 'send_message', { ok: true });
    expect(sockets[0].send).not.toHaveBeenCalled();

    open();
    await Promise.resolve();
    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command',
        id: 'req-1',
        command: 'send_message',
        sessionId: 'ses-1',
        data: { ok: true },
      })
    );
    inbound({ type: 'response', id: 'req-1', result: { done: true } });

    await expect(promise).resolves.toEqual({ done: true });
    client.destroy();
  });

  it('rejects commands when token lookup throws before a socket opens', async () => {
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: () => {
        throw new Error('token unavailable');
      },
    });
    let rejectionMessage: string | null = null;

    try {
      void client.sendCommand('ses-1', 'send_message', {}).catch(error => {
        rejectionMessage = error instanceof Error ? error.message : String(error);
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(rejectionMessage).toBe('Failed to get auth token');
      expect(webSocketConstructor).not.toHaveBeenCalled();
    } finally {
      client.destroy();
    }
  });

  it('rejects commands when async token lookup fails before a socket opens', async () => {
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: () => Promise.reject(new Error('token unavailable')),
    });
    let rejectionMessage: string | null = null;

    try {
      void client.sendCommand('ses-1', 'send_message', {}).catch(error => {
        rejectionMessage = error instanceof Error ? error.message : String(error);
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(rejectionMessage).toBe('Failed to get auth token');
      expect(webSocketConstructor).not.toHaveBeenCalled();
    } finally {
      client.destroy();
    }
  });

  it('disconnect rejects commands waiting for open', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });

    const promise = client.sendCommand('ses-1', 'send_message', {});
    client.disconnect();

    await expect(promise).rejects.toThrow('Connection disconnected');
  });

  it('destroy rejects pending commands', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', {});
    client.destroy();

    await expect(promise).rejects.toThrow('Connection destroyed');
  });
});
