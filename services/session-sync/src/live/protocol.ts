import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';

import type { Env } from '../env';
import type { LiveTicket } from './ticket';

export const LIVE_LIMITS = {
  messageBytes: 65_536,
  ringBytes: 1_048_576,
  ringMs: 30_000,
  viewers: 100,
  mailboxDefaultMs: 15 * 60_000,
  mailboxMaxMs: 24 * 60 * 60_000,
  mailboxItems: 1000,
  mailboxBytes: 10 * 1_048_576,
  heartbeatMs: 30_000,
  staleMs: 90_000,
  rates: { runner: 6000, controller: 120, viewer: 120 },
} as const;

export type LiveEnvelope = {
  v: 1;
  channel: 'events' | 'commands' | 'control';
  seq: number;
  from: string;
  at: number;
  type: string;
  body: unknown;
};

/** Each connection gets its own delay; clients must not reconnect before it. */
export function reconnectHint(): number {
  return 1000 + Math.floor(Math.random() * 59_001);
}

const TICKET_PROTOCOL = 'kilo-session-ticket.';

/** Browser/RN authentication uses a subprotocol, never a Logpush-visible URL. */
export function socketProtocol(request: Request): string | undefined {
  const header = request.headers.get('sec-websocket-protocol');
  if (!header || header.length > 8192) return undefined;
  const protocols = header
    .split(',')
    .map(value => value.trim())
    .filter(value => value.startsWith(TICKET_PROTOCOL));
  if (protocols.length !== 1) return undefined;
  const selected = protocols[0];
  return selected && /^[A-Za-z0-9_.-]+$/.test(selected) ? selected : undefined;
}

export function socketTicket(request: Request): string | undefined {
  if (new URL(request.url).searchParams.has('ticket')) return undefined;
  const authorization = request.headers.get('authorization');
  if (authorization !== null) return extractBearerToken(authorization) ?? undefined;
  return socketProtocol(request)?.slice(TICKET_PROTOCOL.length);
}

/** Reauthorization can extend expiry, never change the socket's identity or capability. */
export function sameTicket(a: LiveTicket, b: LiveTicket): boolean {
  return (
    a.aud === b.aud &&
    a.env === b.env &&
    a.tenant.type === b.tenant.type &&
    a.tenant.id === b.tenant.id &&
    a.sessionID === b.sessionID &&
    a.userID === b.userID &&
    a.role === b.role
  );
}

export function send(ws: WebSocket, value: unknown): boolean {
  try {
    ws.send(JSON.stringify(value));
    return true;
  } catch {
    try {
      ws.close(1011, 'Transport unavailable');
    } catch {
      // A peer that already disconnected needs no further cleanup here.
    }
    return false;
  }
}

export function liveMetric(
  env: Pick<Env, 'SESSION_SYNC_METRICS'>,
  point: {
    route: string;
    role: string;
    reason?: string;
    bytes?: number;
    fanout?: number;
    latencyMs?: number;
  }
): void {
  try {
    env.SESSION_SYNC_METRICS?.writeDataPoint({
      indexes: [point.route],
      blobs: [point.route, point.role, point.reason ?? ''],
      doubles: [point.bytes ?? 0, point.fanout ?? 0, point.latencyMs ?? 0],
    });
  } catch {
    console.error('Session sync live metrics failed');
  }
}
