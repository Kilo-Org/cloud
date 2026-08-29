import { configureCloudAgentSdkRuntime, resetCloudAgentSdkRuntime } from './runtime';
import {
  browserCLIInboundMessageSchema,
  browserJobSnapshotSchema,
  webOutboundWithBrowserMessageSchema,
  type BrowserJobSnapshot,
  type BrowserProviderInboundMessage,
  type BrowserProviderOutboundMessage,
} from './schemas';
import {
  BrowserProviderError,
  CommandDeliveredError,
  createUserWebConnection,
  UserWebCommandError,
  VIEWER_PING_INTERVAL_MS,
  VIEWER_PONG_TIMEOUT_MS,
  type BrowserProviderRegistration,
  type BrowserProviderState,
} from './user-web-connection';

jest.mock(
  'cloudflare:workers',
  () => ({
    DurableObject: class {
      constructor(
        readonly ctx: unknown,
        readonly env: unknown
      ) {}
    },
  }),
  { virtual: true }
);
jest.mock('../../../services/session-ingest/src/dos/SessionIngestDO', () => ({
  getSessionIngestDO: () => {
    throw new Error('Unexpected session ingest access');
  },
}));
jest.mock('../../../services/session-ingest/src/services/session-access', () => ({
  resolveAccessibleKiloSession: () => {
    throw new Error('Unexpected session access lookup');
  },
}));

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
      `${WS_URL}?source=web&ticket=token+with+spaces&connectionId=uuid-1`
    );
    release();

    const secondRelease = client.retain();
    expect(webSocketConstructor).toHaveBeenLastCalledWith(
      `${WS_URL}?source=web&ticket=token+with+spaces&connectionId=uuid-1`
    );
    secondRelease();

    const other = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const otherRelease = other.retain();
    expect(webSocketConstructor).toHaveBeenLastCalledWith(
      `${WS_URL}?ticket=token&connectionId=uuid-2`
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
        `${WS_URL}?ticket=new-token&connectionId=uuid-1`
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
    expect(webSocketConstructor).toHaveBeenCalledWith(`${WS_URL}?ticket=token&connectionId=uuid-1`);
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
      `${WS_URL}?ticket=async-token&connectionId=uuid-1`
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
        `${WS_URL}?ticket=recovered-token&connectionId=uuid-1`
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
        `${WS_URL}?ticket=eventual-token&connectionId=uuid-1`
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
        `${WS_URL}?ticket=online-token&connectionId=uuid-1`
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
        `${WS_URL}?ticket=restored-token&connectionId=uuid-1`
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
        `${WS_URL}?ticket=foreground-token&connectionId=uuid-1`
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

  it('resubscribes retained sessions and calls reconnect listeners', async () => {
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
      // The reconnect now refreshes auth before opening the new socket.
      await Promise.resolve();
      await Promise.resolve();
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

  it('mints a fresh ticket on a non-auth-failure (1006) reconnect', async () => {
    jest.useFakeTimers();
    try {
      const getAuthToken = jest.fn().mockReturnValueOnce('old-token').mockReturnValue('new-token');
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
      client.subscribeToCliSession('ses-1');
      open();
      inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
      expect(getAuthToken).toHaveBeenCalledTimes(1);
      expect(webSocketConstructor).toHaveBeenLastCalledWith(
        `${WS_URL}?ticket=old-token&connectionId=uuid-1`
      );

      sockets[0].onclose?.({ code: 1006 } as CloseEvent);
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
      await Promise.resolve();

      expect(getAuthToken).toHaveBeenCalledTimes(2);
      expect(webSocketConstructor).toHaveBeenLastCalledWith(
        `${WS_URL}?ticket=new-token&connectionId=uuid-1`
      );
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

  it('sends the expected owner connection id when provided', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand(
      'ses-1',
      'list_models',
      { protocolVersion: 1 },
      'cli-owner-1'
    );
    await Promise.resolve();

    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command',
        id: 'uuid-2',
        command: 'list_models',
        sessionId: 'ses-1',
        connectionId: 'cli-owner-1',
        data: { protocolVersion: 1 },
      })
    );
    inbound({ type: 'response', id: 'uuid-2', result: { protocolVersion: 1 } });
    await expect(promise).resolves.toEqual({ protocolVersion: 1 });
    client.destroy();
  });

  it('preserves strict structured relay errors as typed command errors', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', {});
    await Promise.resolve();
    inbound({
      type: 'response',
      id: 'uuid-2',
      error: {
        source: 'relay',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      },
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({
        name: 'UserWebCommandError',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      })
    );
    await expect(promise).rejects.toBeInstanceOf(UserWebCommandError);
    client.destroy();
  });

  it('keeps sanitized CLI error envelopes generic', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', {});
    await Promise.resolve();
    inbound({
      type: 'response',
      id: 'uuid-2',
      error: { source: 'cli', message: 'Command failed' },
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({ name: 'Error', message: 'Command failed' })
    );
    await expect(promise).rejects.not.toBeInstanceOf(UserWebCommandError);
    client.destroy();
  });

  it('keeps relay envelopes with extra fields generic', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', {});
    await Promise.resolve();
    inbound({
      type: 'response',
      id: 'uuid-2',
      error: {
        source: 'relay',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
        ownerConnectionId: 'private-owner',
      },
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({ name: 'Error', message: 'Command failed' })
    );
    await expect(promise).rejects.not.toBeInstanceOf(UserWebCommandError);
    client.destroy();
  });

  it('keeps malformed relay error objects generic', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', {});
    await Promise.resolve();
    inbound({
      type: 'response',
      id: 'uuid-2',
      error: { source: 'relay', code: 'UNTRUSTED_CODE', message: { raw: 'internal details' } },
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({ name: 'Error', message: 'Command failed' })
    );
    await expect(promise).rejects.not.toBeInstanceOf(UserWebCommandError);
    client.destroy();
  });

  it('preserves CLI string errors', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommand('ses-1', 'send_message', {});
    await Promise.resolve();
    inbound({ type: 'response', id: 'uuid-2', error: 'CLI disconnected' });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({ name: 'CommandDeliveredError', message: 'CLI disconnected' })
    );
    await expect(promise).rejects.toBeInstanceOf(CommandDeliveredError);
    await expect(promise).rejects.not.toBeInstanceOf(UserWebCommandError);
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

describe('createUserWebConnection sendCommandToConnection', () => {
  it('sends a connection-scoped wire frame with connectionId and no sessionId', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommandToConnection({
      command: 'runtime_status',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();

    expect(sockets[0].send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'command',
        id: 'uuid-2',
        command: 'runtime_status',
        connectionId: 'cli-owner-1',
        data: { protocolVersion: 1 },
      })
    );
    expect(JSON.parse(jest.mocked(sockets[0].send).mock.calls[0][0] as string)).not.toHaveProperty(
      'sessionId'
    );

    inbound({
      type: 'response',
      id: 'uuid-2',
      result: { ok: true },
    });
    await expect(promise).resolves.toEqual({ ok: true });
    client.destroy();
  });

  it('correlates response by command id even when no sessionId is on the wire', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommandToConnection({
      command: 'runtime_status',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();

    // An unrelated response with a different id should not settle ours.
    inbound({ type: 'response', id: 'uuid-other', result: { unrelated: true } });
    await Promise.resolve();
    // Promise is still pending — we can only check via race against a timeout.
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    inbound({
      type: 'response',
      id: 'uuid-2',
      result: { ok: true },
    });
    await expect(promise).resolves.toEqual({ ok: true });
    client.destroy();
  });

  it('times out a connection-scoped command that never gets a response', async () => {
    jest.useFakeTimers();
    try {
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
      client.connect();
      open();

      const promise = client.sendCommandToConnection({
        command: 'runtime_status',
        data: { protocolVersion: 1 },
        expectedConnectionId: 'cli-owner-1',
      });
      // Wait for the send to dispatch.
      await jest.advanceTimersByTimeAsync(0);

      jest.advanceTimersByTime(30_000);
      await expect(promise).rejects.toThrow('Command timed out');
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects a connection-scoped command on auth-close refresh', async () => {
    const getAuthToken = jest.fn().mockReturnValueOnce('old-token').mockResolvedValue('new-token');
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
    const release = client.subscribeToCliSession('ses-1');
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });

    const promise = client.sendCommandToConnection({
      command: 'runtime_status',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();
    sockets[0].onclose?.({ code: 4001 } as CloseEvent);
    await Promise.resolve();
    await Promise.resolve();

    await expect(promise).rejects.toThrow('Connection lost during reconnect');
    release();
    client.destroy();
  });

  it('returns structured UserWebCommandError for relay errors on a connection-scoped command', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommandToConnection({
      command: 'runtime_status',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();

    inbound({
      type: 'response',
      id: 'uuid-2',
      error: {
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Creating remote sessions from mobile requires a newer Kilo CLI.',
      },
    });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({
        name: 'UserWebCommandError',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Creating remote sessions from mobile requires a newer Kilo CLI.',
      })
    );
    await expect(promise).rejects.toBeInstanceOf(UserWebCommandError);
    client.destroy();
  });

  it('does not subscribe to a CLI session as a side effect of sendCommandToConnection', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommandToConnection({
      command: 'runtime_status',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();

    const sentFrames = sockets[0].send.mock.calls.map(call => JSON.parse(call[0] as string));
    expect(sentFrames).not.toContainEqual(expect.objectContaining({ type: 'subscribe' }));

    inbound({
      type: 'response',
      id: 'uuid-2',
      result: { ok: true },
    });
    await promise;
    client.destroy();
  });

  it('wraps a delivered bare-string error in CommandDeliveredError on a connection-scoped command', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommandToConnection({
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();
    inbound({ type: 'response', id: 'uuid-2', error: 'Session owner not found' });

    await expect(promise).rejects.toEqual(
      expect.objectContaining({
        name: 'CommandDeliveredError',
        message: 'Session owner not found',
      })
    );
    await expect(promise).rejects.toBeInstanceOf(CommandDeliveredError);
    await expect(promise).rejects.not.toBeInstanceOf(UserWebCommandError);
    client.destroy();
  });

  it('leaves structured UserWebCommandError unaffected on a connection-scoped command', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommandToConnection({
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();
    inbound({
      type: 'response',
      id: 'uuid-2',
      error: {
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'upgrade',
      },
    });

    await expect(promise).rejects.toBeInstanceOf(UserWebCommandError);
    await expect(promise).rejects.not.toBeInstanceOf(CommandDeliveredError);
    client.destroy();
  });

  it('leaves a transport-level timeout as a plain (non-CommandDeliveredError) Error', async () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.connect();
    open();

    const promise = client.sendCommandToConnection({
      command: 'create_session',
      data: { protocolVersion: 1 },
      expectedConnectionId: 'cli-owner-1',
    });
    await Promise.resolve();
    // No inbound response: the SDK's 30s client-side timer will reject the
    // command. To avoid making the suite 30s, advance fake timers if jest's
    // fake timers are installed; otherwise rely on the real timer being
    // overridden via the COMMAND_TIMEOUT_MS export — for this test we
    // simulate a transport-level rejection by destroying the client.
    client.destroy();

    await expect(promise).rejects.toBeInstanceOf(Error);
    await expect(promise).rejects.not.toBeInstanceOf(CommandDeliveredError);
    await expect(promise).rejects.not.toBeInstanceOf(UserWebCommandError);
  });
});

describe('createUserWebConnection connection-state API', () => {
  it('reports false until the first server message flips it true and true until the final release flips it false', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const listener = jest.fn();
    const unsubscribe = client.onConnectionChange(listener);

    expect(client.isConnected()).toBe(false);

    const release = client.retain();
    open();
    // Open alone does not mark connected — only the first inbound message does
    // (mirroring the base-connection's `onConnected` semantics).
    expect(client.isConnected()).toBe(false);

    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    expect(client.isConnected()).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(true);

    release();
    expect(client.isConnected()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
    client.destroy();
  });

  it('covers a release-then-retain transition (true → release-all → false → retain → true)', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const listener = jest.fn();
    client.onConnectionChange(listener);

    const releaseA = client.retain();
    const releaseB = client.retain();
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    expect(client.isConnected()).toBe(true);
    const transitionCountAfterFirstConnect = listener.mock.calls.length;

    releaseA();
    expect(client.isConnected()).toBe(true);
    releaseB();
    expect(client.isConnected()).toBe(false);

    const releaseC = client.retain();
    open(sockets[1]);
    expect(client.isConnected()).toBe(false);
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } }, sockets[1]);
    expect(client.isConnected()).toBe(true);

    const transitions = listener.mock.calls.map(call => call[0]);
    expect(transitions).toEqual([true, false, true]);
    expect(listener.mock.calls.length).toBe(transitionCountAfterFirstConnect + 2);

    releaseC();
    client.destroy();
  });

  it('reports false on destroy() even though base-connection.destroy() emits no callback', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const listener = jest.fn();
    client.onConnectionChange(listener);

    client.retain();
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    expect(client.isConnected()).toBe(true);

    client.destroy();

    expect(client.isConnected()).toBe(false);
    expect(listener.mock.calls.map(call => call[0])).toEqual([true, false]);
  });

  it('does not emit state changes after destroy()', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const listener = jest.fn();
    client.onConnectionChange(listener);

    client.retain();
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    expect(listener.mock.calls.map(call => call[0])).toEqual([true]);

    client.destroy();
    // destroy() must drive the final false transition; the listener set is
    // cleared as part of teardown so no further notifications can fire.
    expect(listener.mock.calls.map(call => call[0])).toEqual([true, false]);

    // A late inbound on the now-destroyed client must not emit another
    // transition.
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    expect(listener.mock.calls.map(call => call[0])).toEqual([true, false]);
  });

  it('ignores connection-state listeners registered after destroy()', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.destroy();
    const listener = jest.fn();

    const addSpy = jest.spyOn(Set.prototype, 'add');
    try {
      const unsubscribe = client.onConnectionChange(listener);
      expect(addSpy).not.toHaveBeenCalled();
      unsubscribe();
    } finally {
      addSpy.mockRestore();
    }

    expect(listener).not.toHaveBeenCalled();
    expect(client.isConnected()).toBe(false);
  });

  it('flips disconnected → connected across a pong-timeout-triggered reconnect', async () => {
    jest.useFakeTimers();
    try {
      const getAuthToken = jest
        .fn()
        .mockReturnValueOnce('old-token')
        .mockResolvedValue('recovered-token');
      const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken });
      const listener = jest.fn();
      client.onConnectionChange(listener);
      const release = client.retain();
      open();
      inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
      expect(client.isConnected()).toBe(true);
      const callsAfterFirstConnect = listener.mock.calls.length;

      // Drive the existing ping/pong liveness machinery: the ping fires on
      // the viewer-ping interval, the pong is wrong, then the pong-timeout
      // triggers `reconnectWithRefreshedAuth` — which fires `onDisconnected`
      // before the new socket's first message flips state back to true.
      jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS);
      inbound({ type: 'pong', nonce: 'wrong-nonce' });
      jest.advanceTimersByTime(VIEWER_PONG_TIMEOUT_MS);
      await Promise.resolve();
      await Promise.resolve();

      expect(sockets[0].close).toHaveBeenCalledTimes(1);
      expect(sockets[1]).toBeDefined();
      expect(client.isConnected()).toBe(false);

      open(sockets[1]);
      expect(client.isConnected()).toBe(false);
      inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } }, sockets[1]);
      expect(client.isConnected()).toBe(true);

      const transitions = listener.mock.calls.slice(callsAfterFirstConnect).map(call => call[0]);
      expect(transitions).toEqual([false, true]);

      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('coalesces repeated identical transitions and the unsubscribe is a no-op thereafter', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const listener = jest.fn();
    const unsubscribe = client.onConnectionChange(listener);

    const releaseA = client.retain();
    const releaseB = client.retain();
    open();
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(true);

    releaseA();
    // Release of a non-final retain does not change state.
    expect(listener).toHaveBeenCalledTimes(1);

    releaseB();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith(false);

    unsubscribe();
    const releaseC = client.retain();
    open(sockets[1]);
    inbound({ type: 'system', event: 'sessions.list', data: { sessions: [] } }, sockets[1]);
    expect(listener).toHaveBeenCalledTimes(2);

    releaseC();
    client.destroy();
  });
});

