import {
  isValidCloudAgentEvent,
  isStreamError,
  type CloudAgentEvent,
  type StreamError,
} from './event-types';

export type ConnectionState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; executionId: string }
  | { status: 'reconnecting'; lastEventId: number; attempt: number }
  | { status: 'refreshing_ticket' }
  | { status: 'error'; error: string; retryable: boolean };

export type WebSocketManagerConfig = {
  url: string;
  ticket: string;
  onEvent: (event: CloudAgentEvent) => void;
  onStateChange: (state: ConnectionState) => void;
  onError?: (error: StreamError) => void;
  /** Optional callback to refresh the ticket on 401. Returns new ticket or throws. */
  onRefreshTicket?: () => Promise<string>;
};

type ParsedMessage =
  | { type: 'event'; event: CloudAgentEvent }
  | { type: 'error'; error: StreamError };

function parseMessage(data: unknown): ParsedMessage | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(data);
    if (isValidCloudAgentEvent(parsed)) {
      return { type: 'event', event: parsed };
    }
    if (isStreamError(parsed)) {
      return { type: 'error', error: parsed };
    }
    return null;
  } catch {
    return null;
  }
}

// Reconnection configuration with exponential backoff and jitter
const MAX_RECONNECT_ATTEMPTS = 8;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;

/**
 * Calculate reconnect delay with exponential backoff and jitter.
 * Formula: min(cap, base * 2^attempt) * (0.5 + random)
 * This gives roughly: 1s, 2s, 4s, 8s, 16s, 30s, 30s... with 50-150% jitter
 */
function calculateBackoffDelay(attempt: number): number {
  const exponentialDelay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
  const jitter = 0.5 + Math.random(); // 0.5 to 1.5
  return Math.floor(exponentialDelay * jitter);
}

// WebSocket close codes that indicate auth failures
const AUTH_FAILURE_CLOSE_CODES = [1008, 4001, 1006] as const;
// Keywords in close reason that indicate auth failures
const AUTH_FAILURE_KEYWORDS = ['unauthorized', '401', 'auth', 'ticket'] as const;

/**
 * Detect if a WebSocket close event indicates an authentication failure.
 * Auth failures can be signaled via:
 * - Close code 1008 (Policy Violation) - often used for auth failures
 * - Close code 4001 (custom) - explicit auth failure code
 * - Close code 1006 (Abnormal Closure) - can indicate HTTP error before upgrade
 * - Close reason containing auth-related keywords
 */
function isAuthFailureClose(event: CloseEvent): boolean {
  if (AUTH_FAILURE_CLOSE_CODES.includes(event.code as (typeof AUTH_FAILURE_CLOSE_CODES)[number])) {
    return true;
  }
  const reason = event.reason?.toLowerCase() ?? '';
  return AUTH_FAILURE_KEYWORDS.some(keyword => reason.includes(keyword));
}

