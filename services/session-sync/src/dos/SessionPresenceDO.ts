import { DurableObject } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';

import migrations from '../../drizzle-presence/migrations';
import { presenceAdvertisements } from '../db/presence-sqlite-schema';
import type { Env } from '../env';
import {
  LIVE_LIMITS,
  liveMetric,
  reconnectHint,
  sameTicket,
  send,
  socketTicket,
  socketProtocol,
} from '../live/protocol';
import { verifyTicket } from '../live/ticket';
import { sessionIDSchema, tenantSchema, userIDSchema, type Tenant } from '../protocol';

const WATCH_LEASE_MS = 5 * 60_000;
const WATCH_LIMIT = 128;
const INSTANCE_LIMIT = 32;
const PROVISIONAL_RUNNER_LIMIT = 8;
const ATTACHMENT_BYTES = 1_536;
const ADVERTISEMENT_BYTES = 8_192;
const encoder = new TextEncoder();
const text = z.string().max(256);

const advertisementSchema = z.strictObject({
  name: text,
  projectName: text,
  version: z.string().max(64),
  kind: z.enum(['cli', 'remote']),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  gitBranch: text.nullable(),
  capabilities: z.array(z.string().min(1).max(64)).max(32),
  sessions: z.array(sessionIDSchema).max(100),
});
export type InstanceAdvertisement = z.infer<typeof advertisementSchema>;
export type Instance = {
  instanceID: string;
  tenant: Tenant;
  advertisement: InstanceAdvertisement;
  online: boolean;
  lastHeartbeatAt: number;
};

const ticketSchema = z.strictObject({
  version: z.literal(1),
  aud: z.literal('session-presence'),
  env: z.string(),
  tenant: tenantSchema,
  userID: userIDSchema,
  role: z.enum(['runner', 'viewer']),
  exp: z.number().int(),
  iat: z.number().int(),
});
const attachmentSchema = z.strictObject({
  connectionID: z.uuid(),
  ticket: ticketSchema,
  subscribed: z.boolean(),
  lastHeartbeatAt: z.number(),
  instanceID: z.string().min(1).max(128).optional(),
  rateAt: z.number(),
  rateCount: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative(),
  closed: z.boolean(),
});
type Attachment = z.infer<typeof attachmentSchema>;
const watchSchema = z.strictObject({
  tenant: tenantSchema,
  sessionID: sessionIDSchema,
  expiresAt: z.number().int(),
});
type Watch = z.infer<typeof watchSchema>;
const watchInputSchema = watchSchema.omit({ expiresAt: true }).extend({ watching: z.boolean() });
const frameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reauth'), ticket: z.string().min(1).max(8_192) }),
  z.strictObject({ type: z.literal('subscribe') }),
  z.strictObject({
    type: z.literal('heartbeat'),
    instanceID: z.string().min(1).max(128),
    advertisement: advertisementSchema,
  }),
]);

function sameTenant(a: Tenant, b: Tenant): boolean {
  return a.type === b.type && a.id === b.id;
}

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function presenceName(userID: string): string {
  return JSON.stringify(['presence', userID]);
}