describe('createUserWebConnection reconnect-exhaustion API', () => {
  it('reports false initially and subscribes/unsubscribes listeners', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    const listener = jest.fn();
    const unsubscribe = client.onReconnectExhaustionChange(listener);

    expect(client.isReconnectExhausted()).toBe(false);
    expect(listener).not.toHaveBeenCalled();

    unsubscribe();
    client.destroy();
  });

  it('fires the listener on both edges and retryConnection resets the snapshot', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const listener = jest.fn();
      const client = createUserWebConnection({
        websocketUrl: WS_URL,
        getAuthToken: () => 'token',
        maxReconnectAttempts: 2,
      });
      client.onReconnectExhaustionChange(listener);
      const release = client.retain();

      // Drive the base connection to exhaustion without ever opening a socket
      // (no successful message), so `hasEverOpened` stays false and reconnects
      // skip the auth refresh.
      sockets[0].onclose?.({ code: 1006 } as CloseEvent);
      jest.advanceTimersByTime(60_000);
      sockets[1].onclose?.({ code: 1006 } as CloseEvent);
      jest.advanceTimersByTime(60_000);
      sockets[2].onclose?.({ code: 1006 } as CloseEvent);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(true);
      expect(client.isReconnectExhausted()).toBe(true);

      client.retryConnection();
      await Promise.resolve();
      await Promise.resolve();

      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener).toHaveBeenLastCalledWith(false);
      expect(client.isReconnectExhausted()).toBe(false);
      expect(sockets).toHaveLength(4);

      release();
      client.destroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores exhaustion listeners registered after destroy()', () => {
    const client = createUserWebConnection({ websocketUrl: WS_URL, getAuthToken: () => 'token' });
    client.destroy();
    const listener = jest.fn();

    const unsubscribe = client.onReconnectExhaustionChange(listener);
    unsubscribe();

    expect(listener).not.toHaveBeenCalled();
    expect(client.isReconnectExhausted()).toBe(false);
  });
});

