import {
  isValidCloudAgentEvent,
  isStreamError,
  type CloudAgentEvent,
  type StreamError,
} from './schemas';
import {
  createBaseConnection,
  type Connection,
  type ConnectionLifecycleHooks,
  type WebSocketHeaders,
} from './base-connection';
import type { CloudAgentStreamTicket, CloudAgentStreamTicketResult } from './transport';

export type ConnectionConfig = {
  /** Static URL, or a builder re-evaluated on every (re)connect attempt so
   * the caller can vary query params (e.g. a replay cursor). */
  websocketUrl: string | (() => string);
  ticket: CloudAgentStreamTicketResult;
  onEvent: (event: CloudAgentEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onUnexpectedDisconnect?: (() => void) | undefined;
  onReconnected?: (() => void) | undefined;
  onReconnectExhaustionChange?: ((exhausted: boolean) => void) | undefined;
  onError?: ((error: StreamError) => void) | undefined;
  onRefreshTicket?: (() => Promise<CloudAgentStreamTicketResult>) | undefined;
  heartbeatTimeoutMs?: number | undefined;
  lifecycleHooks?: ConnectionLifecycleHooks | undefined;
  websocketHeaders?: WebSocketHeaders | undefined;
};

export type { Connection };

type ParsedMessage =
  | { type: 'event'; event: CloudAgentEvent }
  | { type: 'error'; error: StreamError };

const TICKET_EXPIRY_SKEW_SECONDS = 10;

function normalizeTicket(ticket: CloudAgentStreamTicketResult): CloudAgentStreamTicket {
  return typeof ticket === 'string' ? { ticket, expiresAt: undefined } : ticket;
}

function isTicketExpiringSoon(expiresAt?: number): boolean {
  if (!expiresAt) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  return expiresAt - nowSeconds <= TICKET_EXPIRY_SKEW_SECONDS;
}

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

const AUTH_FAILURE_CLOSE_CODES = [1008, 4001] as const;
// A bad ticket is rejected with HTTP 401/403 before the upgrade, so the browser
// reports 1006: free-text reasons only count as auth when they name an explicit
// rejection. A bare mention of auth or a ticket describes a transient fault.
const AUTH_FAILURE_REASON = /\b(?:unauthorized|401)\b/;

function isAuthFailureClose(event: CloseEvent): boolean {
  if (AUTH_FAILURE_CLOSE_CODES.some(authFailureCode => authFailureCode === event.code)) {
    return true;
  }
  return AUTH_FAILURE_REASON.test(event.reason?.toLowerCase() ?? '');
}

export function createConnection(config: ConnectionConfig): Connection {
  let currentTicket = normalizeTicket(config.ticket);
  let ticketPresented = false;
  const refreshTicket = config.onRefreshTicket;

  return createBaseConnection({
    stalenessTimeoutMs: config.heartbeatTimeoutMs,
    lifecycleHooks: config.lifecycleHooks,
    websocketHeaders: config.websocketHeaders,
    buildUrl: () => {
      const url = new URL(
        typeof config.websocketUrl === 'function' ? config.websocketUrl() : config.websocketUrl
      );
      url.searchParams.set('ticket', currentTicket.ticket);
      ticketPresented = true;
      return url.toString();
    },
    parseMessage: (data: unknown) => {
      const parsed = parseMessage(data);
      if (!parsed) return null;
      if (parsed.type === 'error') return { type: 'error', message: parsed.error.message };
      return { type: 'event', payload: parsed.event };
    },
    onEvent: payload => config.onEvent(payload),
    onConnected: config.onConnected,
    onDisconnected: config.onDisconnected,
    onUnexpectedDisconnect: config.onUnexpectedDisconnect,
    onReconnected: config.onReconnected,
    onReconnectExhaustionChange: config.onReconnectExhaustionChange,
    onError: config.onError
      ? message =>
          config.onError?.({
            type: 'error',
            code: 'WS_INTERNAL_ERROR',
            message,
          } satisfies StreamError)
      : undefined,
    isAuthFailure: isAuthFailureClose,
    refreshAuth: refreshTicket
      ? async () => {
          currentTicket = normalizeTicket(await refreshTicket());
        }
      : undefined,
    shouldRefreshAuthBeforeConnect: () =>
      ticketPresented || isTicketExpiringSoon(currentTicket.expiresAt),
  });
}
