import {
  createBaseConnection,
  type Connection,
  type ConnectionLifecycleHooks,
} from './base-connection';
import { cloudAgentSdkRuntime } from './runtime';
import {
  sessionEventPayloadSchema,
  webInboundMessageSchema,
  type SessionEventPayload,
  type WebInboundMessage,
} from './schemas';

const COMMAND_TIMEOUT_MS = 30_000;
const INITIAL_AUTH_RETRY_BASE_MS = 1_000;
const INITIAL_AUTH_RETRY_CAP_MS = 30_000;
export const VIEWER_PING_INTERVAL_MS = 20_000;
export const VIEWER_PONG_TIMEOUT_MS = 10_000;

type UserWebSessionEventName = SessionEventPayload['type'];
type UserWebSessionEventData<T extends UserWebSessionEventName> = Extract<
  SessionEventPayload,
  { type: T }
>['data'];
type CliEvent = Omit<Extract<WebInboundMessage, { type: 'event' }>, 'type'>;
type SystemEvent = Omit<Extract<WebInboundMessage, { type: 'system' }>, 'type'>;

type UserWebConnectionConfig = {
  websocketUrl: string;
  getAuthToken: () => string | Promise<string>;
  onError?: (message: string) => void;
  onReconnect?: () => void;
  lifecycleHooks?: ConnectionLifecycleHooks;
};

type UserWebConnection = {
  /** New connection owners use this lease; optional on injected legacy clients until they migrate. */
  retain?: () => () => void;
  /** @deprecated Retain the connection explicitly with retain() instead. */
  connect: () => void;
  /** @deprecated Release the function returned by retain() instead. */
  disconnect: () => void;
  destroy: () => void;
  subscribeToCliSession: (sessionId: string) => () => void;
  sendCommand: (sessionId: string, command: string, data: unknown) => Promise<unknown>;
  onCliEvent: (sessionId: string, listener: (event: CliEvent) => void) => () => void;
  onSystemEvent: (listener: (event: SystemEvent) => void) => () => void;
  onReconnect: (listener: () => void) => () => void;
  onSessionEvent: <T extends UserWebSessionEventName>(
    event: T,
    listener: (data: UserWebSessionEventData<T>) => void
  ) => () => void;
};

