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
  onVisibilityChange?: ((onResume: () => void, onHidden: () => void) => () => void) | undefined;
  /** Called when BFCache restore is detected (pageshow event with persisted=true) */
  onPageshow?: ((handler: (e: { persisted: boolean }) => void) => () => void) | undefined;
  /** Called when the browser comes back online */
  onOnline?: ((handler: () => void) => () => void) | undefined;
  /** Close the socket this long after `onHidden`, and open no socket and mint no
   *  auth until `onResume`. A socket that drops while hidden is not replaced.
   *  Omit to keep the socket open and reconnecting while hidden. */
  hiddenPauseDelayMs?: number | undefined;
};

export type BaseConnectionConfig<T = unknown> = {
  buildUrl: () => string;
  parseMessage: (
    data: unknown
  ) => { type: 'event'; payload: T } | { type: 'error'; message: string } | null;
  onEvent: (payload: T) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onReconnected?: (() => void) | undefined;
  onUnexpectedDisconnect?: (() => void) | undefined;
  onReplacingConnection?: (() => void) | undefined;
  onError?: ((message: string) => void) | undefined;
  isAuthFailure?: ((event: CloseEvent) => boolean) | undefined;
  refreshAuth?: (() => Promise<void>) | undefined;
  shouldRefreshAuthBeforeConnect?: (() => boolean) | undefined;
  onOpen?: ((ws: WebSocket) => void) | undefined;
  websocketHeaders?: WebSocketHeaders | undefined;
  /** How long to wait for a server message (e.g. heartbeat) on tab resume before
   *  treating the connection as stale. Should exceed the server's heartbeat interval. */
  stalenessTimeoutMs?: number | undefined;
  /** Optional lifecycle hooks for browser-specific reconnection behavior.
   *  If not provided, no automatic reconnection on lifecycle events occurs.
   *  For browser usage, use `createBrowserLifecycleHooks()`.
   *  For CLI usage, omit this or provide custom hooks. */
  lifecycleHooks?: ConnectionLifecycleHooks | undefined;
  /** Cap on automatic reconnect attempts before the connection is considered
   *  exhausted. Defaults to `MAX_RECONNECT_ATTEMPTS`. */
  maxReconnectAttempts?: number | undefined;
  /** Fires on both edges of the reconnect-exhaustion state: `true` when the
   *  automatic retry cap is reached (or a terminal auth failure stops retries),
   *  and `false` when any recovery path resets the state. */
  onReconnectExhaustionChange?: ((exhausted: boolean) => void) | undefined;
};

export type SocketPhase = 'absent' | 'connecting' | 'open';

export type Connection = {
  connect: () => void;
  disconnect: () => void;
  reconnectWithRefreshedAuth?: () => void;
  retryReconnect: () => void;
  recoverAfterSuccessfulMutation: () => void;
  destroy: () => void;
  /** Phase of the socket this connection holds now: `connecting` while a
   *  handshake is in flight, `open` when it is usable, `absent` for no socket
   *  and every closed or closing state. */
  socketPhase: () => SocketPhase;
};

