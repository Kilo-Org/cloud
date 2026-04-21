export type WebSocketHeaders = Record<string, string>;

type WebSocketConstructorWithHeaders = {
  new (
    url: string | URL,
    protocols?: string | string[],
    options?: { headers?: WebSocketHeaders }
  ): WebSocket;
};

export type ConnectionLifecycleHooks = {
  /** Subscribe to visibility changes. `onResume` fires when the tab becomes
   *  visible; `onHidden` fires when it becomes hidden. Returns a cleanup fn. */
  onVisibilityChange?: (onResume: () => void, onHidden: () => void) => () => void;
  /** Called when BFCache restore is detected (pageshow event with persisted=true) */
  onPageshow?: (handler: (e: { persisted: boolean }) => void) => () => void;
  /** Called when the browser comes back online */
  onOnline?: (handler: () => void) => () => void;
};

export type BaseConnectionConfig<T = unknown> = {
  buildUrl: () => string;
  parseMessage: (
    data: unknown
  ) => { type: 'event'; payload: T } | { type: 'error'; message: string } | null;
  onEvent: (payload: T) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onReconnected?: () => void;
  onUnexpectedDisconnect?: () => void;
  onError?: (message: string) => void;
  isAuthFailure?: (event: CloseEvent) => boolean;
  refreshAuth?: () => Promise<void>;
  shouldRefreshAuthBeforeConnect?: () => boolean;
  onOpen?: (ws: WebSocket) => void;
  websocketHeaders?: WebSocketHeaders;
  /** How long to wait for a server message (e.g. heartbeat) on tab resume before
   *  treating the connection as stale. Should exceed the server's heartbeat interval. */
  stalenessTimeoutMs?: number;
  /** Optional lifecycle hooks for browser-specific reconnection behavior.
   *  If not provided, no automatic reconnection on lifecycle events occurs.
   *  For browser usage, use `createBrowserLifecycleHooks()`.
   *  For CLI usage, omit this or provide custom hooks. */
  lifecycleHooks?: ConnectionLifecycleHooks;
};

export type Connection = {
  connect: () => void;
  disconnect: () => void;
  destroy: () => void;
};

const MAX_RECONNECT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
export const DEFAULT_STALENESS_TIMEOUT_MS = 30_000;

// min(cap, base * 2^attempt) * (0.5 + random jitter)
function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  const jitter = 0.5 + Math.random();
  return Math.floor(exponentialDelay * jitter);
}

