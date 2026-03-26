import {
  isValidCloudAgentEvent,
  isStreamError,
  type CloudAgentEvent,
  type StreamError,
} from '@/lib/cloud-agent-next/event-types';
import { createBaseConnection, type Connection } from './base-connection';

export type ConnectionConfig = {
  websocketUrl: string;
  ticket: string;
  onEvent: (event: CloudAgentEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onUnexpectedDisconnect?: () => void;
  onError?: (error: StreamError) => void;
  onRefreshTicket?: () => Promise<string>;
  heartbeatTimeoutMs?: number;
  reconnectDelayMs?: number;
};

export type { Connection };

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

const AUTH_FAILURE_CLOSE_CODES = [1008, 4001] as const;
const AUTH_FAILURE_KEYWORDS = ['unauthorized', '401', 'auth', 'ticket'] as const;

function isAuthFailureClose(event: CloseEvent): boolean {
  if (AUTH_FAILURE_CLOSE_CODES.includes(event.code as (typeof AUTH_FAILURE_CLOSE_CODES)[number])) {
    return true;
  }
  const reason = event.reason?.toLowerCase() ?? '';
  return AUTH_FAILURE_KEYWORDS.some(keyword => reason.includes(keyword));
}

export function createConnection(config: ConnectionConfig): Connection {
  let currentTicket = config.ticket;
  const refreshTicket = config.onRefreshTicket;

  return createBaseConnection({
    buildUrl: () => {
      const url = new URL(config.websocketUrl);
      url.searchParams.set('ticket', currentTicket);
      return url.toString();
    },
    parseMessage: (data: unknown) => {
      const parsed = parseMessage(data);
      if (!parsed) return null;
      if (parsed.type === 'error') return { type: 'error', message: parsed.error.message };
      return { type: 'event', payload: parsed.event };
    },
    onEvent: payload => config.onEvent(payload as CloudAgentEvent),
    onConnected: config.onConnected,
    onDisconnected: config.onDisconnected,
    onUnexpectedDisconnect: config.onUnexpectedDisconnect,
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
          currentTicket = await refreshTicket();
        }
      : undefined,
  });
}
