export type BaseConnectionConfig<T = unknown> = {
  buildUrl: () => string;
  parseMessage: (
    data: unknown
  ) => { type: 'event'; payload: T } | { type: 'error'; message: string } | null;
  onEvent: (payload: T) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onUnexpectedDisconnect?: () => void;
  onError?: (message: string) => void;
  isAuthFailure?: (event: CloseEvent) => boolean;
  refreshAuth?: () => Promise<void>;
  onOpen?: (ws: WebSocket) => void;
};

export type Connection = {
  connect: () => void;
  disconnect: () => void;
  destroy: () => void;
};

const MAX_RECONNECT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

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

  function clearReconnectTimer(): void {
    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }
  }

  async function refreshAuthAndReconnect(expectedGeneration: number) {
    if (!config.refreshAuth) {
      return;
    }

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
    }
  }

  function scheduleReconnect(attempt: number, expectedGeneration: number) {
    if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;

    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      console.log('[Connection] Max reconnection attempts exceeded');
      return;
    }

    const delay = calculateBackoffDelay(attempt);
    reconnectAttempt = attempt + 1;

    console.log('[Connection] Scheduling reconnect', {
      attempt: reconnectAttempt,
      delayMs: delay,
    });

    reconnectTimeoutId = setTimeout(() => {
      reconnectTimeoutId = null;
      if (!destroyed && !intentionalDisconnect && expectedGeneration === generation) {
        connectInternal(reconnectAttempt, expectedGeneration);
      }
    }, delay);
  }

  function connectInternal(attempt = 0, expectedGeneration = generation) {
    if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;

    reconnectAttempt = attempt;

    // Close existing socket - clear reference first so onclose ignores it
    const oldWs = ws;
    if (oldWs !== null) {
      ws = null;
      oldWs.close();
    }

    const url = config.buildUrl();

    console.log('[Connection] Connecting', { attempt });

    const newWs = new WebSocket(url);
    ws = newWs;

    newWs.onopen = () => {
      config.onOpen?.(newWs);
    };

    newWs.onmessage = (messageEvent: MessageEvent) => {
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
        config.onConnected();
      }

      config.onEvent(parsed.payload);
    };

    newWs.onerror = (errorEvent: Event) => {
      console.log('[Connection] WebSocket error', {
        type: errorEvent.type,
        authRefreshAttempted,
        connected,
      });
    };

    newWs.onclose = (event: CloseEvent) => {
      // Ignore close events from replaced sockets
      if (ws !== newWs) {
        console.log('[Connection] Ignoring close from replaced socket');
        return;
      }
      ws = null;

      console.log('[Connection] WebSocket closed', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        intentionalDisconnect,
        authRefreshAttempted,
        connected,
      });

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
        console.log('[Connection] Auth failure after refresh - stopping retries');
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

  function connect() {
    console.log('[Connection] connect() called - resetting state');
    intentionalDisconnect = false;
    destroyed = false;
    authRefreshAttempted = false;
    connected = false;
    reconnectAttempt = 0;
    generation += 1;
    clearReconnectTimer();
    connectInternal(0, generation);
  }

  function disconnect() {
    intentionalDisconnect = true;
    generation += 1;

    clearReconnectTimer();

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

    clearReconnectTimer();

    if (ws !== null) {
      ws.close();
      ws = null;
    }

    // No callbacks on destroy - permanent teardown
    connected = false;
  }

  return { connect, disconnect, destroy };
}