export function createWebSocketManager(config: WebSocketManagerConfig): {
  connect: () => void;
  disconnect: () => void;
  getState: () => ConnectionState;
} {
  let state: ConnectionState = { status: 'disconnected' };
  let ws: WebSocket | null = null;
  let lastEventId = 0;
  let reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let intentionalDisconnect = false;
  let currentTicket = config.ticket;
  let ticketRefreshAttempted = false;

  function setState(newState: ConnectionState) {
    state = newState;
    config.onStateChange(state);
  }

  function buildUrl(fromId?: number): string {
    const url = new URL(config.url);
    url.searchParams.set('ticket', currentTicket);
    if (fromId !== undefined && fromId > 0) {
      url.searchParams.set('fromId', String(fromId));
    }
    return url.toString();
  }

  async function refreshTicketAndReconnect() {
    console.log('[WebSocketManager] refreshTicketAndReconnect called', {
      hasRefreshHandler: !!config.onRefreshTicket,
    });

    if (!config.onRefreshTicket) {
      console.log('[WebSocketManager] No refresh handler configured');
      setState({
        status: 'error',
        error: 'Authentication failed and no ticket refresh handler configured',
        retryable: false,
      });
      return;
    }

    setState({ status: 'refreshing_ticket' });

    try {
      console.log('[WebSocketManager] Calling onRefreshTicket...');
      const newTicket = await config.onRefreshTicket();
      console.log('[WebSocketManager] Got new ticket, reconnecting...');
      currentTicket = newTicket;
      ticketRefreshAttempted = true;
      // Reset reconnect attempts after successful ticket refresh
      connectInternal(0);
    } catch (err) {
      console.error('[WebSocketManager] Failed to refresh ticket:', err);
      setState({
        status: 'error',
        error: 'Failed to refresh authentication ticket',
        retryable: false,
      });
    }
  }

  function scheduleReconnect(attempt: number) {
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setState({
        status: 'error',
        error: 'Max reconnection attempts exceeded',
        retryable: false,
      });
      return;
    }

    const delay = calculateBackoffDelay(attempt);
    setState({
      status: 'reconnecting',
      lastEventId,
      attempt: attempt + 1,
    });

    reconnectTimeoutId = setTimeout(() => {
      reconnectTimeoutId = null;
      connectInternal(attempt + 1);
    }, delay);
  }

  function connectInternal(_attempt = 0) {
    // Close existing socket if any - store reference so onclose handler can ignore it
    const oldWs = ws;
    if (oldWs !== null) {
      ws = null; // Clear reference BEFORE closing so onclose handler knows it's being replaced
      oldWs.close();
    }

    // Always include lastEventId if we have one - this enables replay after any reconnection
    // (whether from network issues, ticket refresh, or other disconnects)
    const urlWithReplay = lastEventId ? buildUrl(lastEventId) : buildUrl();
    setState({ status: 'connecting' });

    const newWs = new WebSocket(urlWithReplay);
    ws = newWs;

    newWs.onmessage = (messageEvent: MessageEvent) => {
      const parsed = parseMessage(messageEvent.data);
      if (parsed === null) {
        return;
      }

      if (parsed.type === 'error') {
        config.onError?.(parsed.error);
        return;
      }

      const event = parsed.event;
      lastEventId = event.eventId;

      // Reset ticket refresh flag on successful message
      ticketRefreshAttempted = false;

      if (state.status !== 'connected') {
        setState({ status: 'connected', executionId: event.executionId });
      }

      config.onEvent(event);
    };

    newWs.onerror = (errorEvent: Event) => {
      // WebSocket errors during HTTP upgrade (like 401) may not give us useful close codes
      // Log the error for debugging
      console.log('[WebSocketManager] WebSocket error', {
        type: errorEvent.type,
        ticketRefreshAttempted,
        currentState: state.status,
      });
      // The actual handling happens in onclose which fires after onerror
    };

    newWs.onclose = (event: CloseEvent) => {
      // Ignore close events from replaced sockets - a new socket has already been created
      if (ws !== newWs) {
        console.log('[WebSocketManager] Ignoring close from replaced socket');
        return;
      }
      ws = null;

      console.log('[WebSocketManager] WebSocket closed', {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
        intentionalDisconnect,
        ticketRefreshAttempted,
        currentState: state.status,
      });

      if (intentionalDisconnect) {
        setState({ status: 'disconnected' });
        return;
      }

      const isAuthFailure = isAuthFailureClose(event);

      console.log('[WebSocketManager] Auth failure check', {
        isAuthFailure,
        ticketRefreshAttempted,
        hasRefreshHandler: !!config.onRefreshTicket,
        willRefresh: isAuthFailure && !ticketRefreshAttempted && !!config.onRefreshTicket,
      });

      if (isAuthFailure && !ticketRefreshAttempted && config.onRefreshTicket) {
        console.log('[WebSocketManager] Auth failure detected, attempting ticket refresh');
        void refreshTicketAndReconnect();
        return;
      }

      // If we already tried refreshing the ticket and still getting auth failures,
      // don't keep retrying - the issue is likely not the ticket
      if (isAuthFailure && ticketRefreshAttempted) {
        console.log(
          '[WebSocketManager] Auth failure after ticket refresh - stopping retries (likely origin/config issue)'
        );
        setState({
          status: 'error',
          error: 'Authentication failed after ticket refresh. Check server configuration.',
          retryable: false,
        });
        return;
      }

      if (state.status === 'connecting' || state.status === 'connected') {
        scheduleReconnect(0);
      } else if (state.status === 'reconnecting') {
        scheduleReconnect(state.attempt);
      }
    };
  }

  function connect() {
    console.log('[WebSocketManager] connect() called - resetting state');
    intentionalDisconnect = false;
    lastEventId = 0;
    ticketRefreshAttempted = false;
    connectInternal(0);
  }

  function disconnect() {
    intentionalDisconnect = true;

    if (reconnectTimeoutId !== null) {
      clearTimeout(reconnectTimeoutId);
      reconnectTimeoutId = null;
    }

    if (ws !== null) {
      ws.close();
      ws = null;
    }

    setState({ status: 'disconnected' });
  }

  function getState(): ConnectionState {
    return state;
  }

  return { connect, disconnect, getState };
}
