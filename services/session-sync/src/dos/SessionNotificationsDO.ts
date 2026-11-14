import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

import type { Env } from '../env';
import {
  LIVE_LIMITS,
  reconnectHint,
  sameTicket,
  send,
  socketProtocol,
  socketTicket,
} from '../live/protocol';
import { ticketSchema, verifyTicket, type LiveTicket } from '../live/ticket';
import { sessionNotificationSchema } from '../notifications/protocol';
import { userIDSchema } from '../protocol';

const attachmentSchema = z.object({
  ticket: ticketSchema.refine(
    ticket => ticket.aud === 'session-notifications' && ticket.role === 'viewer'
  ),
  rateAt: z.number(),
  rateCount: z.number().int(),
  closed: z.boolean(),
});
type Attachment = z.infer<typeof attachmentSchema>;
const frameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reauth'), ticket: z.string().min(1).max(8192) }),
  z.strictObject({ type: z.literal('ping') }),
]);
const publishSchema = z.strictObject({ userID: userIDSchema, event: sessionNotificationSchema });
const encoder = new TextEncoder();

function name(userID: string): string {
  return JSON.stringify(['notifications', userID]);
}

export class SessionNotificationsDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const token = socketTicket(request);
    const ticket = token ? await verifyTicket(token, this.env, 'session-notifications') : undefined;
    if (!ticket || ticket.role !== 'viewer' || !this.matches(ticket.userID)) {
      return new Response('Invalid notification ticket', { status: 401 });
    }
    const connections = this.connections();
    if (connections.length >= LIVE_LIMITS.viewers) {
      return Response.json(
        { error: { code: 'service_overloaded', message: 'Notification connection limit reached' } },
        { status: 503, headers: { 'retry-after': '60' } }
      );
    }
    const state = attachmentSchema.parse({
      ticket,
      rateAt: Date.now(),
      rateCount: 0,
      closed: false,
    });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(state);
    this.control(pair[1], 'hello', this.lifetime(ticket));
    await this.schedule();
    const protocol = socketProtocol(request);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: protocol ? { 'sec-websocket-protocol': protocol } : undefined,
    });
  }

  publish(input: unknown): { delivered: number } {
    const { userID, event } = publishSchema.parse(input);
    if (!this.matches(userID)) throw new Error('Notification user does not match');
    let delivered = 0;
    for (const [ws, state] of this.connections()) {
      const tenant = state.ticket.tenant;
      if (tenant.type !== event.session.tenant.type || tenant.id !== event.session.tenant.id)
        continue;
      if (send(ws, event)) delivered++;
      else this.close(ws, state, 1011, 'Notification delivery failed');
    }
    return { delivered };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = this.attachment(ws);
    if (!state || state.closed) return;
    const now = Date.now();
    if (state.ticket.exp * 1000 <= now) {
      this.close(ws, state, 4001, 'Ticket expired');
      await this.schedule();
      return;
    }
    if (
      (typeof message === 'string' ? encoder.encode(message).byteLength : message.byteLength) > 8192
    ) {
      this.close(ws, state, 1009, 'Message too large');
      await this.schedule();
      return;
    }
    if (now - state.rateAt >= 60_000) {
      state.rateAt = now;
      state.rateCount = 0;
    }
    state.rateCount++;
    ws.serializeAttachment(state);
    if (state.rateCount > LIVE_LIMITS.rates.viewer) {
      this.close(ws, state, 1008, 'Rate limit exceeded');
      await this.schedule();
      return;
    }
    let value: unknown;
    try {
      value = typeof message === 'string' ? JSON.parse(message) : undefined;
    } catch {
      value = undefined;
    }
    const frame = frameSchema.safeParse(value);
    if (!frame.success) {
      this.control(ws, 'error', { code: 'invalid_request' });
      return;
    }
    if (frame.data.type === 'ping') this.control(ws, 'pong', {});
    else {
      const ticket = await verifyTicket(frame.data.ticket, this.env, 'session-notifications');
      const current = this.attachment(ws);
      if (
        !ticket ||
        !sameTicket(state.ticket, ticket) ||
        !current ||
        current.closed ||
        current.ticket.exp * 1000 <= Date.now()
      ) {
        this.close(ws, current ?? state, 1008, 'Invalid reauthorization');
      } else {
        const renewed = attachmentSchema.parse({ ...current, ticket });
        ws.serializeAttachment(renewed);
        this.control(ws, 'reauthorized', this.lifetime(ticket));
      }
    }
    await this.schedule();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const state = this.attachment(ws);
    if (state) this.close(ws, state, 1000, 'Connection closed');
    await this.schedule();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const state = this.attachment(ws);
    if (state) this.close(ws, state, 1011, 'Transport unavailable');
    await this.schedule();
  }

  override async alarm(): Promise<void> {
    await this.schedule();
  }

  private matches(userID: string): boolean {
    return this.ctx.id.equals(this.env.SESSION_NOTIFICATIONS_DO.idFromName(name(userID)));
  }

  private attachment(ws: WebSocket): Attachment | undefined {
    let value: unknown;
    try {
      value = ws.deserializeAttachment();
    } catch {
      value = undefined;
    }
    const result = attachmentSchema.safeParse(value);
    if (result.success) return result.data;
    try {
      ws.close(1008, 'Invalid connection metadata');
    } catch {
      // The peer can close before this handler runs.
    }
    return undefined;
  }

  private connections(): Array<[WebSocket, Attachment]> {
    const active: Array<[WebSocket, Attachment]> = [];
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.attachment(ws);
      if (!state || state.closed) continue;
      if (state.ticket.exp * 1000 <= Date.now()) this.close(ws, state, 4001, 'Ticket expired');
      else active.push([ws, state]);
    }
    return active;
  }

  private close(ws: WebSocket, state: Attachment, code: number, reason: string): void {
    if (state.closed) return;
    ws.serializeAttachment({ ...state, closed: true });
    try {
      ws.close(code, reason);
    } catch {
      // The peer can close before this handler runs.
    }
  }

  private control(ws: WebSocket, type: string, body: unknown): void {
    send(ws, { version: 1, type, body });
  }

  private lifetime(ticket: LiveTicket) {
    return {
      expiresAt: new Date(ticket.exp * 1000).toISOString(),
      reauthAt: new Date(
        Math.max(Date.now(), ticket.exp * 1000 - LIVE_LIMITS.heartbeatMs)
      ).toISOString(),
      reconnectAfterMs: reconnectHint(),
      resetRequired: true,
    };
  }

  private async schedule(): Promise<void> {
    const connections = this.connections();
    if (connections.length === 0) await this.ctx.storage.deleteAlarm();
    else
      await this.ctx.storage.setAlarm(
        Math.min(...connections.map(([, state]) => state.ticket.exp * 1000))
      );
  }
}

export function getSessionNotificationsDOStub(
  env: Pick<Env, 'SESSION_NOTIFICATIONS_DO'>,
  userID: string
) {
  return env.SESSION_NOTIFICATIONS_DO.get(env.SESSION_NOTIFICATIONS_DO.idFromName(name(userID)));
}