function createUserWebConnection(
  config: UserWebConnectionConfig
): UserWebConnection & { retain: () => () => void } {
  const connectionId = cloudAgentSdkRuntime.randomUUID();
  let token = '';
  let baseConnection: Connection | null = null;
  let currentWs: WebSocket | null = null;
  let destroyed = false;
  let started = false;
  let generation = 0;
  let connectPromise: Promise<void> | null = null;
  let retainCount = 0;
  let commandRetainCount = 0;
  let legacyRetained = false;
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let pongTimeout: ReturnType<typeof setTimeout> | null = null;
  let initialAuthRetryTimeout: ReturnType<typeof setTimeout> | null = null;
  let initialAuthRetryAttempt = 0;
  let outstandingPingNonce: string | null = null;
  const preSocketLifecycleCleanupFns: Array<() => void> = [];
  let preSocketLifecycleRegistered = false;
  const subscriptionCounts = new Map<string, number>();
  const cliListeners = new Map<string, Set<(event: CliEvent) => void>>();
  const systemListeners = new Set<(event: SystemEvent) => void>();
  const reconnectListeners = new Set<() => void>();
  const sessionListeners = new Map<UserWebSessionEventName, Set<(data: never) => void>>();
  const pendingCommands = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const pendingOpenWaiters = new Set<{
    resolve: (ws: WebSocket) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  function hasLifetime(): boolean {
    return retainCount > 0;
  }

  function sendWire(value: unknown): void {
    if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return;
    currentWs.send(JSON.stringify(value));
  }

  function sendSubscribe(sessionId: string): void {
    sendWire({ type: 'subscribe', sessionId });
  }

  function sendUnsubscribe(sessionId: string): void {
    sendWire({ type: 'unsubscribe', sessionId });
  }

  function clearPongTimeout(): void {
    if (pongTimeout !== null) {
      clearTimeout(pongTimeout);
      pongTimeout = null;
    }
    outstandingPingNonce = null;
  }

  function clearLiveness(): void {
    if (pingInterval !== null) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
    clearPongTimeout();
  }

  function clearInitialAuthRetry(): void {
    if (initialAuthRetryTimeout !== null) {
      clearTimeout(initialAuthRetryTimeout);
      initialAuthRetryTimeout = null;
    }
    initialAuthRetryAttempt = 0;
  }

  function scheduleInitialAuthRetry(expectedGeneration: number): void {
    if (destroyed || !hasLifetime() || expectedGeneration !== generation) return;

    const exponentialDelay = Math.min(
      INITIAL_AUTH_RETRY_CAP_MS,
      INITIAL_AUTH_RETRY_BASE_MS * Math.pow(2, initialAuthRetryAttempt)
    );
    const delay = Math.floor(exponentialDelay * (0.5 + Math.random()));
    initialAuthRetryAttempt += 1;
    initialAuthRetryTimeout = setTimeout(() => {
      initialAuthRetryTimeout = null;
      if (destroyed || !hasLifetime() || expectedGeneration !== generation) return;
      startConnection(false);
    }, delay);
  }

  function requestPreSocketRecovery(): void {
    if (destroyed || !hasLifetime() || baseConnection || started || connectPromise) return;
    if (initialAuthRetryTimeout !== null) {
      clearTimeout(initialAuthRetryTimeout);
      initialAuthRetryTimeout = null;
    }
    startConnection(false);
  }

  function addPreSocketLifecycleListeners(): void {
    if (!config.lifecycleHooks || preSocketLifecycleRegistered || baseConnection) return;
    preSocketLifecycleRegistered = true;
    if (config.lifecycleHooks.onVisibilityChange) {
      preSocketLifecycleCleanupFns.push(
        config.lifecycleHooks.onVisibilityChange(requestPreSocketRecovery, () => {})
      );
    }
    if (config.lifecycleHooks.onPageshow) {
      preSocketLifecycleCleanupFns.push(
        config.lifecycleHooks.onPageshow(event => {
          if (event.persisted) requestPreSocketRecovery();
        })
      );
    }
    if (config.lifecycleHooks.onOnline) {
      preSocketLifecycleCleanupFns.push(config.lifecycleHooks.onOnline(requestPreSocketRecovery));
    }
  }

  function removePreSocketLifecycleListeners(): void {
    for (const cleanup of preSocketLifecycleCleanupFns) cleanup();
    preSocketLifecycleCleanupFns.length = 0;
    preSocketLifecycleRegistered = false;
  }

  function replaceUnresponsiveSocket(): void {
    if (destroyed || !hasLifetime()) return;
    clearPongTimeout();
    currentWs = null;
    baseConnection?.reconnectWithRefreshedAuth?.();
  }

  function sendPing(): void {
    if (destroyed || !hasLifetime() || outstandingPingNonce !== null) return;
    if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return;

    const nonce = cloudAgentSdkRuntime.randomUUID();
    outstandingPingNonce = nonce;
    sendWire({ type: 'ping', nonce });
    pongTimeout = setTimeout(replaceUnresponsiveSocket, VIEWER_PONG_TIMEOUT_MS);
  }

  function startLiveness(): void {
    clearLiveness();
    if (!hasLifetime()) return;
    pingInterval = setInterval(sendPing, VIEWER_PING_INTERVAL_MS);
  }

  function rejectPending(message: string): void {
    for (const waiter of pendingOpenWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      pendingOpenWaiters.delete(waiter);
    }
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pendingCommands.delete(id);
      pending.reject(new Error(message));
    }
  }

  function resolveOpenWaiters(ws: WebSocket): void {
    for (const waiter of pendingOpenWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(ws);
      pendingOpenWaiters.delete(waiter);
    }
  }

  function retainConnection(): () => void {
    if (destroyed) return () => {};
    retainCount += 1;
    if (retainCount === 1) {
      addPreSocketLifecycleListeners();
      startConnection();
    }

    let released = false;
    return () => {
      if (released || destroyed) return;
      released = true;
      retainCount -= 1;
      if (retainCount === 0) stopConnection('Connection disconnected');
    };
  }

  function waitForOpen(): Promise<WebSocket> {
    if (destroyed) return Promise.reject(new Error('Connection destroyed'));
    if (currentWs && currentWs.readyState === WebSocket.OPEN) return Promise.resolve(currentWs);
    if (!started && !connectPromise) return Promise.reject(new Error('Failed to get auth token'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          pendingOpenWaiters.delete(waiter);
          reject(new Error('WebSocket is not connected'));
        }, COMMAND_TIMEOUT_MS),
      };
      pendingOpenWaiters.add(waiter);
    });
  }

  function handleInboundMessage(msg: WebInboundMessage): void {
    if (msg.type === 'pong') {
      if (msg.nonce === outstandingPingNonce) clearPongTimeout();
      return;
    }

    if (msg.type === 'event') {
      for (const key of [msg.sessionId, msg.parentSessionId]) {
        if (!key) continue;
        for (const listener of cliListeners.get(key) ?? []) listener(msg);
      }
      return;
    }

    if (msg.type === 'system') {
      for (const listener of systemListeners) listener(msg);
      const parsed = sessionEventPayloadSchema.safeParse({ type: msg.event, data: msg.data });
      if (parsed.success) {
        for (const listener of sessionListeners.get(parsed.data.type) ?? []) {
          listener(parsed.data.data as never);
        }
      }
      return;
    }

    const pending = pendingCommands.get(msg.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingCommands.delete(msg.id);
    if (msg.error)
      pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Command failed'));
    else pending.resolve(msg.result);
  }

  function createLifecycleHooks(): ConnectionLifecycleHooks | undefined {
    const lifecycleHooks = config.lifecycleHooks;
    if (!lifecycleHooks) return undefined;
    return {
      onVisibilityChange: lifecycleHooks.onVisibilityChange
        ? (onResume, onHidden) =>
            lifecycleHooks.onVisibilityChange?.(() => {
              onResume();
              sendPing();
            }, onHidden) ?? (() => {})
        : undefined,
      onPageshow: lifecycleHooks.onPageshow,
      onOnline: lifecycleHooks.onOnline
        ? handler =>
            lifecycleHooks.onOnline?.(() => {
              handler();
              sendPing();
            }) ?? (() => {})
        : undefined,
    };
  }

  function buildUrl(): string {
    const url = new URL(config.websocketUrl);
    url.searchParams.set('token', token);
    url.searchParams.set('connectionId', connectionId);
    return url.toString();
  }

  function ensureBaseConnection(): void {
    if (baseConnection) return;
    removePreSocketLifecycleListeners();
    baseConnection = createBaseConnection({
      lifecycleHooks: createLifecycleHooks(),
      buildUrl,
      parseMessage: (data: unknown) => {
        if (typeof data !== 'string') return null;
        try {
          const parsed: unknown = JSON.parse(data);
          const result = webInboundMessageSchema.safeParse(parsed);
          if (!result.success) return null;
          return { type: 'event', payload: result.data };
        } catch {
          return null;
        }
      },
      onEvent: handleInboundMessage,
      onOpen: ws => {
        if (!hasLifetime()) return;
        currentWs = ws;
        resolveOpenWaiters(ws);
        for (const sessionId of subscriptionCounts.keys()) sendSubscribe(sessionId);
        startLiveness();
      },
      onConnected: () => {},
      onReconnected: () => {
        config.onReconnect?.();
        for (const listener of reconnectListeners) listener();
      },
      onReplacingConnection: () => {
        rejectPending('Connection lost during reconnect');
      },
      onDisconnected: () => {
        currentWs = null;
        clearLiveness();
      },
      onUnexpectedDisconnect: () => {
        rejectPending('Connection lost during reconnect');
      },
      onError: config.onError,
      isAuthFailure: event => event.code === 4001 || event.code === 1008,
      refreshAuth: async () => {
        token = await config.getAuthToken();
      },
    });
  }

  function startConnection(newLifetime = true): void {
    if (destroyed || started || connectPromise) return;

    started = true;
    if (newLifetime) {
      generation += 1;
      clearInitialAuthRetry();
    }
    const expectedGeneration = generation;

    const openWithToken = (value: string): void => {
      if (!started || destroyed || !hasLifetime() || expectedGeneration !== generation) return;
      clearInitialAuthRetry();
      token = value;
      ensureBaseConnection();
      baseConnection?.connect();
    };
    const rejectAuthFailure = (): void => {
      if (expectedGeneration !== generation) return;
      started = false;
      rejectPending('Failed to get auth token');
      config.onError?.('Failed to get auth token');
      scheduleInitialAuthRetry(expectedGeneration);
    };

    try {
      const tokenResult = config.getAuthToken();
      if (typeof tokenResult === 'string') {
        openWithToken(tokenResult);
        return;
      }

      connectPromise = tokenResult.then(openWithToken, rejectAuthFailure).finally(() => {
        if (expectedGeneration === generation) connectPromise = null;
      });
    } catch {
      rejectAuthFailure();
    }
  }

  function stopConnection(message: string): void {
    generation += 1;
    connectPromise = null;
    started = false;
    currentWs = null;
    clearLiveness();
    clearInitialAuthRetry();
    removePreSocketLifecycleListeners();
    rejectPending(message);
    baseConnection?.destroy();
    baseConnection = null;
  }

  function connect(): void {
    if (destroyed || legacyRetained) return;
    legacyRetained = true;
    retainConnection();
  }

  return {
    retain: retainConnection,
    connect,
    disconnect() {
      if (!legacyRetained || destroyed) return;
      legacyRetained = false;
      retainCount -= 1;
      if (retainCount === 0) stopConnection('Connection disconnected');
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      legacyRetained = false;
      retainCount = 0;
      commandRetainCount = 0;
      stopConnection('Connection destroyed');
      subscriptionCounts.clear();
      cliListeners.clear();
      systemListeners.clear();
      reconnectListeners.clear();
      sessionListeners.clear();
    },
    subscribeToCliSession(sessionId) {
      if (destroyed) return () => {};
      const releaseConnection = retainConnection();
      const current = subscriptionCounts.get(sessionId) ?? 0;
      subscriptionCounts.set(sessionId, current + 1);
      if (current === 0) sendSubscribe(sessionId);
      let released = false;
      return () => {
        if (released || destroyed) return;
        released = true;
        const count = subscriptionCounts.get(sessionId) ?? 0;
        if (count <= 1) {
          subscriptionCounts.delete(sessionId);
          sendUnsubscribe(sessionId);
        } else {
          subscriptionCounts.set(sessionId, count - 1);
        }
        releaseConnection();
      };
    },
    sendCommand(sessionId, command, data) {
      const hasOwnerLifetime = retainCount > commandRetainCount;
      const releaseCommandLifetime = hasOwnerLifetime ? null : retainConnection();
      if (releaseCommandLifetime) commandRetainCount += 1;
      let commandLifetimeReleased = false;
      const releaseLifetime = () => {
        if (commandLifetimeReleased) return;
        commandLifetimeReleased = true;
        if (releaseCommandLifetime) {
          commandRetainCount -= 1;
          releaseCommandLifetime();
        }
      };

      return new Promise((resolve, reject) => {
        const resolveCommand = (value: unknown) => {
          releaseLifetime();
          resolve(value);
        };
        const rejectCommand = (reason: Error) => {
          releaseLifetime();
          reject(reason);
        };
        void waitForOpen().then(
          ws => {
            if (destroyed || !hasLifetime() || ws.readyState !== WebSocket.OPEN) {
              rejectCommand(
                new Error(destroyed ? 'Connection destroyed' : 'Connection disconnected')
              );
              return;
            }

            const id = cloudAgentSdkRuntime.randomUUID();
            const timer = setTimeout(() => {
              pendingCommands.delete(id);
              rejectCommand(new Error('Command timed out'));
            }, COMMAND_TIMEOUT_MS);
            pendingCommands.set(id, { resolve: resolveCommand, reject: rejectCommand, timer });
            ws.send(JSON.stringify({ type: 'command', id, command, sessionId, data }));
          },
          reason => {
            rejectCommand(
              reason instanceof Error ? reason : new Error('WebSocket is not connected')
            );
          }
        );
      });
    },
    onCliEvent(sessionId, listener) {
      const listeners = cliListeners.get(sessionId) ?? new Set<(event: CliEvent) => void>();
      listeners.add(listener);
      cliListeners.set(sessionId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) cliListeners.delete(sessionId);
      };
    },
    onSystemEvent(listener) {
      systemListeners.add(listener);
      return () => systemListeners.delete(listener);
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    onSessionEvent(event, listener) {
      const listeners = sessionListeners.get(event) ?? new Set<(data: never) => void>();
      listeners.add(listener as (data: never) => void);
      sessionListeners.set(event, listeners);
      return () => {
        listeners.delete(listener as (data: never) => void);
        if (listeners.size === 0) sessionListeners.delete(event);
      };
    },
  };
}

export { createUserWebConnection };
export type {
  UserWebConnection,
  UserWebConnectionConfig,
  UserWebSessionEventName,
  UserWebSessionEventData,
  SessionEventPayload,
  CliEvent as UserWebCliEvent,
  SystemEvent as UserWebSystemEvent,
};