export function createBaseConnection<T>(config: BaseConnectionConfig<T>): Connection {
  let ws: WebSocket | null = null;
  let intentionalDisconnect = false;
  let destroyed = false;
  let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let authRefreshAttempted = false;
  let connected = false;
  let reconnectAttempt = 0;
  let generation = 0;
  let hasConnectedOnce = false;
  let stalenessTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastMessageTime = 0;
  let preconnectAuthRefreshAttempted = false;
  const stalenessTimeoutMs = config.stalenessTimeoutMs ?? DEFAULT_STALENESS_TIMEOUT_MS;

  // Cleanup functions returned by lifecycle hooks
  const cleanupFns: Array<() => void> = [];
  let lifecycleListenersRegistered = false;

  function clearReconnectTimer(): void {
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  function clearStalenessTimeout(): void {
    if (stalenessTimeoutId !== null) {
      clearTimeout(stalenessTimeoutId);
      stalenessTimeoutId = null;
    }
  }

  async function refreshAuthAndReconnect(expectedGeneration: number) {
    if (!config.refreshAuth) {
      return;
    }

    preconnectAuthRefreshAttempted = true;

    try {
      await config.refreshAuth();
      if (destroyed || intentionalDisconnect || expectedGeneration !== generation) {
        return;
      }
      authRefreshAttempted = true;
      connectInternal(0, expectedGeneration);
    } catch (err) {
      console.error('[Connection] Failed to refresh auth:', err);
      if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;
      config.onUnexpectedDisconnect?.();
      scheduleReconnect(0, expectedGeneration);
    } finally {
      if (expectedGeneration === generation) {
        preconnectAuthRefreshAttempted = false;
      }
    }
  }

  async function refreshAndConnect(expectedGeneration: number): Promise<void> {
    preconnectAuthRefreshAttempted = true;

    try {
      if (config.refreshAuth) {
        try {
          await config.refreshAuth();
        } catch {
          // Continue with existing auth — the old ticket might still work
        }
        if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;
      }
      connectInternal(0, expectedGeneration);
    } finally {
      if (expectedGeneration === generation) {
        preconnectAuthRefreshAttempted = false;
      }
    }
  }

  function scheduleReconnect(attempt: number, expectedGeneration: number) {
    if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      return;
    }

    const delay = calculateBackoffDelay(attempt);
    reconnectAttempt = attempt + 1;

    reconnectTimeoutId = setTimeout(() => {
      reconnectTimeoutId = null;
      if (!destroyed && !intentionalDisconnect && expectedGeneration === generation) {
        connectInternal(reconnectAttempt, expectedGeneration);
      }
    }, delay);
  }

  function connectInternal(attempt = 0, expectedGeneration = generation) {
    if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;

    if (
      config.refreshAuth &&
      (config.shouldRefreshAuthBeforeConnect?.() ?? false) &&
      !preconnectAuthRefreshAttempted
    ) {
      void refreshAndConnect(expectedGeneration);
      return;
    }

    reconnectAttempt = attempt;
    clearStalenessTimeout();
    // Anchor the staleness clock to this socket so visibility checks don't
    // inherit timing from a previous connection.
    lastMessageTime = Date.now();

    // Close existing socket - clear reference first so onclose ignores it
    const oldWs = ws;
    if (oldWs !== null) {
      ws = null;
      oldWs.close();
    }

    const url = config.buildUrl();

    const newWs = config.websocketHeaders
      ? new (WebSocket as WebSocketConstructorWithHeaders)(url, undefined, {
          headers: config.websocketHeaders,
        })
      : new WebSocket(url);
    ws = newWs;

    newWs.onopen = () => {
      config.onOpen?.(newWs);
    };

    newWs.onmessage = (messageEvent: MessageEvent) => {
      // Any incoming message cancels an active staleness check
      clearStalenessTimeout();
      lastMessageTime = Date.now();

      const parsed = config.parseMessage(messageEvent.data);
      if (parsed === null) {
        return;
      }

      if (parsed.type === 'error') {
        config.onError?.(parsed.message);
        return;
      }

      // Reset auth refresh flag on successful message
      authRefreshAttempted = false;
      reconnectAttempt = 0;

      if (!connected) {
        connected = true;
        if (hasConnectedOnce) {
          config.onReconnected?.();
        } else {
          hasConnectedOnce = true;
          config.onConnected();
        }
      }

      config.onEvent(parsed.payload);
    };

    newWs.onerror = () => {};

    newWs.onclose = (event: CloseEvent) => {
      // Ignore close events from replaced sockets
      if (ws !== newWs) {
        return;
      }
      ws = null;

      if (destroyed) return;

      if (intentionalDisconnect) {
        if (connected) {
          connected = false;
          config.onDisconnected();
        }
        return;
      }

      const wasConnected = connected;
      if (connected) {
        connected = false;
        config.onDisconnected();
      }

      const isAuthFailure = config.isAuthFailure?.(event) ?? false;

      if (isAuthFailure && !authRefreshAttempted && config.refreshAuth) {
        void refreshAuthAndReconnect(expectedGeneration);
        return;
      }

      // Already tried refreshing auth and still failing - stop retrying
      if (isAuthFailure && authRefreshAttempted) {
        return;
      }

      config.onUnexpectedDisconnect?.();

      // Reset attempt counter if we were connected, otherwise continue count
      if (wasConnected || attempt === 0) {
        scheduleReconnect(0, expectedGeneration);
      } else {
        scheduleReconnect(reconnectAttempt, expectedGeneration);
      }
    };
  }

  function handleVisibilityResume(): void {
    if (destroyed || intentionalDisconnect) return;

    // Tab became visible
    reconnectAttempt = 0;

    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      clearReconnectTimer();
      void refreshAndConnect(generation);
      return;
    }

    // If a message arrived recently, the connection is verified alive
    if (Date.now() - lastMessageTime < stalenessTimeoutMs) {
      return;
    }

    // Socket appears open but no recent message — wait for the next server
    // heartbeat to confirm liveness; if nothing arrives, treat as stale.
    const currentGeneration = generation;
    stalenessTimeoutId = setTimeout(() => {
      stalenessTimeoutId = null;
      if (destroyed || intentionalDisconnect || currentGeneration !== generation) return;
      const staleWs = ws;
      if (staleWs !== null) {
        ws = null;
        staleWs.close();
      }
      if (connected) {
        connected = false;
        config.onDisconnected();
      }
      void refreshAndConnect(currentGeneration);
    }, stalenessTimeoutMs);
  }

  function handleVisibilityHidden(): void {
    if (destroyed || intentionalDisconnect) return;
    clearStalenessTimeout();
  }

  function handlePageshow(event: { persisted: boolean }): void {
    if (destroyed || intentionalDisconnect) return;

    if (!event.persisted) return;

    // BFCache restore - WebSocket is guaranteed dead
    reconnectAttempt = 0;
    clearReconnectTimer();
    clearStalenessTimeout();

    const staleWs = ws;
    if (staleWs !== null) {
      ws = null;
      staleWs.close();
    }
    if (connected) {
      connected = false;
      config.onDisconnected();
    }
    void refreshAndConnect(generation);
  }

  function handleOnline(): void {
    if (destroyed || intentionalDisconnect) return;

    // If already connected with an open socket, nothing to do
    if (connected && ws !== null && ws.readyState === WebSocket.OPEN) return;

    reconnectAttempt = 0;
    clearReconnectTimer();
    void refreshAndConnect(generation);
  }

  function addEventListeners(): void {
    if (!config.lifecycleHooks || lifecycleListenersRegistered) return;

    lifecycleListenersRegistered = true;

    if (config.lifecycleHooks.onVisibilityChange) {
      cleanupFns.push(
        config.lifecycleHooks.onVisibilityChange(handleVisibilityResume, handleVisibilityHidden)
      );
    }
    if (config.lifecycleHooks.onPageshow) {
      cleanupFns.push(config.lifecycleHooks.onPageshow(handlePageshow));
    }
    if (config.lifecycleHooks.onOnline) {
      cleanupFns.push(config.lifecycleHooks.onOnline(handleOnline));
    }
  }

  function removeEventListeners(): void {
    for (const cleanup of cleanupFns) cleanup();
    cleanupFns.length = 0;
    lifecycleListenersRegistered = false;
  }

  function connect() {
    intentionalDisconnect = false;
    destroyed = false;
    authRefreshAttempted = false;
    preconnectAuthRefreshAttempted = false;
    connected = false;
    reconnectAttempt = 0;
    hasConnectedOnce = false;
    lastMessageTime = 0;
    generation += 1;
    clearReconnectTimer();
    clearStalenessTimeout();
    addEventListeners();
    connectInternal(0, generation);
  }

  function disconnect() {
    intentionalDisconnect = true;
    generation += 1;
    preconnectAuthRefreshAttempted = false;

    clearReconnectTimer();
    clearStalenessTimeout();
    removeEventListeners();

    if (ws !== null) {
      ws.close();
      ws = null;
    }

    if (connected) {
      connected = false;
      config.onDisconnected();
    }
  }

  function destroy() {
    destroyed = true;
    generation += 1;
    preconnectAuthRefreshAttempted = false;

    clearReconnectTimer();
    clearStalenessTimeout();
    removeEventListeners();

    if (ws !== null) {
      ws.close();
      ws = null;
    }

    // No callbacks on destroy - permanent teardown
    connected = false;
  }

  return { connect, disconnect, destroy };
}

export function createBrowserLifecycleHooks(): ConnectionLifecycleHooks {
  return {
    onVisibilityChange: (onResume, onHidden) => {
      if (typeof document === 'undefined') return () => {};
      const handler = () => {
        if (document.visibilityState === 'hidden') {
          onHidden();
        } else {
          onResume();
        }
      };
      document.addEventListener('visibilitychange', handler);
      return () => document.removeEventListener('visibilitychange', handler);
    },
    onPageshow: handler => {
      if (typeof window === 'undefined') return () => {};
      const wrapped = (e: PageTransitionEvent) => handler({ persisted: e.persisted });
      window.addEventListener('pageshow', wrapped);
      return () => window.removeEventListener('pageshow', wrapped);
    },
    onOnline: handler => {
      if (typeof window === 'undefined') return () => {};
      window.addEventListener('online', handler);
      return () => window.removeEventListener('online', handler);
    },
  };
}
