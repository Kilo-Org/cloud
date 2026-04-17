import {
  isValidCloudAgentEvent,
  isStreamError,
  type CloudAgentEvent,
  type StreamError,
} from '@/lib/cloud-agent-next/event-types';
import { createBaseConnection, type Connection } from './base-connection';
import type { CloudAgentStreamTicket, CloudAgentStreamTicketResult } from './transport';

export type ConnectionConfig = {
  websocketUrl: string;
  ticket: CloudAgentStreamTicketResult;
  onEvent: (event: CloudAgentEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onUnexpectedDisconnect?: () => void;
  onReconnected?: () => void;
  onError?: (error: StreamError) => void;
  onRefreshTicket?: () => Promise<CloudAgentStreamTicketResult>;
  heartbeatTimeoutMs?: number;
  reconnectDelayMs?: number;
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
const AUTH_FAILURE_KEYWORDS = ['unauthorized', '401', 'auth', 'ticket'] as const;

function isAuthFailureCode(code: number): boolean {
  return AUTH_FAILURE_CLOSE_CODES.some(authFailureCode => authFailureCode === code);
}

function isAuthFailureClose(event: CloseEvent): boolean {
  if (isAuthFailureCode(event.code)) {
    return true;
  }
  const reason = event.reason?.toLowerCase() ?? '';
  return AUTH_FAILURE_KEYWORDS.some(keyword => reason.includes(keyword));
}

export function createConnection(config: ConnectionConfig): Connection {
  let currentTicket = normalizeTicket(config.ticket);
  const refreshTicket = config.onRefreshTicket;

  return createBaseConnection({
    stalenessTimeoutMs: config.heartbeatTimeoutMs,
    buildUrl: () => {
      const url = new URL(config.websocketUrl);
      url.searchParams.set('ticket', currentTicket.ticket);
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
    shouldRefreshAuthBeforeConnect: () => isTicketExpiringSoon(currentTicket.expiresAt),
  });
}