describe('createUserWebConnection browser provider', () => {
  const now = Date.UTC(2026, 7, 28);
  const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
  const registration = {
    providerId: `bp_${uuid(1)}`,
    providerProof: 'c'.repeat(64),
    generation: 0,
    label: 'Work profile',
  } satisfies BrowserProviderRegistration;
  const tab = {
    tabId: 42,
    title: 'Approved page',
    url: 'https://example.com/',
    effectiveMode: 'safe' as const,
  };
  let clients: ReturnType<typeof createUserWebConnection>[];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    let nextId = 100;
    configureCloudAgentSdkRuntime({ randomUUID: () => uuid(++nextId) });
    clients = [];
  });

  afterEach(() => {
    for (const client of clients) client.destroy();
    jest.useRealTimers();
  });

  function createProvider(options: Partial<Parameters<typeof createUserWebConnection>[0]> = {}) {
    const client = createUserWebConnection({
      websocketUrl: WS_URL,
      getAuthToken: () => 'private-ticket',
      browserProvider: true,
      ...options,
    });
    clients.push(client);
    return client;
  }

  function frames(ws = sockets.at(-1)) {
    if (!ws) throw new Error('Expected a socket');
    return ws.send.mock.calls.map(call =>
      webOutboundWithBrowserMessageSchema.parse(JSON.parse(call[0] as string))
    );
  }

  function lastFrame<T extends ReturnType<typeof frames>[number]['type']>(
    type: T,
    ws = sockets.at(-1)
  ) {
    const frame = frames(ws)
      .reverse()
      .find(message => message.type === type);
    if (!frame) throw new Error(`Expected a ${type} frame`);
    return frame as Extract<ReturnType<typeof frames>[number], { type: T }>;
  }

  function negotiate(ws = sockets.at(-1)) {
    open(ws);
    const ping = lastFrame('ping', ws);
    inbound({ type: 'pong', nonce: ping.nonce, capabilities: { browserJobsV1: true } }, ws);
  }

  function leaseAck(
    request: Extract<
      BrowserProviderOutboundMessage,
      { type: 'provider_register' | 'provider_heartbeat' }
    >,
    generation = 1,
    ws = sockets.at(-1)
  ) {
    const ack = {
      type: 'provider_lease_ack',
      requestId: request.requestId,
      providerId: request.providerId,
      generation,
      leaseExpiresAt: new Date(Date.now() + 15_000).toISOString(),
    } as const;
    inbound(ack, ws);
    return ack;
  }

  function heartbeatReply(jobs: BrowserJobSnapshot[] = [], ws = sockets.at(-1)) {
    const request = lastFrame('provider_heartbeat', ws);
    leaseAck(request, request.generation, ws);
    const snapshot = {
      type: 'provider_snapshot',
      requestId: request.requestId,
      providerId: request.providerId,
      generation: request.generation,
      jobs,
    } as const;
    inbound(snapshot, ws);
    return snapshot;
  }

  function statusReply(jobs: BrowserJobSnapshot[] = [], ws = sockets.at(-1)) {
    const request = lastFrame('provider_status', ws);
    const history = {
      type: 'provider_status_result',
      requestId: request.requestId,
      providerId: request.providerId,
      jobs,
    } as const;
    inbound(history, ws);
    return history;
  }

  async function registered(
    generation = 1,
    options: Partial<Parameters<typeof createUserWebConnection>[0]> = {}
  ) {
    const client = createProvider(options);
    client.retain();
    negotiate();
    const pending = client.registerBrowserProvider(registration);
    leaseAck(lastFrame('provider_register'), generation);
    await pending;
    statusReply();
    return client;
  }

  function job(n = 1, changes: Partial<BrowserJobSnapshot> = {}): BrowserJobSnapshot {
    return {
      providerId: registration.providerId,
      browserTaskId: `bt_${uuid(n)}`,
      jobId: `bj_${uuid(n)}`,
      invocationId: `b1.${now}.${n.toString(16).padStart(64, '0')}`,
      generation: 1,
      payloadFingerprint: 'd'.repeat(64),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
      deadlines: {
        queue: new Date(now + 60_000).toISOString(),
        approval: new Date(now + 60_000).toISOString(),
      },
      status: 'awaiting_approval',
      ...changes,
    };
  }

  function dispatch(snapshot = job(), ws = sockets.at(-1)) {
    inbound(
      {
        type: 'provider_job',
        job: snapshot,
        goal: 'Observe the requested page',
        ownerLabel: 'ses_parent',
      },
      ws
    );
  }

  function binding(snapshot: BrowserJobSnapshot) {
    return {
      providerId: snapshot.providerId,
      browserTaskId: snapshot.browserTaskId,
      jobId: snapshot.jobId,
      invocationId: snapshot.invocationId,
      generation: snapshot.generation,
    };
  }

  function update(snapshot: BrowserJobSnapshot, ws = sockets.at(-1)) {
    inbound(
      {
        type: 'provider_snapshot',
        providerId: snapshot.providerId,
        generation: snapshot.generation,
        jobs: [snapshot],
      },
      ws
    );
  }

  function completion(snapshot: BrowserJobSnapshot) {
    return {
      ...binding(snapshot),
      tab,
      result: {
        providerId: snapshot.providerId,
        browserTaskId: snapshot.browserTaskId,
        jobId: snapshot.jobId,
        invocationId: snapshot.invocationId,
        status: 'succeeded' as const,
        reason: 'completed' as const,
        effectsUncertain: false as const,
        summary: 'Observed the requested page.',
        evidence: [{ text: 'The page contains the requested value.', url: tab.url }],
      },
    };
  }

  async function relayRegistered(
    options: Partial<Parameters<typeof createUserWebConnection>[0]> = {}
  ) {
    // Load the real relay without adding Worker-only ambient types to the browser SDK project.
    const { UserConnectionDO } = jest.requireActual<{
      UserConnectionDO: new (
        ctx: unknown,
        env: unknown
      ) => {
        webSocketMessage(ws: unknown, message: string): Promise<void>;
        webSocketClose(
          ws: unknown,
          code: number,
          reason: string,
          clean: boolean
        ): void | Promise<void>;
        alarm(): Promise<void>;
      };
    }>('../../../services/session-ingest/src/dos/UserConnectionDO');
    type RelaySocket = {
      role: 'cli' | 'web';
      readyState: number;
      send: (data: string) => void;
      close: () => void;
      serializeAttachment: (value: unknown) => void;
      deserializeAttachment: () => unknown;
    };
    const records = new Map<string, unknown>();
    function kv(data: Map<string, unknown>) {
      return {
        async get(key: string) {
          return structuredClone(data.get(key));
        },
        async put(key: string, value: unknown) {
          data.set(key, structuredClone(value));
        },
        async delete(key: string) {
          return data.delete(key);
        },
        async list(options: { prefix?: string; limit?: number } = {}) {
          return new Map(
            [...data]
              .filter(([key]) => key.startsWith(options.prefix ?? ''))
              .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
              .slice(0, options.limit)
              .map(([key, value]) => [key, structuredClone(value)])
          );
        },
      };
    }
    let serial: Promise<unknown> = Promise.resolve();
    let alarmAt: number | null = null;
    const storage = {
      ...kv(records),
      transaction<T>(run: (tx: ReturnType<typeof kv>) => Promise<T>): Promise<T> {
        const next = serial.then(async () => {
          const working = new Map(records);
          const result = await run(kv(working));
          records.clear();
          for (const [key, value] of working) records.set(key, value);
          return result;
        });
        serial = next.catch(() => undefined);
        return next;
      },
      async setAlarm(at: number) {
        alarmAt = at;
      },
      async getAlarm() {
        return alarmAt;
      },
      async deleteAlarm() {
        alarmAt = null;
      },
    };
    const peers: RelaySocket[] = [];
    const queued: Array<() => Promise<void>> = [];
    const background: Promise<unknown>[] = [];
    const relay = new UserConnectionDO(
      {
        storage,
        getWebSockets: (role?: string) => peers.filter(peer => !role || peer.role === role),
        waitUntil: (work: Promise<unknown>) => background.push(work),
      },
      {}
    );
    function peer(role: 'cli' | 'web', send: (data: string) => void): RelaySocket {
      let attachment: unknown = {
        role,
        connectionId: uuid(1_000 + peers.length),
        kiloUserId: 'usr_1',
        sessions: [],
        subscribedSessions: [],
      };
      const socket: RelaySocket = {
        role,
        readyState: 1,
        send,
        close: () => {
          socket.readyState = 3;
        },
        serializeAttachment: value => {
          attachment = structuredClone(value);
        },
        deserializeAttachment: () => structuredClone(attachment),
      };
      peers.push(socket);
      return socket;
    }
    async function flush() {
      while (queued.length || background.length) {
        for (const work of queued.splice(0)) await work();
        await Promise.all(background.splice(0));
      }
    }
    const cliMessages: ReturnType<typeof browserCLIInboundMessageSchema.parse>[] = [];
    const cli = peer('cli', data => {
      const parsed = browserCLIInboundMessageSchema.safeParse(JSON.parse(data));
      if (parsed.success) cliMessages.push(parsed.data);
    });
    const client = createProvider(options);
    const messages: BrowserProviderInboundMessage[] = [];
    client.onBrowserProviderMessage(message => messages.push(message));
    const panels = new Map<MockWebSocket, RelaySocket>();
    async function connect(ws = sockets.at(-1)) {
      if (!ws) throw new Error('Expected an SDK socket');
      const panel = peer('web', data => ws.onmessage?.({ data } as MessageEvent));
      panels.set(ws, panel);
      ws.send.mockImplementation((data: string) => {
        queued.push(() => relay.webSocketMessage(panel, data));
      });
      open(ws);
      await flush();
    }
    function snapshot(jobId: string) {
      const row = records.get(`browser/job/${jobId}`);
      if (!row || typeof row !== 'object' || !('snapshot' in row)) {
        throw new Error('Expected a persisted job');
      }
      return browserJobSnapshotSchema.parse(row.snapshot);
    }
    client.retain();
    await connect();
    const pending = client.registerBrowserProvider(registration);
    await flush();
    await pending;
    return {
      client,
      messages,
      connect,
      flush,
      snapshot,
      async invoke(n = 1, createdAt = now) {
        await relay.webSocketMessage(
          cli,
          JSON.stringify({ type: 'heartbeat', sessions: [], capabilities: { browserJobsV1: true } })
        );
        const requestId = uuid(2_000 + n);
        await relay.webSocketMessage(
          cli,
          JSON.stringify({
            type: 'browser_request',
            operation: 'invoke',
            requestId,
            owner: { parentSessionId: 'ses_parent', parentProof: 'a'.repeat(64) },
            providerId: registration.providerId,
            invocationId: `b1.${createdAt}.${n.toString(16).padStart(64, '0')}`,
            goal: 'Observe the requested page',
          })
        );
        await flush();
        const reply = [...cliMessages].reverse().find(message => message.requestId === requestId);
        if (reply?.type !== 'browser_event' || reply.event !== 'progress') {
          throw new Error('Expected admitted browser work');
        }
        return snapshot(reply.job.jobId);
      },
      async disconnect(code: number, ws = sockets.at(-1)) {
        if (!ws) throw new Error('Expected an SDK socket');
        const panel = panels.get(ws);
        if (!panel) throw new Error('Expected a relay socket');
        ws.readyState = 3;
        panel.readyState = 3;
        ws.onclose?.({ code } as CloseEvent);
        await relay.webSocketClose(panel, code, '', false);
        await flush();
      },
      async alarm() {
        await relay.alarm();
        await flush();
      },
    };
  }

  it('leaves legacy callers disabled and keeps their wire protocol unchanged', async () => {
    const client = createProvider({ browserProvider: undefined });
    const received: BrowserProviderInboundMessage[] = [];
    client.onBrowserProviderMessage(message => received.push(message));
    expect(sockets).toHaveLength(0);
    client.retain();
    open();
    expect(frames()).toEqual([]);
    await expect(client.registerBrowserProvider(registration)).rejects.toMatchObject({
      code: 'disabled',
      retryable: false,
    });
    dispatch();
    jest.advanceTimersByTime(VIEWER_PING_INTERVAL_MS);
    expect(frames()).toEqual([{ type: 'ping', nonce: expect.any(String) }]);
    expect(received).toEqual([]);
    expect(client.getBrowserProviderState()).toEqual({ status: 'disabled' });
  });

  it('requires a matching capability pong before registration or dispatch', async () => {
    const client = createProvider();
    const goals: string[] = [];
    client.onBrowserProviderMessage(message => {
      if (message.type === 'provider_job') goals.push(message.goal);
    });
    client.retain();
    open();
    const ping = lastFrame('ping');
    expect(ping.capabilities).toEqual({ browserJobsV1: true });
    await expect(client.registerBrowserProvider(registration)).rejects.toMatchObject({
      code: 'not_negotiated',
    });
    inbound({ type: 'pong', nonce: uuid(999), capabilities: { browserJobsV1: true } });
    dispatch();
    expect(client.getBrowserProviderState()).toEqual({ status: 'negotiating' });
    expect(frames()).toHaveLength(1);
    expect(goals).toEqual([]);

    inbound({ type: 'pong', nonce: ping.nonce, capabilities: { browserJobsV1: true } });
    const pending = client.registerBrowserProvider(registration);
    const request = lastFrame('provider_register');
    leaseAck({ ...request, requestId: uuid(999) });
    dispatch();
    expect(client.getBrowserProviderState()).toEqual({ status: 'ready' });
    const ack = leaseAck(request);
    await expect(pending).resolves.toEqual(ack);
    expect(frames().map(frame => frame.type)).toEqual([
      'ping',
      'provider_register',
      'provider_status',
    ]);
    statusReply();
    dispatch();
    expect(goals).toEqual(['Observe the requested page']);
  });

  it.each([undefined, {}, { browserJobsV1: false }])(
    'reports unsupported capability acknowledgement %j without breaking legacy commands',
    async capabilities => {
      const client = createProvider();
      client.retain();
      open();
      inbound({ type: 'pong', nonce: lastFrame('ping').nonce, capabilities });
      expect(client.getBrowserProviderState()).toEqual({
        status: 'unavailable',
        reason: 'unsupported',
        retryable: false,
      });
      await expect(client.registerBrowserProvider(registration)).rejects.toMatchObject({
        code: 'unsupported',
        retryable: false,
      });
      expect(frames().map(frame => frame.type)).toEqual(['ping']);
      const command = client.sendCommand('ses-1', 'list_models', {});
      await Promise.resolve();
      inbound({ type: 'response', id: lastFrame('command').id, result: { models: [] } });
      await expect(command).resolves.toEqual({ models: [] });
    }
  );

  it('times out missing registration acknowledgement and ignores a late grant', async () => {
    const client = createProvider();
    client.retain();
    negotiate();
    const pending = client.registerBrowserProvider(registration);
    const request = lastFrame('provider_register');
    jest.advanceTimersByTime(10_000);
    await expect(pending).rejects.toMatchObject({ code: 'request_timeout', retryable: true });
    leaseAck(request);
    expect(client.getBrowserProviderState()).toEqual({
      status: 'unavailable',
      reason: 'request_timeout',
      retryable: true,
    });
    expect(frames().map(frame => frame.type)).toEqual([
      'ping',
      'provider_register',
      'provider_status',
    ]);
  });

  it.each(['ack', 'snapshot'])(
    'requires both correlated heartbeat replies when %s is missing',
    async missing => {
      const client = await registered();
      const snapshots: BrowserJobSnapshot[][] = [];
      client.onBrowserProviderMessage(message => {
        if (message.type === 'provider_snapshot') snapshots.push(message.jobs);
      });
      const pending = client.heartbeatBrowserProvider();
      const request = lastFrame('provider_heartbeat');
      if (missing === 'ack') {
        inbound({
          type: 'provider_snapshot',
          providerId: registration.providerId,
          generation: 1,
          requestId: request.requestId,
          jobs: [job()],
        });
      } else {
        leaseAck(request);
      }
      jest.advanceTimersByTime(10_000);
      await expect(pending).rejects.toMatchObject({ code: 'request_timeout' });
      expect(snapshots).toEqual([]);
      expect(client.getBrowserProviderState()).toMatchObject({
        status: 'unavailable',
        reason: 'request_timeout',
      });
    }
  );

  it('preserves empty legacy status and renews a short lease before viewer ping', async () => {
    const client = await registered();
    const messages: BrowserProviderInboundMessage[] = [];
    client.onBrowserProviderMessage(message => messages.push(message));
    const status = client.requestBrowserProviderStatus();
    const history = statusReply();
    await expect(status).resolves.toStrictEqual(history);
    expect(messages).toStrictEqual([history]);

    const pending = client.heartbeatBrowserProvider(`bj_${uuid(9)}`);
    expect(lastFrame('provider_heartbeat').cursor).toBe(`bj_${uuid(9)}`);
    const snapshot = heartbeatReply();
    await expect(pending).resolves.toEqual(snapshot);
    jest.advanceTimersByTime(7_500);
    expect(frames().filter(frame => frame.type === 'ping')).toHaveLength(1);
    heartbeatReply();
    jest.advanceTimersByTime(8_000);
    dispatch();
    client.approveBrowserProviderJob({
      ...binding(job()),
      approval: { decision: 'approved', tab },
    });
    expect(lastFrame('provider_approval').approval).toEqual({ decision: 'approved', tab });
    expect(client.getBrowserProviderState().status).toBe('registered');
  });

  it.each(['provider_snapshot', 'provider_status_result'] as const)(
    'preserves queue metadata across %s pages and later job phases',
    async type => {
      const client = await registered();
      const messages: BrowserProviderInboundMessage[] = [];
      client.onBrowserProviderMessage(message => messages.push(message));
      const first = job(1, {
        status: 'queued',
        ownerLabel: 'ses_parent_z',
        queuePosition: 100,
      });
      const second = job(2, {
        status: 'queued',
        ownerLabel: 'ses_parent_a',
        queuePosition: 1,
      });
      const third = job(3, {
        status: 'queued',
        ownerLabel: 'ses_parent_m',
        queuePosition: 42,
      });
      const active = job(1, { ownerLabel: first.ownerLabel });
      const pages: {
        cursor?: BrowserJobSnapshot['jobId'];
        nextCursor?: BrowserJobSnapshot['jobId'];
        jobs: BrowserJobSnapshot[];
      }[] = [
        { jobs: [first, second], nextCursor: second.jobId },
        { cursor: second.jobId, jobs: [third, job(4, { status: 'queued' })] },
        {
          jobs: [
            { ...first, queuePosition: 99 },
            { ...third, queuePosition: 41 },
          ],
        },
        { jobs: [active] },
        { jobs: [{ ...active, status: 'running', approvedTab: tab }] },
        {
          jobs: [
            {
              ...active,
              status: 'succeeded',
              approvedTab: tab,
              result: completion(active).result,
            },
            job(2, {
              status: 'cancelled',
              ownerLabel: second.ownerLabel,
              result: {
                ...completion(second).result,
                status: 'cancelled',
                reason: 'cancelled',
                effectsUncertain: false,
              },
            }),
            // A legacy refresh must not inherit either field from an earlier page.
            job(3, { status: 'queued' }),
          ],
        },
        { jobs: [] },
      ];
      const expected: BrowserProviderInboundMessage[] = [];
      for (const { cursor, nextCursor, jobs } of pages) {
        const pending =
          type === 'provider_snapshot'
            ? client.heartbeatBrowserProvider(cursor)
            : client.requestBrowserProviderStatus(cursor);
        const request =
          type === 'provider_snapshot'
            ? lastFrame('provider_heartbeat')
            : lastFrame('provider_status');
        expect(request.cursor).toBe(cursor);
        if (request.type === 'provider_heartbeat') leaseAck(request);
        const fields = {
          requestId: request.requestId,
          providerId: registration.providerId,
          jobs,
          ...(nextCursor === undefined ? {} : { nextCursor }),
        };
        const reply =
          type === 'provider_snapshot' ? { type, generation: 1, ...fields } : { type, ...fields };
        inbound(reply);
        await expect(pending).resolves.toStrictEqual(reply);
        expected.push(reply);
      }
      // Check retained callbacks too: a later rank or phase must not mutate an earlier page.
      expect(messages.filter(message => message.type !== 'provider_lease_ack')).toStrictEqual(
        expected
      );
    }
  );

  it('deduplicates jobs and cancellations and rejects stale or foreign generations', async () => {
    const client = await registered(2);
    const received: string[] = [];
    client.onBrowserProviderMessage(message => {
      if (message.type === 'provider_job') received.push(`job:${message.job.jobId}`);
      if (message.type === 'provider_job_cancel') received.push(`cancel:${message.reason}`);
    });
    const current = job(1, { generation: 2 });
    dispatch(job());
    dispatch({ ...current, providerId: `bp_${uuid(2)}` });
    dispatch(current);
    dispatch(current);
    inbound({ type: 'provider_job_cancel', ...binding(job()), reason: 'cancelled' });
    inbound({
      type: 'provider_job_cancel',
      ...binding(current),
      invocationId: `b1.${now}.${'f'.repeat(64)}`,
      reason: 'cancelled',
    });
    const cancellation = { type: 'provider_job_cancel', ...binding(current), reason: 'cancelled' };
    inbound(cancellation);
    inbound(cancellation);
    dispatch(current);
    expect(received).toEqual([`job:${current.jobId}`, 'cancel:cancelled']);
    expect(() =>
      client.approveBrowserProviderJob({
        ...binding(current),
        approval: { decision: 'approved', tab },
      })
    ).toThrow(BrowserProviderError);
    expect(frames().filter(frame => frame.type === 'provider_approval')).toEqual([]);
  });

  it('sends approval, result, quiescence, denial, and provider Stop on exact job bindings', async () => {
    const client = await registered();
    const current = job();
    dispatch(current);
    client.approveBrowserProviderJob({
      ...binding(current),
      approval: { decision: 'approved', tab },
    });
    expect(lastFrame('provider_approval')).toEqual({
      type: 'provider_approval',
      ...binding(current),
      approval: { decision: 'approved', tab },
    });
    const result = completion(current);
    expect(() => client.sendBrowserProviderResult(result)).toThrow(BrowserProviderError);
    const running = { ...current, status: 'running' as const, approvedTab: tab };
    update(running);
    expect(() =>
      client.sendBrowserProviderResult({ ...result, tab: { ...tab, tabId: 99 } })
    ).toThrow(BrowserProviderError);
    client.sendBrowserProviderResult(result);
    expect(lastFrame('provider_result')).toEqual({ type: 'provider_result', ...result });
    update({ ...running, status: 'succeeded', result: result.result });
    client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId });
    expect(lastFrame('provider_quiesced')).toEqual({
      type: 'provider_quiesced',
      ...binding(current),
      tabId: tab.tabId,
    });
    const denied = job(2);
    dispatch(denied);
    client.approveBrowserProviderJob({
      ...binding(denied),
      approval: { decision: 'denied', reason: 'approval_denied' },
    });
    expect(lastFrame('provider_approval').approval).toEqual({
      decision: 'denied',
      reason: 'approval_denied',
    });
    const queued = job(3, { status: 'queued' });
    update(queued);
    client.cancelBrowserProviderJob(binding(queued));
    expect(lastFrame('provider_cancel')).toEqual({ type: 'provider_cancel', ...binding(queued) });
    expect(frames().filter(frame => frame.type === 'command')).toEqual([]);
  });

  it.each([
    ['approval denial', 'failed', 'approval_denied'],
    ['provider cancellation', 'cancelled', 'cancelled'],
  ] as const)(
    'releases the next queued consent through no-tab quiescence after %s',
    async (event, status, reason) => {
      const f = await relayRegistered();
      const current = await f.invoke();
      const queued = await f.invoke(2);
      const registeredState = f.client.getBrowserProviderState();
      expect(queued.status).toBe('queued');
      if (event === 'approval denial') {
        f.client.approveBrowserProviderJob({
          ...binding(current),
          approval: { decision: 'denied', reason: 'approval_denied' },
        });
      } else {
        f.client.cancelBrowserProviderJob(binding(current));
      }
      // Sending a denial or Stop does not confirm terminal state at the relay.
      expect(() => f.client.quiesceBrowserProviderJob(binding(current))).toThrow('invalid_request');
      await f.flush();
      const terminal = f.snapshot(current.jobId);
      expect(terminal).toMatchObject({
        status,
        result: { status, reason, effectsUncertain: false },
      });
      expect(terminal).not.toHaveProperty('approvedTab');
      expect(f.snapshot(queued.jobId)).toEqual(queued);
      expect(
        f.messages
          .filter(message => message.type === 'provider_job')
          .map(message => message.job.jobId)
      ).toEqual([current.jobId]);
      expect(frames().filter(frame => frame.type === 'provider_quiesced')).toEqual([]);

      f.client.quiesceBrowserProviderJob(binding(current));
      await f.flush();
      expect(lastFrame('provider_quiesced')).toStrictEqual({
        type: 'provider_quiesced',
        ...binding(current),
      });
      expect(
        f.messages
          .filter(message => message.type === 'provider_job')
          .map(message => message.job.jobId)
      ).toEqual([current.jobId, queued.jobId]);
      const next = f.snapshot(queued.jobId);
      expect(next).toMatchObject({ status: 'awaiting_approval', generation: current.generation });
      expect(next).not.toHaveProperty('approvedTab');
      expect(next.deadlines).not.toHaveProperty('execution');
      expect(f.client.getBrowserProviderState()).toEqual(registeredState);
      expect(() => f.client.sendBrowserProviderResult(completion(next))).toThrow('invalid_request');
      expect(() =>
        f.client.approveBrowserProviderJob({
          ...binding(current),
          approval: { decision: 'approved', tab },
        })
      ).toThrow('invalid_request');
      expect(frames().filter(frame => frame.type === 'provider_result')).toEqual([]);

      f.client.approveBrowserProviderJob({
        ...binding(next),
        approval: { decision: 'approved', tab },
      });
      await f.flush();
      expect(f.snapshot(next.jobId)).toMatchObject({ status: 'running', approvedTab: tab });
      expect(f.snapshot(current.jobId)).toEqual(terminal);
    }
  );

  it.each([0, tab.tabId])(
    'requires exact approved tab %s for SDK quiescence before releasing queued consent',
    async tabId => {
      const f = await relayRegistered();
      const current = await f.invoke();
      const queued = await f.invoke(2);
      const approvedTab = { ...tab, tabId };
      f.client.approveBrowserProviderJob({
        ...binding(current),
        approval: { decision: 'approved', tab: approvedTab },
      });
      await f.flush();
      f.client.sendBrowserProviderResult({ ...completion(current), tab: approvedTab });
      await f.flush();
      const terminal = f.snapshot(current.jobId);
      expect(terminal).toMatchObject({ status: 'succeeded', approvedTab });

      for (const fields of [{}, { tabId: tabId + 1 }]) {
        expect(() =>
          f.client.quiesceBrowserProviderJob({ ...binding(current), ...fields })
        ).toThrow('invalid_request');
        await f.flush();
        expect(f.snapshot(current.jobId)).toEqual(terminal);
        expect(f.snapshot(queued.jobId)).toEqual(queued);
      }
      expect(frames().filter(frame => frame.type === 'provider_quiesced')).toEqual([]);
      f.client.quiesceBrowserProviderJob({ ...binding(current), tabId });
      await f.flush();
      expect(lastFrame('provider_quiesced')).toStrictEqual({
        type: 'provider_quiesced',
        ...binding(current),
        tabId,
      });
      expect(f.snapshot(queued.jobId)).toMatchObject({ status: 'awaiting_approval' });
      expect(f.snapshot(queued.jobId)).not.toHaveProperty('approvedTab');
      expect(
        f.messages
          .filter(message => message.type === 'provider_job')
          .map(message => message.job.jobId)
      ).toEqual([current.jobId, queued.jobId]);
    }
  );

  it.each([
    ['wrong provider', { providerId: `bp_${uuid(9)}` }],
    ['wrong conversation', { browserTaskId: `bt_${uuid(9)}` }],
    ['wrong job', { jobId: `bj_${uuid(9)}` }],
    ['wrong invocation', { invocationId: `b1.${now}.${'f'.repeat(64)}` }],
    ['stale generation', { generation: 1 }],
  ] as const)('rejects no-tab quiescence with %s at the SDK boundary', async (_variant, fields) => {
    const f = await relayRegistered();
    f.client.markBrowserProviderUnavailable({
      providerId: registration.providerId,
      generation: 1,
      reason: 'provider_unavailable',
      effectsUncertain: false,
    });
    await f.flush();
    const renewed = f.client.registerBrowserProvider({ ...registration, generation: 1 });
    await f.flush();
    await expect(renewed).resolves.toMatchObject({ generation: 2 });
    const current = await f.invoke();
    const queued = await f.invoke(2);
    f.client.cancelBrowserProviderJob(binding(current));
    await f.flush();
    const terminal = f.snapshot(current.jobId);
    expect(terminal).toMatchObject({ status: 'cancelled', generation: 2 });

    expect(() => f.client.quiesceBrowserProviderJob({ ...binding(current), ...fields })).toThrow(
      'owner_mismatch'
    );
    await f.flush();
    expect(frames().filter(frame => frame.type === 'provider_quiesced')).toEqual([]);
    expect(f.snapshot(current.jobId)).toEqual(terminal);
    expect(f.snapshot(queued.jobId)).toEqual(queued);
    f.client.quiesceBrowserProviderJob(binding(current));
    await f.flush();
    expect(f.snapshot(queued.jobId)).toMatchObject({ status: 'awaiting_approval' });
  });

  it.each(['queued', 'awaiting_approval', 'running'] as const)(
    'rejects SDK quiescence for nonterminal %s work with or without a tab',
    async phase => {
      const f = await relayRegistered();
      const current = await f.invoke();
      const queued = await f.invoke(2);
      if (phase === 'running') {
        f.client.approveBrowserProviderJob({
          ...binding(current),
          approval: { decision: 'approved', tab },
        });
        await f.flush();
      }
      const target = f.snapshot(phase === 'queued' ? queued.jobId : current.jobId);
      expect(target.status).toBe(phase);
      for (const fields of [{}, { tabId: tab.tabId }]) {
        expect(() => f.client.quiesceBrowserProviderJob({ ...binding(target), ...fields })).toThrow(
          'invalid_request'
        );
      }
      await f.flush();
      expect(frames().filter(frame => frame.type === 'provider_quiesced')).toEqual([]);
      expect(f.snapshot(target.jobId)).toEqual(target);
      expect(f.snapshot(queued.jobId)).toEqual(queued);
      expect(
        f.messages
          .filter(message => message.type === 'provider_job')
          .map(message => message.job.jobId)
      ).toEqual([current.jobId]);
    }
  );

  it('does not let a replacement SDK socket quiesce prior no-tab terminal work from history', async () => {
    const f = await relayRegistered();
    const current = await f.invoke();
    f.client.cancelBrowserProviderJob(binding(current));
    await f.flush();
    const terminal = f.snapshot(current.jobId);
    expect(terminal).toMatchObject({ status: 'cancelled', result: { effectsUncertain: false } });
    expect(terminal).not.toHaveProperty('approvedTab');
    await f.disconnect(4001);
    await jest.advanceTimersByTimeAsync(0);
    await f.connect();

    expect(() => f.client.quiesceBrowserProviderJob(binding(current))).toThrow('owner_mismatch');
    const status = f.client.requestBrowserProviderStatus();
    await f.flush();
    await expect(status).resolves.toMatchObject({
      jobs: [terminal],
      unresolvedFence: { invocationId: current.invocationId },
    });
    expect((await status).unresolvedFence).not.toHaveProperty('tabId');
    expect(f.client.getBrowserProviderState()).toEqual({
      status: 'unavailable',
      reason: 'provider_unavailable',
      retryable: true,
    });
    expect(frames().filter(frame => frame.type === 'provider_quiesced')).toEqual([]);
    expect(f.snapshot(current.jobId)).toEqual(terminal);
  });

  it('makes unavailable explicit while permitting drained-work acknowledgement and disabling automatic registration', async () => {
    const client = await registered();
    const current = job();
    dispatch(current);
    update({ ...current, status: 'running', approvedTab: tab });
    client.markBrowserProviderUnavailable({
      providerId: current.providerId,
      generation: 1,
      reason: 'effects_uncertain',
      effectsUncertain: true,
    });
    expect(lastFrame('provider_unavailable')).toEqual({
      type: 'provider_unavailable',
      providerId: current.providerId,
      generation: 1,
      reason: 'effects_uncertain',
      effectsUncertain: true,
    });
    expect(client.getBrowserProviderState()).toMatchObject({
      status: 'unavailable',
      reason: 'effects_uncertain',
    });
    expect(() => client.sendBrowserProviderResult(completion(current))).toThrow(
      BrowserProviderError
    );
    inbound({ type: 'provider_job_cancel', ...binding(current), reason: 'effects_uncertain' });
    client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId });
    expect(lastFrame('provider_quiesced').tabId).toBe(tab.tabId);
    sockets[0].onclose?.({ code: 4001 } as CloseEvent);
    await jest.advanceTimersByTimeAsync(0);
    negotiate();
    expect(frames().map(frame => frame.type)).toEqual(['ping']);
  });

  it('reads status with explicit proof after withdrawal without restoring authority', async () => {
    const f = await relayRegistered();
    const { client } = f;
    const identity = {
      providerId: registration.providerId,
      providerProof: registration.providerProof,
    };
    const current = await f.invoke();
    client.approveBrowserProviderJob({
      ...binding(current),
      approval: { decision: 'approved', tab },
    });
    await f.flush();
    client.markBrowserProviderUnavailable({
      providerId: current.providerId,
      generation: current.generation,
      reason: 'effects_uncertain',
      effectsUncertain: true,
    });
    await f.flush();
    const terminal = f.snapshot(current.jobId);
    expect(terminal.result).toMatchObject({ effectsUncertain: true });
    const unavailable = client.getBrowserProviderState();
    const frameCount = frames().length;
    const messageCount = f.messages.length;
    await expect(client.requestBrowserProviderStatus()).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });

    const pending = client.requestBrowserProviderStatus(undefined, identity);
    await f.flush();
    const history = await pending;
    const unresolvedFence = { invocationId: current.invocationId, tabId: tab.tabId };
    expect(history).toMatchObject({
      type: 'provider_status_result',
      providerId: current.providerId,
      jobs: [terminal],
      unresolvedFence,
    });
    expect(client.getBrowserProviderState()).toEqual(unavailable);
    await expect(client.requestBrowserProviderStatus()).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    await expect(client.heartbeatBrowserProvider()).rejects.toMatchObject({
      code: 'effects_uncertain',
      retryable: false,
    });
    expect(() =>
      client.approveBrowserProviderJob({
        ...binding(current),
        approval: { decision: 'approved', tab },
      })
    ).toThrow('effects_uncertain');
    expect(() => client.sendBrowserProviderResult(completion(current))).toThrow(
      'effects_uncertain'
    );
    await jest.advanceTimersByTimeAsync(15_000);
    await f.flush();
    expect(f.snapshot(current.jobId)).toStrictEqual(terminal);
    expect(f.messages.slice(messageCount)).toStrictEqual([history]);
    expect(
      frames()
        .slice(frameCount)
        .map(frame => frame.type)
    ).toEqual(['provider_status']);

    await f.disconnect(4001);
    await jest.advanceTimersByTimeAsync(0);
    await f.connect();
    expect(frames().map(frame => frame.type)).toEqual(['ping']);
    await expect(client.requestBrowserProviderStatus()).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    const nextPage = client.requestBrowserProviderStatus(current.jobId, identity);
    await f.flush();
    await expect(nextPage).resolves.toMatchObject({ jobs: [], unresolvedFence });
    expect(client.getBrowserProviderState()).toEqual({ status: 'ready' });
    expect(frames().map(frame => frame.type)).toEqual(['ping', 'provider_status']);
  });

  it('uses explicit status identity without replacing cached registration', async () => {
    const client = await registered();
    const before = client.getBrowserProviderState();
    const identity = {
      providerId: `bp_${uuid(2)}`,
      providerProof: 'e'.repeat(64),
    } satisfies Pick<BrowserProviderRegistration, 'providerId' | 'providerProof'>;
    const cursor = job(3).jobId;
    const pending = client.requestBrowserProviderStatus(cursor, identity).catch(error => error);
    expect(lastFrame('provider_status')).toStrictEqual({
      type: 'provider_status',
      requestId: expect.any(String),
      ...identity,
      cursor,
    });
    const history = statusReply([job(4, { providerId: identity.providerId })]);
    await expect(pending).resolves.toStrictEqual(history);

    const cached = client.requestBrowserProviderStatus(cursor);
    expect(lastFrame('provider_status')).toMatchObject({
      providerId: registration.providerId,
      providerProof: registration.providerProof,
      cursor,
    });
    const cachedHistory = statusReply();
    await expect(cached).resolves.toStrictEqual(cachedHistory);
    expect(client.getBrowserProviderState()).toEqual(before);
  });

  it('keeps explicit status proof subject to relay authorization', async () => {
    const f = await relayRegistered();
    const current = await f.invoke();
    const before = f.client.getBrowserProviderState();
    const messageCount = f.messages.length;
    const pending = f.client
      .requestBrowserProviderStatus(undefined, {
        providerId: registration.providerId,
        providerProof: 'e'.repeat(64),
      })
      .catch(error => error);
    await f.flush();
    await expect(pending).resolves.toMatchObject({
      code: 'owner_mismatch',
      retryable: false,
      message: 'Browser provider request failed: owner_mismatch',
    });
    expect(f.messages.slice(messageCount)).toEqual([]);
    expect(f.client.getBrowserProviderState()).toEqual(before);

    const cached = f.client.requestBrowserProviderStatus(current.jobId);
    await f.flush();
    await expect(cached).resolves.toMatchObject({ jobs: [] });
    expect(lastFrame('provider_status').providerProof).toBe(registration.providerProof);
  });

  it.each([
    { condition: 'disabled', code: 'disabled', retryable: false },
    { condition: 'unretained', code: 'disconnected', retryable: true },
    { condition: 'unnegotiated', code: 'not_negotiated', retryable: true },
    { condition: 'unsupported', code: 'unsupported', retryable: false },
  ])('keeps explicit status blocked while $condition', async ({ condition, code, retryable }) => {
    const client = createProvider({ browserProvider: condition !== 'disabled' });
    if (condition !== 'unretained') {
      client.retain();
      open();
    }
    if (condition === 'unsupported') {
      inbound({ type: 'pong', nonce: lastFrame('ping').nonce });
    }
    const sent = sockets.length ? frames() : [];
    await expect(
      client.requestBrowserProviderStatus(undefined, registration)
    ).rejects.toMatchObject({ code, retryable });
    expect(sockets).toHaveLength(condition === 'unretained' ? 0 : 1);
    expect(sockets.length ? frames() : []).toStrictEqual(sent);
  });

  it.each([
    [
      'provider ID',
      {
        ...registration,
        providerId: 'invalid-provider' as BrowserProviderRegistration['providerId'],
      },
      undefined,
    ],
    ['provider proof', { ...registration, providerProof: 'invalid-proof' }, undefined],
    ['cursor', registration, 'invalid-cursor'],
  ] as const)(
    'rejects invalid explicit status %s before transport',
    async (_field, identity, cursor) => {
      const client = await registered();
      const sent = frames();
      const before = client.getBrowserProviderState();
      await expect(client.requestBrowserProviderStatus(cursor, identity)).rejects.toMatchObject({
        code: 'invalid_request',
        retryable: false,
        message: 'Browser provider request failed: invalid_request',
      });
      expect(frames()).toStrictEqual(sent);
      expect(client.getBrowserProviderState()).toEqual(before);
    }
  );

  it.each(['release', 'destroy', 'disconnect'] as const)(
    'rejects pending explicit status after %s and ignores late replies',
    async loss => {
      const client = createProvider();
      const release = client.retain();
      negotiate();
      const messages: BrowserProviderInboundMessage[] = [];
      client.onBrowserProviderMessage(message => messages.push(message));
      const pending = client
        .requestBrowserProviderStatus(undefined, registration)
        .catch(error => error);
      const request = lastFrame('provider_status');
      const ws = sockets[0];
      if (loss === 'release') release();
      else if (loss === 'destroy') client.destroy();
      else ws.onclose?.({ code: 4001 } as CloseEvent);
      await expect(pending).resolves.toMatchObject({ code: 'disconnected', retryable: true });
      inbound(
        {
          type: 'provider_status_result',
          requestId: request.requestId,
          providerId: request.providerId,
          jobs: [job()],
        },
        ws
      );
      expect(messages).toEqual([]);
      await expect(
        client.requestBrowserProviderStatus(undefined, registration)
      ).rejects.toMatchObject({ code: 'disconnected', retryable: true });
      expect(frames(ws).map(frame => frame.type)).toEqual(['ping', 'provider_status']);
    }
  );

  it('keeps queue metadata read-only while correlating history and preserving the live lease', async () => {
    const client = await registered(2);
    const current = job(1, { generation: 2, ownerLabel: 'ses_live_parent' });
    dispatch(current);
    client.approveBrowserProviderJob({
      ...binding(current),
      approval: { decision: 'approved', tab },
    });
    const before = client.getBrowserProviderState();
    const messages: BrowserProviderInboundMessage[] = [];
    client.onBrowserProviderMessage(message => messages.push(message));
    jest.setSystemTime(now + 1_000);
    const pending = client.requestBrowserProviderStatus(undefined, registration);
    const request = lastFrame('provider_status');
    const sent = frames();
    const unresolvedFence = { invocationId: current.invocationId, tabId: tab.tabId };
    inbound({
      type: 'provider_status_result',
      requestId: uuid(999),
      providerId: registration.providerId,
      jobs: [],
      unresolvedFence,
    });
    inbound({
      type: 'provider_status_result',
      requestId: request.requestId,
      providerId: `bp_${uuid(2)}`,
      jobs: [],
      unresolvedFence,
    });
    inbound({
      type: 'provider_status_result',
      requestId: request.requestId,
      providerId: registration.providerId,
      jobs: [{ ...current, providerId: `bp_${uuid(2)}` }],
      unresolvedFence,
    });
    inbound({
      type: 'provider_lease_ack',
      requestId: request.requestId,
      providerId: registration.providerId,
      generation: 2,
      leaseExpiresAt: new Date(now + 30_000).toISOString(),
    });
    expect(messages).toEqual([]);
    const terminal = job(2, {
      generation: 2,
      ownerLabel: 'ses_completed_parent',
      status: 'succeeded',
      approvedTab: tab,
      result: completion(job(2)).result,
    });
    const queued = job(3, {
      generation: 2,
      status: 'queued',
      ownerLabel: 'ses_queued_parent',
      queuePosition: 47,
    });
    const awaiting = job(4, { generation: 2, ownerLabel: 'ses_other_parent' });
    const history = {
      type: 'provider_status_result',
      requestId: request.requestId,
      providerId: request.providerId,
      jobs: [{ ...current, status: 'running', approvedTab: tab }, terminal, queued, awaiting],
      unresolvedFence,
    } satisfies BrowserProviderInboundMessage;
    inbound(history);
    await expect(pending).resolves.toStrictEqual(history);
    inbound(history);
    expect(messages).toStrictEqual([history]);
    expect(client.getBrowserProviderState()).toEqual(before);
    expect(() => client.sendBrowserProviderResult(completion(current))).toThrow('invalid_request');
    expect(() => client.cancelBrowserProviderJob(binding(queued))).toThrow('owner_mismatch');
    expect(() =>
      client.approveBrowserProviderJob({
        ...binding(awaiting),
        approval: { decision: 'approved', tab },
      })
    ).toThrow('owner_mismatch');
    expect(() =>
      client.quiesceBrowserProviderJob({ ...binding(terminal), tabId: tab.tabId })
    ).toThrow('owner_mismatch');
    expect(frames()).toStrictEqual(sent);

    update({ ...current, status: 'running', approvedTab: tab });
    client.sendBrowserProviderResult(completion(current));
    expect(lastFrame('provider_result')).toStrictEqual({
      type: 'provider_result',
      ...completion(current),
    });
    jest.setSystemTime(now + 15_001);
    await expect(client.heartbeatBrowserProvider()).rejects.toMatchObject({
      code: 'lease_expired',
      retryable: true,
    });
  });

  it('does not turn queued history into registration or adopted work', async () => {
    const client = createProvider();
    client.retain();
    negotiate();
    const registrationResult = client.registerBrowserProvider(registration);
    inbound({
      type: 'response',
      id: lastFrame('provider_register').requestId,
      error: { source: 'relay', code: 'provider_unavailable', retryable: true },
    });
    await expect(registrationResult).rejects.toMatchObject({ code: 'provider_unavailable' });
    const unavailable = client.getBrowserProviderState();
    const messages: BrowserProviderInboundMessage[] = [];
    client.onBrowserProviderMessage(message => messages.push(message));
    const queued = job(1, {
      status: 'queued',
      ownerLabel: 'ses_historical_parent',
      queuePosition: 100,
    });
    const awaiting = job(2, { ownerLabel: 'ses_other_parent' });
    const sent = frames();
    const history = statusReply([queued, awaiting]);
    inbound(history);
    dispatch(awaiting);
    update({ ...awaiting, status: 'running', approvedTab: tab });
    await jest.advanceTimersByTimeAsync(15_000);

    expect(messages).toStrictEqual([history]);
    expect(client.getBrowserProviderState()).toStrictEqual(unavailable);
    await expect(client.heartbeatBrowserProvider()).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    expect(() => client.cancelBrowserProviderJob(binding(queued))).toThrow('provider_unavailable');
    expect(() =>
      client.approveBrowserProviderJob({
        ...binding(awaiting),
        approval: { decision: 'approved', tab },
      })
    ).toThrow('provider_unavailable');
    expect(() => client.sendBrowserProviderResult(completion(awaiting))).toThrow(
      'provider_unavailable'
    );
    expect(() => client.quiesceBrowserProviderJob(binding(awaiting))).toThrow('owner_mismatch');
    expect(frames()).toStrictEqual(sent);
  });

  it('finishes an in-flight history read after registration loss without restoring availability', async () => {
    const client = await registered();
    const current = job();
    dispatch(current);
    const pending = client.requestBrowserProviderStatus();
    inbound({ type: 'provider_job_cancel', ...binding(current), reason: 'lease_expired' });
    const interrupted = {
      ...current,
      status: 'interrupted',
      result: {
        ...completion(current).result,
        status: 'interrupted',
        reason: 'lease_expired',
        effectsUncertain: true,
      },
    } satisfies BrowserJobSnapshot;
    const history = statusReply([interrupted]);
    await expect(pending).resolves.toEqual(history);
    expect(client.getBrowserProviderState()).toEqual({
      status: 'unavailable',
      reason: 'lease_expired',
      retryable: true,
    });
  });

  it.each([
    { code: 'request_timeout', retryable: true },
    { code: 'owner_mismatch', retryable: false },
  ])('keeps history failure $code separate from the live lease', async failure => {
    const client = await registered();
    const current = job();
    dispatch(current);
    update({ ...current, status: 'running', approvedTab: tab });
    const pending = client.requestBrowserProviderStatus().catch(error => error);
    if (failure.code === 'request_timeout') {
      jest.advanceTimersByTime(10_000);
    } else {
      inbound({
        type: 'response',
        id: lastFrame('provider_status').requestId,
        error: { source: 'relay', ...failure, message: registration.providerProof },
      });
    }
    await expect(pending).resolves.toMatchObject({
      ...failure,
      message: `Browser provider request failed: ${failure.code}`,
    });
    expect(client.getBrowserProviderState().status).toBe('registered');
    client.sendBrowserProviderResult(completion(current));
    expect(lastFrame('provider_result').result).toEqual(completion(current).result);
  });

  it('does not retain or buffer provider requests without an owner lifetime', async () => {
    const client = createProvider();
    const messages: BrowserProviderInboundMessage[] = [];
    client.onBrowserProviderMessage(message => messages.push(message));
    await expect(client.registerBrowserProvider(registration)).rejects.toMatchObject({
      code: 'disconnected',
    });
    await expect(client.requestBrowserProviderStatus()).rejects.toMatchObject({
      code: 'disconnected',
    });
    expect(() => client.sendBrowserProviderResult(completion(job()))).toThrow('disconnected');
    expect(sockets).toHaveLength(0);
    client.retain();
    negotiate();
    expect(frames().map(frame => frame.type)).toEqual(['ping']);
    expect(messages).toEqual([]);
  });

  it('delivers a correlated lease acknowledgement only once while status is pending', async () => {
    const client = await registered();
    const grants: string[] = [];
    client.onBrowserProviderMessage(message => {
      if (message.type === 'provider_lease_ack') grants.push(message.requestId);
    });
    const pending = client.heartbeatBrowserProvider();
    const request = lastFrame('provider_heartbeat');
    const ack = leaseAck(request);
    inbound(ack);
    heartbeatReply();
    await expect(pending).resolves.toMatchObject({ jobs: [] });
    inbound(ack);
    expect(grants).toEqual([request.requestId]);
  });

  it('does not renew an expired lease when its acknowledgement beats a suspended timer', async () => {
    const client = await registered();
    const pending = client.heartbeatBrowserProvider();
    const outcome = pending.catch(error => error);
    jest.setSystemTime(now + 15_001);
    leaseAck(lastFrame('provider_heartbeat'));
    expect(client.getBrowserProviderState()).toMatchObject({
      status: 'unavailable',
      reason: 'lease_expired',
    });
    await expect(outcome).resolves.toMatchObject({ code: 'lease_expired' });
  });

  it('notifies the owner when an action detects a closed socket before its close event', async () => {
    const client = await registered();
    dispatch();
    const states: string[] = [];
    client.onBrowserProviderStateChange(state => states.push(state.status));
    sockets[0].readyState = 3;
    expect(() =>
      client.approveBrowserProviderJob({
        ...binding(job()),
        approval: { decision: 'approved', tab },
      })
    ).toThrow('disconnected');
    expect(states).toEqual(['disconnected']);
    expect(frames().filter(frame => frame.type === 'provider_approval')).toEqual([]);
  });

  it('stops approved work when a running snapshot beats the expired lease timer', async () => {
    const client = await registered();
    const current = job();
    dispatch(current);
    client.approveBrowserProviderJob({
      ...binding(current),
      approval: { decision: 'approved', tab },
    });
    const events: string[] = [];
    let canRun = true;
    client.onBrowserProviderStateChange(state => {
      if (state.status === 'unavailable') {
        canRun = false;
        events.push(state.reason);
      }
    });
    client.onBrowserProviderMessage(message => {
      if (
        message.type === 'provider_snapshot' &&
        message.jobs.some(job => job.status === 'running') &&
        canRun
      ) {
        events.push('browser action');
      }
    });
    // Move wall time without running the suspended lease timer.
    jest.setSystemTime(now + 15_001);
    update({ ...current, status: 'running', approvedTab: tab });
    expect(events).toEqual(['lease_expired']);
    expect(client.getBrowserProviderState()).toMatchObject({
      status: 'unavailable',
      reason: 'lease_expired',
    });
    expect(() => client.sendBrowserProviderResult(completion(current))).toThrow('lease_expired');
  });

  it.each(['approval_timeout', 'execution_timeout', 'invocation_expired'] as const)(
    'reports %s revocation before cancellation and permits drained acknowledgement',
    async reason => {
      const f = await relayRegistered();
      const current = await f.invoke(
        1,
        reason === 'invocation_expired' ? now - 7 * 24 * 60 * 60 * 1_000 + 10_000 : now
      );
      if (reason !== 'approval_timeout') {
        f.client.approveBrowserProviderJob({
          ...binding(current),
          approval: { decision: 'approved', tab },
        });
        await f.flush();
      }
      const active = f.snapshot(current.jobId);
      const deadlineText =
        reason === 'invocation_expired'
          ? active.expiresAt
          : active.deadlines[reason === 'approval_timeout' ? 'approval' : 'execution'];
      if (!deadlineText) throw new Error('Expected a relay deadline');
      const deadline = Date.parse(deadlineText);
      for (let time = now + 10_000; time < deadline; time += 10_000) {
        jest.setSystemTime(time);
        const heartbeat = f.client.heartbeatBrowserProvider();
        await f.flush();
        await heartbeat;
      }
      const events: string[] = [];
      f.client.onBrowserProviderStateChange(state => {
        if (state.status === 'unavailable') events.push(state.reason);
      });
      f.client.onBrowserProviderMessage(message => {
        if (message.type === 'provider_job_cancel') {
          events.push(`cancel:${f.client.getBrowserProviderState().status}`);
        }
      });
      jest.setSystemTime(deadline);
      await f.alarm();
      expect(events).toEqual([reason, 'cancel:unavailable']);
      expect(f.client.getBrowserProviderState()).toEqual({
        status: 'unavailable',
        reason,
        retryable: true,
      });
      f.client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId });
      await f.flush();
      const registrationResult = f.client.registerBrowserProvider({
        ...registration,
        generation: current.generation,
      });
      await f.flush();
      await expect(registrationResult).resolves.toMatchObject({ generation: 2 });
    }
  );

  it.each(['queued', 'unapproved'] as const)(
    'preserves registration when Stop cancels %s work without revoking the relay lease',
    async phase => {
      const f = await relayRegistered();
      const active = await f.invoke();
      const cancelled = phase === 'queued' ? await f.invoke(2) : active;
      const cancellationStates: string[] = [];
      f.client.onBrowserProviderMessage(message => {
        if (message.type === 'provider_job_cancel') {
          cancellationStates.push(f.client.getBrowserProviderState().status);
        }
      });
      f.client.cancelBrowserProviderJob(binding(cancelled));
      await f.flush();
      expect(f.client.getBrowserProviderState().status).toBe('registered');
      expect(cancellationStates).toEqual(phase === 'queued' ? [] : ['registered']);
      expect(f.snapshot(cancelled.jobId)).toMatchObject({
        status: 'cancelled',
        result: { effectsUncertain: false },
      });
      if (phase === 'unapproved') {
        f.client.quiesceBrowserProviderJob({ ...binding(cancelled), tabId: tab.tabId });
        await f.flush();
      }
      const next = phase === 'queued' ? active : await f.invoke(3);
      f.client.approveBrowserProviderJob({
        ...binding(next),
        approval: { decision: 'approved', tab },
      });
      await f.flush();
      expect(f.snapshot(next.jobId)).toMatchObject({
        status: 'running',
        generation: active.generation,
      });
    }
  );

  it('reports running Stop revocation before cancellation and retains safe quiescence', async () => {
    const f = await relayRegistered();
    const current = await f.invoke();
    f.client.approveBrowserProviderJob({
      ...binding(current),
      approval: { decision: 'approved', tab },
    });
    await f.flush();
    const events: string[] = [];
    f.client.onBrowserProviderStateChange(state => {
      if (state.status === 'unavailable') events.push(state.reason);
    });
    f.client.onBrowserProviderMessage(message => {
      if (message.type === 'provider_job_cancel') {
        events.push(`cancel:${f.client.getBrowserProviderState().status}`);
      }
    });
    f.client.cancelBrowserProviderJob(binding(current));
    await f.flush();
    expect(events).toEqual(['cancelled', 'cancel:unavailable']);
    expect(f.snapshot(current.jobId)).toMatchObject({
      status: 'cancelled',
      result: { effectsUncertain: true },
    });
    const retry = f.client
      .registerBrowserProvider({ ...registration, generation: current.generation })
      .catch(error => error);
    await f.flush();
    await expect(retry).resolves.toMatchObject({ code: 'provider_unavailable' });
    f.client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId });
    await f.flush();
    const registrationResult = f.client.registerBrowserProvider({
      ...registration,
      generation: current.generation,
    });
    await f.flush();
    await expect(registrationResult).resolves.toMatchObject({ generation: 2 });
  });

  it('fences relay lease loss before cancellation callbacks or another job can run', async () => {
    const client = await registered();
    const current = job();
    dispatch(current);
    const events: string[] = [];
    client.onBrowserProviderStateChange(state => {
      if (state.status === 'unavailable') events.push(state.reason);
    });
    client.onBrowserProviderMessage(message => {
      if (message.type === 'provider_job_cancel') events.push('cancel');
      if (message.type === 'provider_job') events.push('execute');
    });
    inbound({ type: 'provider_job_cancel', ...binding(current), reason: 'lease_expired' });
    dispatch(job(2));
    expect(events).toEqual(['lease_expired', 'cancel']);
    expect(client.getBrowserProviderState()).toMatchObject({
      status: 'unavailable',
      reason: 'lease_expired',
    });
    client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId });
    expect(lastFrame('provider_quiesced').jobId).toBe(current.jobId);
  });

  it.each(['send failure', 'disconnect'])(
    'does not re-enable an unavailable provider after %s',
    async loss => {
      const client = await registered();
      if (loss === 'send failure') {
        sockets[0].send.mockImplementationOnce(() => {
          throw new Error('socket closed');
        });
      } else {
        sockets[0].onclose?.({ code: 4001 } as CloseEvent);
      }
      expect(() =>
        client.markBrowserProviderUnavailable({
          providerId: registration.providerId,
          generation: 1,
          reason: 'provider_unavailable',
          effectsUncertain: false,
        })
      ).toThrow(BrowserProviderError);
      await jest.advanceTimersByTimeAsync(0);
      negotiate();
      expect(frames().map(frame => frame.type)).toEqual(['ping']);
    }
  );

  it('fences an expired lease before owner callbacks can send another action', async () => {
    const client = await registered();
    const current = job();
    dispatch(current);
    const ordering: string[] = [];
    client.onBrowserProviderStateChange(state => {
      if (state.status !== 'unavailable') return;
      ordering.push(state.reason);
      try {
        client.approveBrowserProviderJob({
          ...binding(current),
          approval: { decision: 'approved', tab },
        });
      } catch (error) {
        ordering.push(error instanceof BrowserProviderError ? error.code : 'wrong error');
      }
    });
    jest.advanceTimersByTime(15_000);
    expect(ordering).toEqual(['lease_expired', 'lease_expired']);
    leaseAck(lastFrame('provider_heartbeat'));
    dispatch(job(2));
    expect(client.getBrowserProviderState()).toMatchObject({
      status: 'unavailable',
      reason: 'lease_expired',
    });
    expect(frames().filter(frame => frame.type === 'provider_approval')).toEqual([]);
  });

  it.each([1006, 4001, 1008])(
    'recovers prior-generation terminal history after ticket loss (%i) without replay',
    async code => {
      const auth = createDeferred<string>();
      let authCalls = 0;
      const f = await relayRegistered({
        getAuthToken: () => (++authCalls === 1 ? 'old-ticket' : auth.promise),
      });
      const { client } = f;
      const current = await f.invoke();
      client.approveBrowserProviderJob({
        ...binding(current),
        approval: { decision: 'approved', tab },
      });
      await f.flush();
      client.sendBrowserProviderResult(completion(current));
      await f.flush();
      client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId });
      await f.flush();
      const completed = f.snapshot(current.jobId);
      const order: string[] = [];
      client.onBrowserProviderStateChange(state => {
        if (state.status !== 'disconnected') return;
        order.push('stop');
        try {
          client.sendBrowserProviderResult(completion(current));
        } catch (error) {
          order.push(error instanceof BrowserProviderError ? error.code : 'wrong error');
        }
      });
      client.onConnectionChange(connected => {
        if (!connected) order.push('connection lost');
      });
      const pending = client.requestBrowserProviderStatus().catch(error => error);
      const oldSocket = sockets[0];
      await f.disconnect(code, oldSocket);
      await expect(pending).resolves.toMatchObject({ code: 'disconnected' });
      expect(order).toEqual(['stop', 'disconnected', 'connection lost']);
      if (code === 1006) jest.advanceTimersByTime(500);
      expect(sockets).toHaveLength(1);
      dispatch(job(2), oldSocket);
      expect(() => client.sendBrowserProviderResult(completion(current))).toThrow(
        BrowserProviderError
      );
      auth.resolve('new-ticket');
      await jest.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(2);
      expect(
        new URL(webSocketConstructor.mock.calls[1][0] as string).searchParams.get('ticket')
      ).toBe('new-ticket');
      await f.connect();
      expect(lastFrame('provider_register')).toMatchObject({ ...registration, generation: 1 });
      expect(lastFrame('provider_register')).not.toHaveProperty('recovery');
      const recovered = f.messages
        .filter(message => message.type === 'provider_status_result')
        .at(-1);
      expect(recovered?.jobs).toStrictEqual([{ ...completed, ownerLabel: 'ses_parent' }]);
      expect(f.snapshot(current.jobId)).toStrictEqual(completed);
      expect(recovered?.jobs[0]).toMatchObject({
        generation: current.generation,
        status: 'succeeded',
        result: completion(current).result,
      });
      expect(client.getBrowserProviderState()).toMatchObject({
        status: 'registered',
        lease: { generation: 2 },
      });
      const heartbeat = client.heartbeatBrowserProvider();
      await f.flush();
      await expect(heartbeat).resolves.toMatchObject({ generation: 2, jobs: [] });
      dispatch(current, oldSocket);
      dispatch(current);
      expect(f.messages.filter(message => message.type === 'provider_job')).toHaveLength(1);
      expect(() => client.sendBrowserProviderResult(completion(current))).toThrow(
        BrowserProviderError
      );
      expect(
        frames().filter(
          frame => frame.type === 'provider_result' || frame.type === 'provider_approval'
        )
      ).toEqual([]);
    }
  );

  it('recovers fenced interruption history even when reconnect registration is rejected', async () => {
    const f = await relayRegistered();
    const current = await f.invoke();
    f.client.approveBrowserProviderJob({
      ...binding(current),
      approval: { decision: 'approved', tab },
    });
    await f.flush();
    await f.disconnect(4001);
    await jest.advanceTimersByTimeAsync(0);
    await f.connect();
    const interrupted = f.snapshot(current.jobId);
    const recovered = f.messages
      .filter(message => message.type === 'provider_status_result')
      .at(-1);
    const unresolvedFence = { invocationId: current.invocationId, tabId: tab.tabId };
    expect(recovered).toMatchObject({ jobs: [interrupted], unresolvedFence });
    expect(interrupted).toMatchObject({
      generation: current.generation,
      status: 'interrupted',
      result: { reason: 'provider_lost', effectsUncertain: true },
    });
    expect(f.client.getBrowserProviderState()).toEqual({
      status: 'unavailable',
      reason: 'provider_unavailable',
      retryable: true,
    });
    const status = f.client.requestBrowserProviderStatus(current.jobId);
    await f.flush();
    await expect(status).resolves.toMatchObject({ jobs: [], unresolvedFence });
    expect(() => f.client.sendBrowserProviderResult(completion(current))).toThrow(
      BrowserProviderError
    );
    expect(() =>
      f.client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId })
    ).toThrow(BrowserProviderError);
    const retry = f.client
      .registerBrowserProvider({ ...registration, generation: current.generation })
      .catch(error => error);
    await f.flush();
    await expect(retry).resolves.toMatchObject({ code: 'provider_unavailable' });
    expect(f.messages.filter(message => message.type === 'provider_job')).toHaveLength(1);
    expect(
      frames().filter(
        frame =>
          frame.type === 'provider_approval' ||
          frame.type === 'provider_result' ||
          frame.type === 'provider_quiesced'
      )
    ).toEqual([]);
  });

  it.each(['approved', 'unapproved'] as const)(
    'delivers an expired %s fence after refused registration without execution authority',
    async phase => {
      const f = await relayRegistered();
      const current = await f.invoke();
      if (phase === 'approved') {
        f.client.approveBrowserProviderJob({
          ...binding(current),
          approval: { decision: 'approved', tab },
        });
        await f.flush();
      }
      await f.disconnect(4001);
      jest.setSystemTime(Date.parse(current.expiresAt) + 1);
      await f.alarm();
      expect(() => f.snapshot(current.jobId)).toThrow('Expected a persisted job');
      await jest.advanceTimersByTimeAsync(0);

      const messageCount = f.messages.length;
      await f.connect();
      const unresolvedFence =
        phase === 'approved'
          ? { invocationId: current.invocationId, tabId: tab.tabId }
          : { invocationId: current.invocationId };
      const automaticHistory = {
        type: 'provider_status_result',
        requestId: lastFrame('provider_status').requestId,
        providerId: registration.providerId,
        jobs: [],
        unresolvedFence,
      } satisfies BrowserProviderInboundMessage;
      expect(f.messages.slice(messageCount)).toStrictEqual([automaticHistory]);
      const unavailable = f.client.getBrowserProviderState();
      expect(unavailable).toEqual({
        status: 'unavailable',
        reason: 'provider_unavailable',
        retryable: true,
      });

      const status = f.client.requestBrowserProviderStatus();
      const history = { ...automaticHistory, requestId: lastFrame('provider_status').requestId };
      await f.flush();
      await expect(status).resolves.toStrictEqual(history);
      dispatch(current);
      update({ ...current, status: 'running', approvedTab: tab });
      expect(f.messages.slice(messageCount)).toStrictEqual([automaticHistory, history]);
      expect(f.client.getBrowserProviderState()).toEqual(unavailable);
      await expect(f.client.heartbeatBrowserProvider()).rejects.toMatchObject({
        code: 'provider_unavailable',
        retryable: true,
      });
      expect(() =>
        f.client.approveBrowserProviderJob({
          ...binding(current),
          approval: { decision: 'approved', tab },
        })
      ).toThrow(BrowserProviderError);
      expect(() => f.client.sendBrowserProviderResult(completion(current))).toThrow(
        BrowserProviderError
      );
      expect(() =>
        f.client.quiesceBrowserProviderJob({ ...binding(current), tabId: tab.tabId })
      ).toThrow(BrowserProviderError);

      const retry = f.client
        .registerBrowserProvider({ ...registration, generation: current.generation })
        .catch(error => error);
      await f.flush();
      await expect(retry).resolves.toMatchObject({ code: 'provider_unavailable' });
      expect(f.messages.slice(messageCount)).toStrictEqual([
        automaticHistory,
        history,
        { ...history, requestId: lastFrame('provider_status').requestId },
      ]);
      expect(frames().map(frame => frame.type)).toEqual([
        'ping',
        'provider_register',
        'provider_status',
        'provider_status',
        'provider_register',
        'provider_status',
      ]);
    }
  );

  it('stops later callbacks when a listener releases the connection and ignores late socket events', async () => {
    const client = createProvider();
    const release = client.retain();
    negotiate();
    const pending = client.registerBrowserProvider(registration);
    leaseAck(lastFrame('provider_register'));
    await pending;
    statusReply();
    const actions: string[] = [];
    const unsubscribe = client.onBrowserProviderMessage(message => {
      if (message.type === 'provider_job') {
        actions.push('stop');
        release();
      }
    });
    client.onBrowserProviderMessage(message => {
      if (message.type === 'provider_job') actions.push('execute');
    });
    dispatch();
    expect(actions).toEqual(['stop']);
    const oldSocket = sockets[0];
    unsubscribe();
    client.retain();
    open(oldSocket);
    dispatch(job(2), oldSocket);
    expect(client.getBrowserProviderState()).toEqual({ status: 'disconnected' });
    expect(actions).toEqual(['stop']);
    client.destroy();
    const states: BrowserProviderState[] = [];
    client.onBrowserProviderStateChange(state => states.push(state));
    open();
    dispatch(job(3));
    expect(states).toEqual([]);
    expect(actions).toEqual(['stop']);
  });

  it('never repeats an explicit recovery assertion after its registration acknowledgement is lost', async () => {
    const client = createProvider();
    client.retain();
    negotiate();
    const pending = client.registerBrowserProvider({
      ...registration,
      recovery: {
        invocationId: job().invocationId,
        tabId: 42,
        tabClosed: true,
        locksDrained: true,
      },
    });
    sockets[0].onclose?.({ code: 4001 } as CloseEvent);
    await expect(pending).rejects.toMatchObject({ code: 'disconnected' });
    await jest.advanceTimersByTimeAsync(0);
    negotiate();
    expect(lastFrame('provider_register')).not.toHaveProperty('recovery');
    expect(lastFrame('provider_register').providerProof).toBe(registration.providerProof);
  });

  it.each([
    { code: 'owner_mismatch', retryable: false },
    { code: 'provider_unavailable', retryable: true },
  ])(
    'surfaces safe relay failure $code without exposing the proof-bearing error text',
    async failure => {
      const client = createProvider();
      client.retain();
      negotiate();
      await expect(
        client.registerBrowserProvider({
          ...registration,
          providerProof: `private-proof:${registration.providerProof}`,
        })
      ).rejects.toMatchObject({ message: 'Browser provider request failed: invalid_request' });
      const pending = client.registerBrowserProvider(registration);
      inbound({
        type: 'response',
        id: lastFrame('provider_register').requestId,
        error: {
          source: 'relay',
          ...failure,
          message: `private-ticket ${registration.providerProof}`,
          [registration.providerProof]: 'secret',
        },
      });
      await expect(pending).rejects.toMatchObject({
        ...failure,
        message: `Browser provider request failed: ${failure.code}`,
      });
      expect(client.getBrowserProviderState()).toEqual({
        status: 'unavailable',
        reason: failure.code,
        retryable: failure.retryable,
      });
    }
  );

  it('redacts socket send failures and refresh failures before the base connection logs them', async () => {
    const logs: string[] = [];
    jest.spyOn(console, 'error').mockImplementation((...values: unknown[]) => {
      logs.push(
        values.map(value => (value instanceof Error ? value.message : String(value))).join(' ')
      );
    });
    let calls = 0;
    const client = createProvider({
      getAuthToken: () => {
        if (++calls === 1) return 'private-ticket';
        throw new Error(`private-ticket ${registration.providerProof}`);
      },
    });
    client.retain();
    negotiate();
    sockets[0].send.mockImplementationOnce(() => {
      throw new Error(registration.providerProof);
    });
    await expect(client.registerBrowserProvider(registration)).rejects.toMatchObject({
      code: 'disconnected',
      message: 'Browser provider request failed: disconnected',
    });
    await jest.advanceTimersByTimeAsync(0);
    // Exercise the base connection's logging auth-close path on the replacement socket.
    sockets.at(-1)?.onclose?.({ code: 4001 } as CloseEvent);
    await jest.advanceTimersByTimeAsync(0);
    expect(logs.join('\n')).toContain('Failed to refresh auth');
    expect(logs.join('\n')).not.toContain('private-ticket');
    expect(logs.join('\n')).not.toContain(registration.providerProof);
  });
});