export const MAX_RECONNECT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
export const DEFAULT_STALENESS_TIMEOUT_MS = 30_000;
/** How long a resume trigger joins an in-flight auth refresh before starting over. */
const REFRESH_JOIN_DEADLINE_MS = 15_000;

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
  let exhaustionReason: 'retry-limit' | 'auth-failure' | null = null;
  let generation = 0;
  let hasConnectedOnce = false;
  let stalenessTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let lastMessageTime = 0;
  let hiddenAt = 0;
  // Both stay false unless `lifecycleHooks.hiddenPauseDelayMs` is set.
  let hidden = false;
  let paused = false;
  let hiddenPauseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  // Counted, not boolean: an abandoned refresh must not clear the gate that a
  // newer refresh owns.
  let preconnectRefreshes = 0;
  // Coalesce successful mutations into one retry budget at a time. A later mutation may
  // request another bounded cycle after that budget exhausts without any inbound event.
  let mutationRecovery: 'idle' | 'pending' | 'active' = 'idle';
  const stalenessTimeoutMs = config.stalenessTimeoutMs ?? DEFAULT_STALENESS_TIMEOUT_MS;
  const maxReconnectAttempts = config.maxReconnectAttempts ?? MAX_RECONNECT_ATTEMPTS;

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

  function clearHiddenPause(): void {
    hidden = false;
    paused = false;
    if (hiddenPauseTimeoutId !== null) {
      clearTimeout(hiddenPauseTimeoutId);
      hiddenPauseTimeoutId = null;
    }
  }

  // Close the socket and stop every reconnect path until the next resume.
  function pauseWhileHidden(): void {
    if (destroyed || intentionalDisconnect) return;
    paused = true;
    if (hiddenPauseTimeoutId !== null) {
      clearTimeout(hiddenPauseTimeoutId);
      hiddenPauseTimeoutId = null;
    }
    clearReconnectTimer();
    clearStalenessTimeout();
    if (ws !== null && !closeCurrentSocket()) return;
    if (connected) {
      connected = false;
      config.onDisconnected();
    }
  }

  function clearExhausted(): void {
    if (exhaustionReason !== null) {
      exhaustionReason = null;
      config.onReconnectExhaustionChange?.(false);
    }
  }

  // Tell consumers the current route is going away before its socket is dropped.
  // Callers notify first and then check the gate, so an aborted replacement still
  // reports the route loss consumers already saw.
  function notifyReplacingConnection(): void {
    config.onReplacingConnection?.();
  }

  function isConnectionReplacementAllowed(expectedGeneration = generation): boolean {
    return !destroyed && !intentionalDisconnect && expectedGeneration === generation;
  }

  // Single owner of the replacement order: notify route loss, then drop the
  // old socket with its reference cleared first so its onclose is ignored.
  // Callers decide whether the replacement also reports a disconnection.
  function closeCurrentSocket(expectedGeneration = generation): boolean {
    notifyReplacingConnection();
    if (!isConnectionReplacementAllowed(expectedGeneration)) return false;
    const staleWs = ws;
    if (staleWs !== null) {
      ws = null;
      staleWs.close();
    }
    return true;
  }

  // One resume can arrive from several triggers at once (NetInfo online, a
  // visibility resume, a BFCache restore). The first starts the refresh; the
  // rest join it, so one resume costs one ticket refresh and one socket.
  type RefreshAttempt = {
    generation: number;
    promise: Promise<void>;
    startedAt: number;
    /** Cleared once this attempt gives its gate back, so it can never release another's. */
    holdingGate: boolean;
    /** What started this refresh. An auth-classified close owns a stricter failure policy. */
    trigger: 'resume' | 'auth-close';
  };
  let inflightRefresh: RefreshAttempt | null = null;

  async function runRefreshAndConnect(
    expectedGeneration: number,
    attempt: number,
    socketBeforeRefresh: WebSocket | null,
    entry: RefreshAttempt
  ): Promise<void> {
    try {
      if (config.refreshAuth) {
        try {
          await config.refreshAuth();
        } catch (err) {
          if (entry.trigger === 'auth-close') {
            // An auth-classified close must not open a socket with the ticket
            // that just failed auth. Report the loss and retry with backoff.
            console.error('[Connection] Failed to refresh auth:', err);
            if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;
            // An abandoned attempt does not own the connection state any more:
            // reporting its loss or spending the retry budget would disturb the
            // socket the attempt that replaced it is opening or holding.
            if (!entry.holdingGate || inflightRefresh !== entry) return;
            config.onUnexpectedDisconnect?.();
            scheduleReconnect(reconnectAttempt, expectedGeneration);
            return;
          }
          // Continue with existing auth — the old ticket might still work
        }
        if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;
        // This attempt was abandoned: a newer one owns the connection state and
        // its ticket, so opening a socket here would replace the socket that
        // attempt is opening.
        if (!entry.holdingGate || inflightRefresh !== entry) return;
        // An auth-classified close spends its one refresh before it checks the
        // socket, so a second auth close stops retrying instead of refreshing
        // again.
        if (entry.trigger === 'auth-close') authRefreshAttempted = true;
        // The async refresh gap can let the in-flight socket finish its
        // handshake and receive its first message. If it did, there is nothing
        // to replace — reconnecting would close a healthy socket and open a
        // duplicate (the two-socket `/stream` open). This is the NetInfo
        // `unknown → online` race: handleOnline decides to reconnect while the
        // socket is still CONNECTING, but the socket establishes before the
        // refresh resolves.
        if (connected && ws !== null && ws.readyState === WebSocket.OPEN) return;
        // A socket that appeared during the gap belongs to another recovery
        // path that is already opening it for this generation. Replacing it
        // would report route loss for a connection this resume never
        // superseded.
        if (ws !== null && ws !== socketBeforeRefresh && ws.readyState === WebSocket.CONNECTING)
          return;
      }
      connectInternal(attempt, expectedGeneration, true);
    } finally {
      // An abandoned attempt already gave its gate back; releasing it again
      // would open the gate a newer attempt owns.
      if (entry.holdingGate && expectedGeneration === generation) {
        entry.holdingGate = false;
        preconnectRefreshes -= 1;
      }
    }
  }

  /** Give up the in-flight refresh so the next trigger starts a fresh attempt. */
  function abandonInflightRefresh(): void {
    const abandoned = inflightRefresh;
    if (abandoned === null) return;
    inflightRefresh = null;
    if (abandoned.holdingGate) {
      abandoned.holdingGate = false;
      preconnectRefreshes -= 1;
    }
  }

  function refreshAndConnect(
    expectedGeneration: number,
    attempt = 0,
    trigger: 'resume' | 'auth-close' = 'resume'
  ): Promise<void> {
    if (paused) return Promise.resolve();

    const joined = inflightRefresh;
    // A refresh that never settles must not wedge the generation: before this
    // change every trigger started its own attempt, so a later trigger could
    // recover from a hung one. Past the window a new trigger starts over.
    if (
      joined !== null &&
      joined.generation === expectedGeneration &&
      Date.now() - joined.startedAt < REFRESH_JOIN_DEADLINE_MS
    ) {
      // An auth-classified close that joins a pending refresh needs that
      // refresh's auth failure policy: a failed ticket must still stop the
      // socket open and consume the `authRefreshAttempted` loop bound.
      if (trigger === 'auth-close') joined.trigger = 'auth-close';
      return joined.promise;
    }
    abandonInflightRefresh();

    const entry: RefreshAttempt = {
      generation: expectedGeneration,
      promise: Promise.resolve(),
      startedAt: Date.now(),
      holdingGate: true,
      trigger,
    };
    preconnectRefreshes += 1;
    inflightRefresh = entry;
    entry.promise = runRefreshAndConnect(expectedGeneration, attempt, ws, entry).finally(() => {
      if (inflightRefresh === entry) inflightRefresh = null;
    });
    return entry.promise;
  }

  function scheduleReconnect(attempt: number, expectedGeneration: number) {
    if (destroyed || intentionalDisconnect || paused || expectedGeneration !== generation) return;

    if (attempt >= maxReconnectAttempts) {
      if (mutationRecovery === 'pending') {
        mutationRecovery = 'active';
        retryReconnect();
        return;
      }
      mutationRecovery = 'idle';
      if (exhaustionReason === null) {
        exhaustionReason = 'retry-limit';
        config.onReconnectExhaustionChange?.(true);
      }
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

  function connectInternal(attempt = 0, expectedGeneration = generation, skipAuthRefresh = false) {
    if (destroyed || intentionalDisconnect || paused || expectedGeneration !== generation) return;

    // A pre-connect refresh is in flight: its completion opens the socket with
    // the refreshed ticket. Connecting now would present the pre-refresh
    // ticket that the refresh is replacing.
    if (config.refreshAuth && !skipAuthRefresh && preconnectRefreshes > 0) return;

    if (
      config.refreshAuth &&
      (config.shouldRefreshAuthBeforeConnect?.() ?? false) &&
      !skipAuthRefresh
    ) {
      void refreshAndConnect(expectedGeneration, attempt);
      return;
    }

    reconnectAttempt = attempt;
    clearStalenessTimeout();
    // Anchor the staleness clock to this socket so visibility checks don't
    // inherit timing from a previous connection.
    lastMessageTime = Date.now();

    // Close existing socket - clear reference first so onclose ignores it.
    // Notify route loss because onOpen consumers may already have sent commands.
    if (ws !== null && !closeCurrentSocket(expectedGeneration)) return;

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
      // Ignore messages from replaced sockets: a late event from a socket we
      // already closed must not re-anchor the staleness clock, clear
      // exhaustion, or report the transport recovered.
      if (ws !== newWs) {
        return;
      }

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

      authRefreshAttempted = false;
      reconnectAttempt = 0;
      mutationRecovery = 'idle';
      clearExhausted();

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

      if (hidden) {
        config.onUnexpectedDisconnect?.();
        pauseWhileHidden();
        return;
      }

      const isAuthFailure = config.isAuthFailure?.(event) ?? false;

      if (isAuthFailure && !authRefreshAttempted && config.refreshAuth) {
        notifyReplacingConnection();
        if (!isConnectionReplacementAllowed(expectedGeneration)) return;
        void refreshAndConnect(expectedGeneration, 0, 'auth-close');
        return;
      }

      // Already tried refreshing auth and still failing - stop retrying.
      // The current physical route is gone even though no new socket follows.
      if (isAuthFailure && authRefreshAttempted) {
        mutationRecovery = 'idle';
        notifyReplacingConnection();
        if (exhaustionReason === null) {
          exhaustionReason = 'auth-failure';
          config.onReconnectExhaustionChange?.(true);
        }
        return;
      }

      config.onUnexpectedDisconnect?.();

      if (wasConnected || attempt === 0) {
        scheduleReconnect(0, expectedGeneration);
      } else {
        scheduleReconnect(reconnectAttempt, expectedGeneration);
      }
    };
  }

  // Notify route loss, report the disconnection, then re-auth and open a fresh
  // connection. Callers reset only the state that is specific to their
  // recovery path.
  function replaceSocketAndReconnect(expectedGeneration: number): void {
    if (destroyed || intentionalDisconnect || expectedGeneration !== generation) return;
    if (!closeCurrentSocket(expectedGeneration)) return;
    if (connected) {
      connected = false;
      config.onDisconnected();
    }
    void refreshAndConnect(expectedGeneration);
  }

  function handleVisibilityResume(): void {
    if (destroyed || intentionalDisconnect) return;
    clearHiddenPause();

    reconnectAttempt = 0;
    clearExhausted();
    const wasHiddenSince = hiddenAt;
    hiddenAt = 0;

    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      clearReconnectTimer();
      void refreshAndConnect(generation);
      return;
    }

    // If a message arrived recently, the connection is verified alive
    if (Date.now() - lastMessageTime < stalenessTimeoutMs) {
      return;
    }

    // If we were hidden for at least a full staleness window, JS may have been
    // suspended (e.g. mobile backgrounding) long enough for the OS to silently
    // drop the socket while readyState still reports OPEN. Waiting another full
    // timeout for a heartbeat that will never arrive on a zombie socket just
    // freezes the UI — reconnect immediately instead.
    if (wasHiddenSince !== 0 && Date.now() - wasHiddenSince >= stalenessTimeoutMs) {
      replaceSocketAndReconnect(generation);
      return;
    }

    // Socket appears open but no recent message — wait for the next server
    // heartbeat to confirm liveness; if nothing arrives, treat as stale.
    const currentGeneration = generation;
    stalenessTimeoutId = setTimeout(() => {
      stalenessTimeoutId = null;
      replaceSocketAndReconnect(currentGeneration);
    }, stalenessTimeoutMs);
  }

  function handleVisibilityHidden(): void {
    if (destroyed || intentionalDisconnect) return;
    hiddenAt = Date.now();
    clearStalenessTimeout();
    const pauseDelayMs = config.lifecycleHooks?.hiddenPauseDelayMs;
    if (pauseDelayMs === undefined || hidden) return;
    hidden = true;
    hiddenPauseTimeoutId = setTimeout(pauseWhileHidden, pauseDelayMs);
  }

  function handlePageshow(event: { persisted: boolean }): void {
    if (destroyed || intentionalDisconnect) return;

    if (!event.persisted) return;

    // BFCache restore - WebSocket is guaranteed dead
    reconnectAttempt = 0;
    clearExhausted();
    clearReconnectTimer();
    clearStalenessTimeout();
    replaceSocketAndReconnect(generation);
  }

  function handleOnline(): void {
    if (destroyed || intentionalDisconnect || hidden) return;

    if (connected && ws !== null && ws.readyState === WebSocket.OPEN) return;

    reconnectAttempt = 0;
    clearExhausted();
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
    preconnectRefreshes = 0;
    mutationRecovery = 'idle';
    connected = false;
    reconnectAttempt = 0;
    clearExhausted();
    hasConnectedOnce = false;
    lastMessageTime = 0;
    generation += 1;
    // A promise from the previous generation must never be joined by this one.
    inflightRefresh = null;
    clearReconnectTimer();
    clearStalenessTimeout();
    clearHiddenPause();
    addEventListeners();
    connectInternal(0, generation);
  }

  function disconnect() {
    intentionalDisconnect = true;
    generation += 1;
    preconnectRefreshes = 0;
    inflightRefresh = null;
    mutationRecovery = 'idle';

    clearReconnectTimer();
    clearStalenessTimeout();
    clearHiddenPause();
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

  function reconnectWithRefreshedAuth() {
    if (destroyed || intentionalDisconnect) return;

    reconnectAttempt = 0;
    clearExhausted();
    clearReconnectTimer();
    clearStalenessTimeout();
    replaceSocketAndReconnect(generation);
  }

  function retryReconnect() {
    if (destroyed || intentionalDisconnect) return;

    clearReconnectTimer();
    reconnectAttempt = 0;
    clearExhausted();
    // An explicit retry is the escape from a refresh that never settled. It
    // starts a fresh attempt instead of joining the one it is escaping.
    abandonInflightRefresh();
    void refreshAndConnect(generation);
  }

  function recoverAfterSuccessfulMutation() {
    if (
      destroyed ||
      intentionalDisconnect ||
      connected ||
      exhaustionReason === 'auth-failure' ||
      mutationRecovery !== 'idle'
    )
      return;
    if (exhaustionReason === 'retry-limit') {
      mutationRecovery = 'active';
      retryReconnect();
      return;
    }
    mutationRecovery = 'pending';
  }

  function destroy() {
    destroyed = true;
    generation += 1;
    preconnectRefreshes = 0;
    inflightRefresh = null;
    mutationRecovery = 'idle';

    clearReconnectTimer();
    clearStalenessTimeout();
    clearHiddenPause();
    removeEventListeners();

    if (ws !== null) {
      ws.close();
      ws = null;
    }

    // No callbacks on destroy - permanent teardown
    connected = false;
  }

  function socketPhase(): SocketPhase {
    if (ws === null) return 'absent';
    if (ws.readyState === WebSocket.OPEN) return 'open';
    if (ws.readyState === WebSocket.CONNECTING) return 'connecting';
    return 'absent';
  }

  return {
    connect,
    disconnect,
    reconnectWithRefreshedAuth,
    retryReconnect,
    recoverAfterSuccessfulMutation,
    destroy,
    socketPhase,
  };
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