/** One user's process advertisements; heartbeat state lives only in hibernation attachments. */
export class SessionPresenceDO extends DurableObject<Env> {
  private watches: Watch[] = [];
  private alarmAt: number | null = null;
  private db;
  private attachments = new Map<WebSocket, Attachment>();
  private advertisements = new Map<string, { value: InstanceAdvertisement; encoded: string }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(async () => {
      await migrate(this.db, migrations);
      const active = new Set<string>();
      for (const ws of ctx.getWebSockets()) {
        const saved = attachmentSchema.safeParse(ws.deserializeAttachment());
        if (saved.success && !saved.data.closed) {
          active.add(saved.data.connectionID);
          this.attachments.set(ws, saved.data);
        }
      }
      for (const row of this.db.select().from(presenceAdvertisements).all()) {
        let value: unknown;
        try {
          value = JSON.parse(row.advertisement);
        } catch {
          value = undefined;
        }
        const advertisement = advertisementSchema.safeParse(value);
        if (active.has(row.connection_id) && advertisement.success) {
          this.advertisements.set(row.connection_id, {
            value: advertisement.data,
            encoded: row.advertisement,
          });
        } else {
          this.db
            .delete(presenceAdvertisements)
            .where(eq(presenceAdvertisements.connection_id, row.connection_id))
            .run();
        }
      }
      const saved = await ctx.storage.get<unknown>('watches');
      if (saved !== undefined) this.watches = z.array(watchSchema).max(WATCH_LIMIT).parse(saved);
      this.alarmAt = await ctx.storage.getAlarm();
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const token = socketTicket(request);
    const ticket = token ? await verifyTicket(token, this.env, 'session-presence') : undefined;
    if (
      !ticket ||
      ticket.role === 'controller' ||
      ticket.sessionID !== undefined ||
      !this.ctx.id.equals(this.env.SESSION_PRESENCE_DO.idFromName(presenceName(ticket.userID)))
    ) {
      return new Response('Invalid presence ticket', { status: 401 });
    }
    await this.sweep();
    const connections = this.connections();
    const limit = ticket.role === 'runner' ? PROVISIONAL_RUNNER_LIMIT : LIVE_LIMITS.viewers;
    const competing = connections.filter(
      ([, state]) =>
        state.ticket.role === ticket.role &&
        (ticket.role !== 'runner' || state.instanceID === undefined)
    );
    if (competing.length >= limit) {
      return Response.json(
        { error: { code: 'service_overloaded', message: 'Presence connection limit reached' } },
        { status: 503, headers: { 'retry-after': String(Math.ceil(reconnectHint() / 1000)) } }
      );
    }
    const parsed = ticketSchema.safeParse(ticket);
    if (!parsed.success) return new Response('Invalid presence ticket', { status: 401 });
    const now = Date.now();
    const state: Attachment = {
      connectionID: crypto.randomUUID(),
      ticket: parsed.data,
      subscribed: false,
      lastHeartbeatAt: now,
      rateAt: now,
      rateCount: 0,
      seq: 0,
      closed: false,
    };
    if (byteLength(state) > ATTACHMENT_BYTES) {
      return Response.json(
        { error: { code: 'service_overloaded', message: 'Presence attachment budget exceeded' } },
        { status: 503, headers: { 'retry-after': '60' } }
      );
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.saveAttachment(pair[1], state);
    this.emit(pair[1], state, 'hello', {
      heartbeatMs: LIVE_LIMITS.heartbeatMs,
      reconnectAfterMs: reconnectHint(),
      expiresAt: new Date(ticket.exp * 1000).toISOString(),
      reauthAt: new Date(Math.max(now, ticket.exp * 1000 - LIVE_LIMITS.heartbeatMs)).toISOString(),
    });
    await this.schedule();
    liveMetric(this.env, { route: 'presence_connect', role: ticket.role });
    const protocol = socketProtocol(request);
    return new Response(null, {
      status: 101,
      webSocket: pair[0],
      headers: protocol ? { 'sec-websocket-protocol': protocol } : undefined,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    let state = this.attachment(ws);
    if (!state || state.closed) return;
    const now = Date.now();
    if (state.ticket.exp * 1000 <= now) {
      this.close(ws, state, 4001, 'Ticket expired');
      this.broadcast();
      return;
    }
    if (state.ticket.role === 'runner' && state.lastHeartbeatAt + LIVE_LIMITS.staleMs <= now) {
      this.close(ws, state, 4000, 'Heartbeat stale');
      this.broadcast();
      return;
    }
    const bytes =
      typeof message === 'string' ? encoder.encode(message).byteLength : message.byteLength;
    if (bytes > LIVE_LIMITS.messageBytes) {
      this.close(ws, state, 1009, 'Message too large');
      this.broadcast();
      return;
    }
    if (now - state.rateAt >= 60_000) {
      state.rateAt = now;
      state.rateCount = 0;
    }
    state.rateCount++;
    this.saveAttachment(ws, state);
    if (state.rateCount > LIVE_LIMITS.rates[state.ticket.role]) {
      this.close(ws, state, 1008, 'Rate limit exceeded');
      this.broadcast();
      return;
    }
    let value: unknown;
    try {
      value = typeof message === 'string' ? JSON.parse(message) : undefined;
    } catch {
      value = undefined;
    }
    const parsed = frameSchema.safeParse(value);
    if (!parsed.success) {
      this.emit(ws, state, 'error', { code: 'invalid_request', message: 'Invalid presence frame' });
      return;
    }
    const frame = parsed.data;
    if (frame.type === 'reauth') {
      const ticket = await verifyTicket(frame.ticket, this.env, 'session-presence');
      state = this.attachment(ws);
      if (!state || state.closed) return;
      if (
        !ticket ||
        !sameTicket(state.ticket, ticket) ||
        ticket.exp * 1000 <= Date.now() ||
        state.ticket.exp * 1000 <= Date.now()
      ) {
        this.close(ws, state, 4001, 'Invalid reauthorization');
        this.broadcast();
        return;
      }
      const fresh = ticketSchema.safeParse(ticket);
      if (!fresh.success) {
        this.close(ws, state, 4001, 'Invalid reauthorization');
        this.broadcast();
        return;
      }
      state.ticket = fresh.data;
      this.emit(ws, state, 'reauthorized', {
        expiresAt: new Date(ticket.exp * 1000).toISOString(),
        reauthAt: new Date(
          Math.max(Date.now(), ticket.exp * 1000 - LIVE_LIMITS.heartbeatMs)
        ).toISOString(),
      });
      await this.schedule();
    } else if (frame.type === 'subscribe' && state.ticket.role === 'viewer') {
      state.subscribed = true;
      this.emit(ws, state, 'instances', { instances: this.instances(state.ticket.tenant) });
    } else if (frame.type === 'heartbeat' && state.ticket.role === 'runner') {
      if (state.instanceID !== undefined && state.instanceID !== frame.instanceID) {
        this.emit(ws, state, 'error', {
          code: 'invalid_request',
          message: 'Instance identity cannot change',
        });
        return;
      }
      const tenant = state.ticket.tenant;
      const connections = this.connections();
      const replaced = connections.filter(
        ([other, attachment]) =>
          other !== ws &&
          attachment.instanceID === frame.instanceID &&
          sameTenant(attachment.ticket.tenant, tenant)
      );
      if (
        state.instanceID === undefined &&
        replaced.length === 0 &&
        connections.filter(
          ([, saved]) => saved.ticket.role === 'runner' && saved.instanceID !== undefined
        ).length >= INSTANCE_LIMIT
      ) {
        this.close(ws, state, 1013, 'Presence instance limit reached');
        return;
      }
      const next: Attachment = {
        ...state,
        instanceID: frame.instanceID,
        lastHeartbeatAt: now,
      };
      const candidate = this.instances(state.ticket.tenant).filter(
        instance => instance.instanceID !== frame.instanceID
      );
      candidate.push({
        instanceID: frame.instanceID,
        tenant: state.ticket.tenant,
        advertisement: frame.advertisement,
        online: true,
        lastHeartbeatAt: now,
      });
      if (
        byteLength(next) > ATTACHMENT_BYTES ||
        byteLength(frame.advertisement) > ADVERTISEMENT_BYTES ||
        byteLength({ instances: candidate }) > LIVE_LIMITS.messageBytes - 512
      ) {
        this.emit(ws, state, 'error', {
          code: 'invalid_request',
          message: 'Presence advertisement budget exceeded',
        });
        return;
      }
      const encoded = JSON.stringify(frame.advertisement);
      if (this.advertisements.get(next.connectionID)?.encoded !== encoded) {
        this.db
          .insert(presenceAdvertisements)
          .values({
            connection_id: next.connectionID,
            advertisement: encoded,
          })
          .onConflictDoUpdate({
            target: presenceAdvertisements.connection_id,
            set: { advertisement: encoded },
          })
          .run();
        this.advertisements.set(next.connectionID, { value: frame.advertisement, encoded });
      }
      for (const [oldSocket, oldState] of replaced) {
        this.close(oldSocket, oldState, 4009, 'Instance reconnected');
      }
      this.saveAttachment(ws, next);
      this.emit(ws, next, 'heartbeat_ack', { lastHeartbeatAt: now });
      for (const watch of this.watches) {
        if (
          watch.expiresAt > now &&
          sameTenant(watch.tenant, next.ticket.tenant) &&
          frame.advertisement.sessions.includes(watch.sessionID)
        ) {
          this.emit(ws, next, 'watch', {
            tenant: watch.tenant,
            sessionID: watch.sessionID,
            watching: true,
          });
        }
      }
      this.broadcast();
      await this.schedule();
    } else {
      this.emit(ws, state, 'error', {
        code: 'forbidden',
        message: 'Frame not allowed for this role',
      });
    }
    liveMetric(this.env, {
      route: 'presence_message',
      role: state.ticket.role,
      bytes,
      latencyMs: Date.now() - now,
    });
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = this.attachment(ws);
    if (state && !state.closed) this.close(ws, state, code, reason);
    this.broadcast();
    await this.schedule();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const state = this.attachment(ws);
    if (state) this.close(ws, state, 1011, 'Transport unavailable');
    this.broadcast();
    await this.schedule();
  }

  async watch(input: { tenant: Tenant; sessionID: string; watching: boolean }): Promise<void> {
    const { tenant, sessionID, watching } = watchInputSchema.parse(input);
    await this.sweep();
    const now = Date.now();
    const next = this.watches.filter(
      watch =>
        watch.expiresAt > now &&
        !(sameTenant(watch.tenant, tenant) && watch.sessionID === sessionID)
    );
    if (watching) next.push({ tenant, sessionID, expiresAt: now + WATCH_LEASE_MS });
    if (next.length > WATCH_LIMIT || byteLength(next) > 100_000)
      throw new Error('Presence watch budget exceeded');
    const persisted = this.ctx.storage.put('watches', next);
    this.watches = next;
    for (const [ws, state] of this.connections()) {
      if (
        state.ticket.role === 'runner' &&
        sameTenant(state.ticket.tenant, tenant) &&
        this.advertisements.get(state.connectionID)?.value.sessions.includes(sessionID) &&
        this.online(state, now)
      ) {
        this.emit(ws, state, 'watch', { tenant, sessionID, watching });
      }
    }
    await persisted;
    await this.schedule();
  }

  async list(): Promise<Instance[]> {
    await this.sweep();
    return this.instances();
  }

  async alarm(): Promise<void> {
    this.alarmAt = null;
    await this.sweep();
    await this.schedule();
  }

  private attachment(ws: WebSocket): Attachment | undefined {
    return this.attachments.get(ws);
  }

  private saveAttachment(ws: WebSocket, state: Attachment): void {
    ws.serializeAttachment(state);
    this.attachments.set(ws, state);
  }

  private connections(): [WebSocket, Attachment][] {
    const result: [WebSocket, Attachment][] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.attachment(ws);
      if (state && !state.closed) result.push([ws, state]);
    }
    return result;
  }

  private online(state: Attachment, now: number): boolean {
    return (
      !state.closed &&
      state.ticket.exp * 1000 > now &&
      state.lastHeartbeatAt + LIVE_LIMITS.staleMs > now
    );
  }

  private instances(tenant?: Tenant): Instance[] {
    const now = Date.now();
    const result: Instance[] = [];
    for (const [, state] of this.connections()) {
      const advertisement = this.advertisements.get(state.connectionID)?.value;
      if (
        state.ticket.role !== 'runner' ||
        !state.instanceID ||
        !advertisement ||
        (tenant && !sameTenant(tenant, state.ticket.tenant))
      )
        continue;
      result.push({
        instanceID: state.instanceID,
        tenant: state.ticket.tenant,
        advertisement,
        online: this.online(state, now),
        lastHeartbeatAt: state.lastHeartbeatAt,
      });
    }
    return result;
  }

  private emit(ws: WebSocket, state: Attachment, type: string, body: unknown): void {
    state.seq++;
    this.saveAttachment(ws, state);
    if (
      !send(ws, {
        v: 1,
        channel: 'control',
        seq: state.seq,
        from: 'server',
        at: Date.now(),
        type,
        body,
      })
    ) {
      this.close(ws, state, 1011, 'Transport unavailable');
    }
  }

  private close(ws: WebSocket, state: Attachment, code: number, reason: string): void {
    state.closed = true;
    this.saveAttachment(ws, state);
    this.attachments.delete(ws);
    this.db
      .delete(presenceAdvertisements)
      .where(eq(presenceAdvertisements.connection_id, state.connectionID))
      .run();
    this.advertisements.delete(state.connectionID);
    try {
      const replyCode = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
      ws.close(replyCode, reason);
    } catch {
      // The runtime may already have closed a failed transport.
    }
  }

  private broadcast(): void {
    let fanout = 0;
    const snapshots = new Map<string, Instance[]>();
    for (const [ws, state] of this.connections()) {
      if (
        state.ticket.role === 'viewer' &&
        state.subscribed &&
        state.ticket.exp * 1000 > Date.now()
      ) {
        const key = JSON.stringify(state.ticket.tenant);
        let instances = snapshots.get(key);
        if (!instances) {
          instances = this.instances(state.ticket.tenant);
          snapshots.set(key, instances);
        }
        this.emit(ws, state, 'instances', { instances });
        fanout++;
      }
    }
    liveMetric(this.env, { route: 'presence_broadcast', role: 'viewer', fanout });
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [ws, state] of this.connections()) {
      const expired = state.ticket.exp * 1000 <= now;
      const stale =
        state.ticket.role === 'runner' && state.lastHeartbeatAt + LIVE_LIMITS.staleMs <= now;
      if (expired || stale) {
        this.close(
          ws,
          state,
          expired ? 4001 : 4000,
          expired ? 'Ticket expired' : 'Heartbeat stale'
        );
        changed = true;
      }
    }
    const expired = this.watches.filter(watch => watch.expiresAt <= now);
    if (expired.length > 0) {
      this.watches = this.watches.filter(watch => watch.expiresAt > now);
      const persisted = this.ctx.storage.put('watches', this.watches);
      for (const watch of expired) {
        for (const [ws, state] of this.connections()) {
          if (
            state.ticket.role === 'runner' &&
            sameTenant(state.ticket.tenant, watch.tenant) &&
            this.advertisements.get(state.connectionID)?.value.sessions.includes(watch.sessionID)
          ) {
            this.emit(ws, state, 'watch', {
              tenant: watch.tenant,
              sessionID: watch.sessionID,
              watching: false,
            });
          }
        }
      }
      await persisted;
    }
    if (changed) this.broadcast();
  }

  private async schedule(): Promise<void> {
    let due = Infinity;
    for (const [, state] of this.connections()) {
      due = Math.min(due, state.ticket.exp * 1000);
      if (state.ticket.role === 'runner')
        due = Math.min(due, state.lastHeartbeatAt + LIVE_LIMITS.staleMs);
    }
    for (const watch of this.watches) due = Math.min(due, watch.expiresAt);
    if (due === Infinity) {
      if (this.alarmAt !== null) {
        this.alarmAt = null;
        await this.ctx.storage.deleteAlarm();
      }
    } else if (this.alarmAt === null || this.alarmAt > due) {
      this.alarmAt = Math.max(Date.now() + 1, due);
      await this.ctx.storage.setAlarm(this.alarmAt);
    }
  }
}

export function getPresenceStub(env: Pick<Env, 'SESSION_PRESENCE_DO'>, userID: string) {
  return env.SESSION_PRESENCE_DO.get(env.SESSION_PRESENCE_DO.idFromName(presenceName(userID)));
}
