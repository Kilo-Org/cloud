import {
  type CloudAgentEvent,
  type Connection,
  createConnection,
  type StreamError,
} from '@kilocode/cloud-agent-sdk';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { API_BASE_URL, CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';

export type { Connection };

type StreamTicket = { ticket: string; expiresAt: number };

/** Decode an untrusted wire value into a record, or undefined. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the stream-ticket body is untrusted; typeof is the entry-boundary decode
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Decode an untrusted wire value into a string, or undefined. */
function asString(value: unknown): string | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the stream-ticket body is untrusted; typeof is the entry-boundary decode
  return typeof value === 'string' ? value : undefined;
}

/** Decode an untrusted wire value into a number, or undefined. */
function asNumber(value: unknown): number | undefined {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- the stream-ticket body is untrusted; typeof is the entry-boundary decode
  return typeof value === 'number' ? value : undefined;
}

function parseTicket(data: unknown): StreamTicket {
  const record = asRecord(data);
  const ticket = asString(record?.ticket);
  const expiresAt = asNumber(record?.expiresAt);
  if (ticket === undefined) {
    throw new Error('Missing ticket in stream-ticket response');
  }
  if (expiresAt === undefined) {
    throw new Error('Missing expiresAt in stream-ticket response');
  }
  return { ticket, expiresAt };
}

/**
 * POST the cloud-agent stream ticket. Mirrors the `getTicket` closure in
 * `mobile-session-manager.ts` (same route, headers, and response contract)
 * without importing that module.
 */
async function postReviewSpectatorStreamTicket(
  cloudAgentSessionId: string,
  organizationId?: string
): Promise<StreamTicket> {
  const token = await getAuthTokenForRequest();
  const body = {
    cloudAgentSessionId,
    ...(organizationId ? { organizationId } : {}),
  };
  const response = await fetch(`${API_BASE_URL}/api/cloud-agent-next/sessions/stream-ticket`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    throw new Error(asString(asRecord(data)?.error) ?? 'Failed to get stream ticket');
  }
  return parseTicket(data);
}

/** Build the raw `/stream` websocket URL. `createConnection` appends `ticket`. */
function buildSpectatorStreamUrl(cloudAgentSessionId: string): URL {
  const url = new URL('/stream', CLOUD_AGENT_WS_URL);
  url.searchParams.set('cloudAgentSessionId', cloudAgentSessionId);
  return url;
}

/**
 * Open a raw cloud-agent stream that only watches a review; it never sends a
 * prompt or command. `createConnection` owns reconnect and teardown.
 */
export async function createReviewSpectatorStream(input: {
  cloudAgentSessionId: string;
  organizationId?: string;
  onEvent: (event: CloudAgentEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: StreamError) => void;
}): Promise<Connection> {
  const organizationId =
    input.organizationId && input.organizationId.length > 0 ? input.organizationId : undefined;
  const ticketResult = await postReviewSpectatorStreamTicket(
    input.cloudAgentSessionId,
    organizationId
  );

  return createConnection({
    websocketUrl: buildSpectatorStreamUrl(input.cloudAgentSessionId).toString(),
    ticket: ticketResult,
    onEvent: input.onEvent,
    onConnected: input.onConnected,
    onDisconnected: input.onDisconnected,
    onError: input.onError,
    websocketHeaders: { Origin: WEB_BASE_URL },
    onRefreshTicket: async () => {
      const ticket = await postReviewSpectatorStreamTicket(
        input.cloudAgentSessionId,
        organizationId
      );
      return ticket;
    },
  });
}
