import { configureCloudAgentSdkRuntime, resetCloudAgentSdkRuntime } from './runtime';
import {
  createUserWebConnection,
  VIEWER_PING_INTERVAL_MS,
  VIEWER_PONG_TIMEOUT_MS,
} from './user-web-connection';

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
  let nextId = 0;
  configureCloudAgentSdkRuntime({ randomUUID: () => `uuid-${++nextId}` });
});

afterEach(() => {
  resetCloudAgentSdkRuntime();
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
  it('retains a global connection until its final release and can be retained again', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });

    const releaseA = client.retain();
    const releaseB = client.retain();
    open();

    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    releaseA();
    expect(sockets[0].close).not.toHaveBeenCalled();
    releaseB();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);

    const releaseC = client.retain();
    expect(webSocketConstructor).toHaveBeenCalledTimes(2);
    releaseC();
    client.destroy();
  });

  it('does not retain the connection for listeners alone', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });

    client.onSystemEvent(jest.fn());
    client.onCliEvent('ses-1', jest.fn());
    client.onReconnect(jest.fn());
    client.onSessionEvent('session.created', jest.fn());

    expect(webSocketConstructor).not.toHaveBeenCalled();
    client.destroy();
  });

  it('uses one stable logical viewer id per instance and safely appends query parameters', () => {
    const client = createUserWebConnection({
      websocketUrl: `${WS_URL}?source=web`,
      getAuthToken: () => 'token with spaces',
    });
    const release = client.retain();

    expect(webSocketConstructor).toHaveBeenCalledWith(
      `${WS_URL}?source=web&token=token+with+spaces&connectionId=uuid-1`
    );
    release();

    const secondRelease = client.retain();
    expect(webSocketConstructor).toHaveBeenLastCalledWith(
      `${WS_URL}?source=web&token=token+with+spaces&connectionId=uuid-1`
    );
    secondRelease();

    const other = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const otherRelease = other.retain();
    expect(webSocketConstructor).toHaveBeenLastCalledWith(
      `${WS_URL}?token=token&connectionId=uuid-2`
    );
    otherRelease();
    client.destroy();
    other.destroy();
  });

  it('pings while globally retained without a session subscription and matching pong keeps it alive', () => {
    jest.useFakeTimers();
    try {
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
      const release = client.retain();
      open();

      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS);
      expect(sockets[0].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'ping', nonce: 'uuid-2' })
      );

      inbound({ type: 'pong', nonce: 'uuid-2' });
      jest.advanceTimersByTime(VIEWER_PONG_TIMEOUT_MS);
      expect(sockets).toHaveLength(1);

      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps pong internal rather than routing it as a system or session event', () => {
    jest.useFakeTimers();
    try {
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
      const systemListener = jest.fn();
      const sessionListener = jest.fn();
      client.onSystemEvent(systemListener);
      client.onSessionEvent('session.updated', sessionListener);
      const release = client.retain();
      open();

      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS);
      inbound({ type: 'pong', nonce: 'uuid-2' });

      expect(systemListener).not.toHaveBeenCalled();
      expect(sessionListener).not.toHaveBeenCalled();
      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('replaces an unresponsive retained socket with refreshed auth and restores subscriptions', async () => {
    jest.useFakeTimers();
    try {
      const getAuthToken = jest
        .fn()
        .mockReturnValueOnce('old-token')
        .mockResolvedValue('new-token');
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
      const release = client.subscribeToCliSession('ses-1');
      open();

      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS);
      inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
      inbound({ type: 'pong', nonce: 'wrong-nonce' });
      jest.advanceTimersByTime(VIEWER_PONG_TIMEOUT_MS);
      await Promise.resolve();
      await Promise.resolve();

      expect(sockets[0].close).toHaveBeenCalledTimes(1);
      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(webSocketConstructor).toHaveBeenLastCalledWith(
        `${WS_URL}?token=new-token&connectionId=uuid-1`
      );
      open(sockets[1]);
      expect(sockets[1].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
      );

      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('promptly rejects an in-flight command on auth-close refresh and restores subscriptions', async () => {
    const getAuthToken = jest.fn().mockReturnValueOnce('old-token').mockResolvedValue('new-token');
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
    const release = client.subscribeToCliSession('ses-1');
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    const command = client.sendCommand('ses-1', 'send_message', { ok: true });
    await Promise.resolve();

    sockets[0].onclose?.({ code: 4001 } as CloseEvent);
    await Promise.resolve();
    await Promise.resolve();

    await expect(command).rejects.toThrow('Connection lost during reconnect');
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    open(sockets[1]);
    expect(sockets[1].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
    );
    release();
    client.destroy();
  });

  it('releases command-only ownership when auth-close invalidates its socket', async () => {
    const getAuthToken = jest.fn().mockReturnValueOnce('old-token').mockResolvedValue('new-token');
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
    const command = client.sendCommand('ses-1', 'send_message', { ok: true });
    open();
    await Promise.resolve();

    sockets[0].onclose?.({ code: 4001 } as CloseEvent);
    await expect(command).rejects.toThrow('Connection lost during reconnect');
    await Promise.resolve();
    await Promise.resolve();

    expect(getAuthToken).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
    client.destroy();
  });

  it('promptly rejects an in-flight command when ping timeout replaces its retained socket', async () => {
    jest.useFakeTimers();
    try {
      const client = createUserWebConnection({
        websocketUrl: WS_URL,
        getAuthToken: jest.fn().mockReturnValueOnce('old-token').mockResolvedValue('new-token'),
      });
      const release = client.subscribeToCliSession('ses-1');
      open();

      jest.advanceTimersByTime(10_000);
      const command = client.sendCommand('ses-1', 'send_message', { ok: true });
      await Promise.resolve();
      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS);
      await Promise.resolve();
      await Promise.resolve();

      await expect(command).rejects.toThrow('Connection lost during reconnect');
      open(sockets[1]);
      expect(sockets[1].send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
      );
      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases a command-scoped lifetime when ping timeout replaces its socket', async () => {
    jest.useFakeTimers();
    try {
      const getAuthToken = jest
        .fn()
        .mockReturnValueOnce('old-token')
        .mockResolvedValue('new-token');
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
      const command = client.sendCommand('ses-1', 'send_message', { ok: true });
      open();
      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS);
      await Promise.resolve();

      jest.advanceTimersByTime(VIEWER_PONG_TIMEOUT_MS);
      await expect(command).rejects.toThrow('Connection lost during reconnect');
      await Promise.resolve();
      await Promise.resolve();

      expect(sockets[0].close).toHaveBeenCalledTimes(1);
      expect(getAuthToken).toHaveBeenCalledTimes(1);
      expect(sockets).toHaveLength(1);
      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS + VIEWER_PONG_TIMEOUT_MS);
      expect(sockets).toHaveLength(1);
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a command sent before first inbound data when online replaces the open socket', async () => {
    const onlineHandler: { current: (() => void) | null } = { current: null };
    const getAuthToken = jest.fn().mockReturnValueOnce('old-token').mockResolvedValue('new-token');
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken,
      lifecycleHooks: {
        onOnline: handler => {
          onlineHandler.current = handler;
          return jest.fn();
        },
      },
    });
    const release = client.subscribeToCliSession('ses-1');
    open();
    const command = client.sendCommand('ses-1', 'send_message', { ok: true });
    await Promise.resolve();
    const handleOnline = onlineHandler.current;
    if (!handleOnline) throw new Error('Expected online lifecycle handler');

    handleOnline();
    await Promise.resolve();
    await Promise.resolve();

    await expect(command).rejects.toThrow('Connection lost during reconnect');
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    open(sockets[1]);
    expect(sockets[1].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
    );
    release();
    client.destroy();
  });

  it('rejects an in-flight command on a second terminal auth-close', async () => {
    const getAuthToken = jest.fn().mockReturnValueOnce('old-token').mockResolvedValue('new-token');
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
    const release = client.subscribeToCliSession('ses-1');
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    sockets[0].onclose?.({ code: 4001 } as CloseEvent);
    await Promise.resolve();
    await Promise.resolve();
    open(sockets[1]);
    const command = client.sendCommand('ses-1', 'send_message', { ok: true });
    await Promise.resolve();

    sockets[1].onclose?.({ code: 4001 } as CloseEvent);

    await expect(command).rejects.toThrow('Connection lost during reconnect');
    expect(getAuthToken).toHaveBeenCalledTimes(2);
    release();
    client.destroy();
  });

  it('promptly rejects an in-flight command when lifecycle recovery replaces its retained socket', async () => {
    const lifecycleHandler: { current: ((event: { persisted: boolean }) => void) | null } = {
      current: null,
    };
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: jest.fn().mockReturnValueOnce('old-token').mockResolvedValue('new-token'),
      lifecycleHooks: {
        onPageshow: handler => {
          lifecycleHandler.current = handler;
          return jest.fn();
        },
      },
    });
    const release = client.subscribeToCliSession('ses-1');
    open();
    const command = client.sendCommand('ses-1', 'send_message', { ok: true });
    await Promise.resolve();

    const handlePageshow = lifecycleHandler.current;
    if (!handlePageshow) throw new Error('Expected pageshow lifecycle handler');
    handlePageshow({ persisted: true });
    await Promise.resolve();
    await Promise.resolve();

    await expect(command).rejects.toThrow('Connection lost during reconnect');
    open(sockets[1]);
    expect(sockets[1].send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', sessionId: 'ses-1' })
    );
    release();
    client.destroy();
  });

  it('promptly rejects an in-flight command when its socket unexpectedly disconnects', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const release = client.subscribeToCliSession('ses-1');
    open();
    const command = client.sendCommand('ses-1', 'send_message', { ok: true });
    let rejectionMessage: string | null = null;
    void command.catch(error => {
      rejectionMessage = error instanceof Error ? error.message : String(error);
    });
    await Promise.resolve();

    sockets[0].onclose?.({ code: 1006 } as CloseEvent);
    await Promise.resolve();

    expect(rejectionMessage).toBe('Connection lost during reconnect');
    release();
    client.destroy();
  });

  it('stops liveness probes after destroy', () => {
    jest.useFakeTimers();
    try {
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
      client.retain();
      open();
      client.destroy();

      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS + VIEWER_PONG_TIMEOUT_MS);
      expect(sockets[0].send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"ping"'));
      expect(sockets).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops liveness probes after final release', () => {
    jest.useFakeTimers();
    try {
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
      const release = client.retain();
      open();
      release();

      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS + VIEWER_PONG_TIMEOUT_MS);
      expect(sockets[0].send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"ping"'));
      expect(sockets).toHaveLength(1);
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses one socket for multiple consumers', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });

    client.connect();
    client.connect();

    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    expect(webSocketConstructor).toHaveBeenCalledWith(`${WS_URL}?token=token&connectionId=uuid-1`);
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
    expect(webSocketConstructor).toHaveBeenCalledWith(
      `${WS_URL}?token=async-token&connectionId=uuid-1`
    );
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
        id: 'uuid-2',
        command: 'send_message',
        sessionId: 'ses-1',
        data: { ok: true },
      })
    );

    inbound({ type: 'response', id: 'uuid-2', result: { done: true } });
    await expect(command).resolves.toEqual({ done: true });
    release();
    client.destroy();
  });

  it('retries transient initial auth failure while a retain remains active', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const onError = jest.fn();
      const getAuthToken = jest
        .fn()
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockResolvedValueOnce('recovered-token');
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken, onError });
      const release = client.retain();

      await Promise.resolve();
      await Promise.resolve();
      expect(webSocketConstructor).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledWith('Failed to get auth token');

      jest.advanceTimersByTime(500);
      await Promise.resolve();
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(webSocketConstructor).toHaveBeenCalledWith(
        `${WS_URL}?token=recovered-token&connectionId=uuid-1`
      );
      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers after retained initial auth failures exceed the prior retry window', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const getAuthToken = jest
        .fn()
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockResolvedValueOnce('eventual-token');
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
      const release = client.retain();

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await Promise.resolve();
        await Promise.resolve();
        jest.advanceTimersByTime(60_000);
      }
      await Promise.resolve();
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(10);
      expect(webSocketConstructor).toHaveBeenCalledWith(
        `${WS_URL}?token=eventual-token&connectionId=uuid-1`
      );
      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers immediately on online while retained in initial auth backoff', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const onlineHandler: { current: (() => void) | null } = { current: null };
      const removeOnline = jest.fn();
      const getAuthToken = jest
        .fn()
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockResolvedValueOnce('online-token');
      const client = createUserWebConnection({
        websocketUrl: WS_URL,
        getAuthToken,
        lifecycleHooks: {
          onOnline: handler => {
            onlineHandler.current = handler;
            return removeOnline;
          },
        },
      });

      expect(onlineHandler.current).toBeNull();
      const release = client.retain();
      await Promise.resolve();
      await Promise.resolve();
      const handleOnline = onlineHandler.current;
      if (!handleOnline)
        throw new Error('Expected online lifecycle handler before socket creation');
      handleOnline();
      handleOnline();
      await Promise.resolve();
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(webSocketConstructor).toHaveBeenCalledWith(
        `${WS_URL}?token=online-token&connectionId=uuid-1`
      );
      expect(removeOnline).toHaveBeenCalledTimes(1);
      open();
      jest.advanceTimersByTime(1_000);
      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(webSocketConstructor).toHaveBeenCalledTimes(1);
      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers immediately on persisted pageshow while retained in initial auth backoff', async () => {
    jest.useFakeTimers();
    try {
      const pageshowHandler: { current: ((event: { persisted: boolean }) => void) | null } = {
        current: null,
      };
      const getAuthToken = jest
        .fn()
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockResolvedValueOnce('restored-token');
      const client = createUserWebConnection({
        websocketUrl: WS_URL,
        getAuthToken,
        lifecycleHooks: {
          onPageshow: handler => {
            pageshowHandler.current = handler;
            return jest.fn();
          },
        },
      });
      const release = client.retain();
      await Promise.resolve();
      await Promise.resolve();

      const handlePageshow = pageshowHandler.current;
      if (!handlePageshow) throw new Error('Expected pageshow handler before socket creation');
      handlePageshow({ persisted: false });
      expect(getAuthToken).toHaveBeenCalledTimes(1);
      handlePageshow({ persisted: true });
      await Promise.resolve();
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(webSocketConstructor).toHaveBeenCalledWith(
        `${WS_URL}?token=restored-token&connectionId=uuid-1`
      );
      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers immediately on foreground while retained in initial auth backoff', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const resumeHandler: { current: (() => void) | null } = { current: null };
      const getAuthToken = jest
        .fn()
        .mockRejectedValueOnce(new Error('token unavailable'))
        .mockResolvedValueOnce('foreground-token');
      const client = createUserWebConnection({
        websocketUrl: WS_URL,
        getAuthToken,
        lifecycleHooks: {
          onVisibilityChange: onResume => {
            resumeHandler.current = onResume;
            return jest.fn();
          },
        },
      });
      const release = client.subscribeToCliSession('ses-1');
      await Promise.resolve();
      await Promise.resolve();

      const handleResume = resumeHandler.current;
      if (!handleResume) throw new Error('Expected foreground handler before socket creation');
      handleResume();
      await Promise.resolve();
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(webSocketConstructor).toHaveBeenCalledWith(
        `${WS_URL}?token=foreground-token&connectionId=uuid-1`
      );
      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cleans up pre-socket lifecycle recovery and delayed auth work on final release', async () => {
    jest.useFakeTimers();
    try {
      const onlineHandler: { current: (() => void) | null } = { current: null };
      const removeOnline = jest.fn();
      const getAuthToken = jest.fn(() => Promise.reject(new Error('token unavailable')));
      const client = createUserWebConnection({
        websocketUrl: WS_URL,
        getAuthToken,
        lifecycleHooks: {
          onOnline: handler => {
            onlineHandler.current = handler;
            return removeOnline;
          },
        },
      });

      expect(onlineHandler.current).toBeNull();
      const release = client.retain();
      await Promise.resolve();
      await Promise.resolve();
      const handleOnline = onlineHandler.current;
      if (!handleOnline) throw new Error('Expected retained pre-socket online handler');

      release();
      expect(removeOnline).toHaveBeenCalledTimes(1);
      handleOnline();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(1);
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('hands lifecycle recovery to the connected base socket without duplicate active listeners', () => {
    const activeOnlineHandlers = new Set<() => void>();
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: () => 'token',
      lifecycleHooks: {
        onOnline: handler => {
          activeOnlineHandlers.add(handler);
          return () => activeOnlineHandlers.delete(handler);
        },
      },
    });

    expect(activeOnlineHandlers.size).toBe(0);
    const release = client.retain();
    expect(activeOnlineHandlers.size).toBe(1);
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    for (const handler of activeOnlineHandlers) handler();

    expect(activeOnlineHandlers.size).toBe(1);
    expect(webSocketConstructor).toHaveBeenCalledTimes(1);
    expect(sockets[0].send).toHaveBeenCalledTimes(1);
    expect(sockets[0].send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping', nonce: 'uuid-2' }));
    release();
    expect(activeOnlineHandlers.size).toBe(0);
    client.destroy();
  });

  it('stops initial auth retries when the final retain releases', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const getAuthToken = jest.fn(() => Promise.reject(new Error('token unavailable')));
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
      const release = client.retain();

      await Promise.resolve();
      await Promise.resolve();
      release();
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(1);
      expect(webSocketConstructor).not.toHaveBeenCalled();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
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

  it('ref-counts subscribe and unsubscribe for one session and releases its connection lease', () => {
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
    expect(sockets[0].close).not.toHaveBeenCalled();
    releaseB();
    expect(sockets[0].send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: 'ses-1' })
    );
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('keeps the socket alive when a global lease remains after a session release', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const releaseGlobal = client.retain();
    const releaseSession = client.subscribeToCliSession('ses-1');
    open();

    releaseSession();
    expect(sockets[0].send).toHaveBeenLastCalledWith(
      JSON.stringify({ type: 'unsubscribe', sessionId: 'ses-1' })
    );
    expect(sockets[0].close).not.toHaveBeenCalled();

    releaseGlobal();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
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
    expect(removePageshow).toHaveBeenCalledTimes(2);
  });

  it('releases the final mobile-style subscription after a completed command', async () => {
    jest.useFakeTimers();
    try {
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
      const release = client.subscribeToCliSession('ses-1');
      open();

      const promise = client.sendCommand('ses-1', 'send_message', { ok: true });
      await Promise.resolve();
      inbound({ type: 'response', id: 'uuid-2', result: { done: true } });
      await expect(promise).resolves.toEqual({ done: true });

      release();
      expect(sockets[0].close).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS + VIEWER_PONG_TIMEOUT_MS);
      expect(sockets[0].send).not.toHaveBeenCalledWith(expect.stringContaining('"type":"ping"'));
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('releases a provider-style global retain after a completed command', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const release = client.retain();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', { ok: true });
    await Promise.resolve();
    inbound({ type: 'response', id: 'uuid-2', result: { done: true } });
    await expect(promise).resolves.toEqual({ done: true });

    release();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('keeps standalone command ownership until every pending command completes', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const first = client.sendCommand('ses-1', 'send_message', { sequence: 1 });
    const second = client.sendCommand('ses-1', 'send_message', { sequence: 2 });
    open();
    await Promise.resolve();

    inbound({ type: 'response', id: 'uuid-2', result: { sequence: 1 } });
    await expect(first).resolves.toEqual({ sequence: 1 });
    expect(sockets[0].close).not.toHaveBeenCalled();

    inbound({ type: 'response', id: 'uuid-3', result: { sequence: 2 } });
    await expect(second).resolves.toEqual({ sequence: 2 });
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    client.destroy();
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
        id: 'uuid-2',
        command: 'send_message',
        sessionId: 'ses-1',
        data: { ok: true },
      })
    );
    inbound({ type: 'response', id: 'uuid-2', result: { done: true } });

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
        id: 'uuid-2',
        command: 'send_message',
        sessionId: 'ses-1',
        data: { ok: true },
      })
    );
    inbound({ type: 'response', id: 'uuid-2', result: { done: true } });

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

  it('releasing a retained connection rejects commands waiting for open', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const release = client.retain();

    const promise = client.sendCommand('ses-1', 'send_message', {});
    release();

    await expect(promise).rejects.toThrow('Connection disconnected');
    client.destroy();
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
