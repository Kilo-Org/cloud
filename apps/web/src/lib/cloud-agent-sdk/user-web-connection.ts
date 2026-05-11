import {
  createBaseConnection,
  type Connection,
  type ConnectionLifecycleHooks,
} from './base-connection';
import {
  sessionEventPayloadSchema,
  webInboundMessageSchema,
  type SessionEventPayload,
  type WebInboundMessage,
} from './schemas';

const COMMAND_TIMEOUT_MS = 30_000;
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
  connect: () => void;
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

function createUserWebConnection(config: UserWebConnectionConfig): UserWebConnection {
  let token = '';
  let baseConnection: Connection | null = null;
  let currentWs: WebSocket | null = null;
  let destroyed = false;
  let started = false;
  let generation = 0;
  let connectPromise: Promise<void> | null = null;
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

  function rejectPending(message: string): void {
    for (const waiter of pendingOpenWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      pendingOpenWaiters.delete(waiter);
    }
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      pendingCommands.delete(id);
    }
  }

  function resolveOpenWaiters(ws: WebSocket): void {
    for (const waiter of pendingOpenWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(ws);
      pendingOpenWaiters.delete(waiter);
    }
  }

  function waitForOpen(): Promise<WebSocket> {
    if (destroyed) return Promise.reject(new Error('Connection destroyed'));
    connect();
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

  function ensureBaseConnection(): void {
    if (baseConnection) return;
    baseConnection = createBaseConnection({
      lifecycleHooks: config.lifecycleHooks,
      buildUrl: () => `${config.websocketUrl}?token=${token}`,
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
        currentWs = ws;
        resolveOpenWaiters(ws);
        for (const sessionId of subscriptionCounts.keys()) sendSubscribe(sessionId);
      },
      onConnected: () => {},
      onReconnected: () => {
        config.onReconnect?.();
        for (const listener of reconnectListeners) listener();
      },
      onDisconnected: () => {
        currentWs = null;
      },
      onError: config.onError,
      isAuthFailure: event => event.code === 4001 || event.code === 1008,
      refreshAuth: async () => {
        token = await config.getAuthToken();
      },
    });
  }

  function connect(): void {
    if (destroyed) return;
    if (started || connectPromise) return;

    destroyed = false;
    started = true;
    generation += 1;
    const expectedGeneration = generation;

    const openWithToken = (value: string): void => {
      if (!started || destroyed || expectedGeneration !== generation) return;
      token = value;
      ensureBaseConnection();
      baseConnection?.connect();
    };
    const rejectAuthFailure = (): void => {
      if (expectedGeneration !== generation) return;
      started = false;
      rejectPending('Failed to get auth token');
      config.onError?.('Failed to get auth token');
    };

    try {
      const tokenResult = config.getAuthToken();
      if (typeof tokenResult === 'string') {
        openWithToken(tokenResult);
        return;
      }

      connectPromise = tokenResult
        .then(
          value => {
            openWithToken(value);
          },
          () => {
            rejectAuthFailure();
          }
        )
        .finally(() => {
          if (expectedGeneration === generation) connectPromise = null;
        });
    } catch {
      rejectAuthFailure();
    }
  }

  return {
    connect,
    disconnect() {
      generation += 1;
      connectPromise = null;
      started = false;
      currentWs = null;
      rejectPending('Connection disconnected');
      baseConnection?.destroy();
      baseConnection = null;
    },
    destroy() {
      generation += 1;
      connectPromise = null;
      destroyed = true;
      started = false;
      currentWs = null;
      rejectPending('Connection destroyed');
      baseConnection?.destroy();
      baseConnection = null;
      subscriptionCounts.clear();
      cliListeners.clear();
      systemListeners.clear();
      reconnectListeners.clear();
      sessionListeners.clear();
    },
    subscribeToCliSession(sessionId) {
      const current = subscriptionCounts.get(sessionId) ?? 0;
      subscriptionCounts.set(sessionId, current + 1);
      connect();
      if (current === 0) sendSubscribe(sessionId);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = subscriptionCounts.get(sessionId) ?? 0;
        if (count <= 1) {
          subscriptionCounts.delete(sessionId);
          sendUnsubscribe(sessionId);
        } else {
          subscriptionCounts.set(sessionId, count - 1);
        }
      };
    },
    sendCommand(sessionId, command, data) {
      return new Promise((resolve, reject) => {
        void waitForOpen().then(
          ws => {
            if (destroyed || !started || ws.readyState !== WebSocket.OPEN) {
              reject(new Error(destroyed ? 'Connection destroyed' : 'Connection disconnected'));
              return;
            }

            const id = crypto.randomUUID();
            const timer = setTimeout(() => {
              pendingCommands.delete(id);
              reject(new Error('Command timed out'));
            }, COMMAND_TIMEOUT_MS);
            pendingCommands.set(id, { resolve, reject, timer });
            ws.send(JSON.stringify({ type: 'command', id, command, sessionId, data }));
          },
          reason => {
            reject(reason instanceof Error ? reason : new Error('WebSocket is not connected'));
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
