import { DurableObject } from 'cloudflare:workers';
import { asc, count, eq, lt, lte, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';

import migrations from '../../drizzle-presence/migrations';
import {
  presenceAdvertisements,
  presenceCommandRates,
  presenceCommandRoutes,
} from '../db/presence-sqlite-schema';
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
import { verifyTicket, type LiveTicket } from '../live/ticket';
import {
  isBoundedJson,
  sessionIDSchema,
  tenantSchema,
  userIDSchema,
  type Tenant,
} from '../protocol';
import { diagnostic, phase } from '../metrics';

const WATCH_LEASE_MS = 5 * 60_000;
const WATCH_LIMIT = 128;
const INSTANCE_LIMIT = 32;
const PROVISIONAL_RUNNER_LIMIT = 8;
const ATTACHMENT_BYTES = 1_536;
const ADVERTISEMENT_BYTES = 8_192;
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_ROUTE_LIMIT = 1_000;
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
  role: z.enum(['runner', 'viewer', 'controller']),
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
/** Why a presence fan-out happened; recorded on the `presence_broadcast` metric. */
type BroadcastReason =
  | 'heartbeat'
  | 'ticket_expired'
  | 'heartbeat_stale'
  | 'message_too_large'
  | 'rate_limited'
  | 'reauthorization_failed'
  | 'socket_closed'
  | 'socket_error';
const watchSchema = z.strictObject({
  tenant: tenantSchema,
  sessionID: sessionIDSchema,
  expiresAt: z.number().int(),
});
type Watch = z.infer<typeof watchSchema>;
const watchInputSchema = watchSchema.omit({ expiresAt: true }).extend({ watching: z.boolean() });
const commandSchema = z.strictObject({
  channel: z.literal('commands'),
  type: z.string().min(1).max(256),
  commandID: z.string().min(1).max(256),
  instanceID: z.string().min(1).max(128),
  body: z.unknown().default(null).refine(isBoundedJson),
});
type CommandFailure = {
  ok: false;
  status: number;
  code: string;
  message: string;
  retryAfter?: number;
};
type CommandResult =
  | CommandFailure
  | {
      ok: true;
      commandID: string;
      instanceID: string;
      expiresAt: number;
    };
type CommandRoute = typeof presenceCommandRoutes.$inferSelect;
type HTTPWaiter = { resolve: (response: Response) => void; cancel: () => void };
const frameSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('reauth'), ticket: z.string().min(1).max(8_192) }),
  z.strictObject({ type: z.literal('subscribe') }),
  z.strictObject({
    type: z.literal('heartbeat'),
    instanceID: z.string().min(1).max(128),
    advertisement: advertisementSchema,
  }),
  z.strictObject({
    type: z.literal('reply'),
    commandID: z.string().min(1).max(256),
    body: z.unknown().default(null).refine(isBoundedJson),
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
  private httpWaiters = new Map<string, HTTPWaiter>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() =>
      phase(env, 'presenceInitialize', 'initialize', async () => {
        await migrate(this.db, migrations);
        const active = new Set<string>();
        for (const ws of ctx.getWebSockets()) {
          let value: unknown;
          try {
            value = ws.deserializeAttachment();
          } catch {
            value = undefined;
          }
          const saved = attachmentSchema.safeParse(value);
          if (saved.success && !saved.data.closed) {
            active.add(saved.data.connectionID);
            this.attachments.set(ws, saved.data);
          } else {
            try {
              ws.close(
                saved.success ? 1000 : 1008,
                saved.success ? 'Connection already closed' : 'Invalid connection metadata'
              );
            } catch {
              // A transport that already disconnected has no open socket to reclaim.
            }
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
        this.expireCommands(Date.now());
        for (const route of this.db.select().from(presenceCommandRoutes).all()) {
          if (
            !active.has(route.runner_connection_id) ||
            route.controller_connection_id === null ||
            !active.has(route.controller_connection_id)
          )
            this.finishUnknown(route);
        }
      })
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const token = socketTicket(request);
    const ticket = token ? await verifyTicket(token, this.env, 'session-presence') : undefined;
    if (
      !ticket ||
      ticket.sessionID !== undefined ||
      !this.ctx.id.equals(this.env.SESSION_PRESENCE_DO.idFromName(presenceName(ticket.userID)))
    ) {
      return new Response('Invalid presence ticket', { status: 401 });
    }
    await this.sweep();
    const connections = this.connections();
    const limit = ticket.role === 'runner' ? PROVISIONAL_RUNNER_LIMIT : LIVE_LIMITS.viewers;
    const competing = connections.filter(([, state]) =>
      ticket.role === 'runner'
        ? state.ticket.role === 'runner' && state.instanceID === undefined
        : state.ticket.role !== 'runner'
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
      this.closeAndBroadcast(ws, state, 4001, 'Ticket expired', 'ticket_expired');
      return;
    }
    if (state.ticket.role === 'runner' && state.lastHeartbeatAt + LIVE_LIMITS.staleMs <= now) {
      this.closeAndBroadcast(ws, state, 4000, 'Heartbeat stale', 'heartbeat_stale');
      return;
    }
    const bytes =
      typeof message === 'string' ? encoder.encode(message).byteLength : message.byteLength;
    if (bytes > LIVE_LIMITS.messageBytes) {
      this.closeAndBroadcast(ws, state, 1009, 'Message too large', 'message_too_large');
      return;
    }
    let value: unknown;
    try {
      value = typeof message === 'string' ? JSON.parse(message) : undefined;
    } catch {
      value = undefined;
    }
    if (now - state.rateAt >= 60_000) {
      state.rateAt = now;
      state.rateCount = 0;
    }
    state.rateCount++;
    this.saveAttachment(ws, state);
    if (state.rateCount > LIVE_LIMITS.rates[state.ticket.role]) {
      this.closeAndBroadcast(ws, state, 1008, 'Rate limit exceeded', 'rate_limited');
      return;
    }
    const commandFrame =
      typeof value === 'object' &&
      value !== null &&
      'channel' in value &&
      value.channel === 'commands';
    if (commandFrame && state.ticket.role === 'controller') {
      const result = this.acceptCommand(state.ticket, value, state.connectionID);
      if (result.ok) {
        this.emit(ws, state, 'command_status', {
          commandID: result.commandID,
          instanceID: result.instanceID,
          status: 'delivered',
        });
      } else {
        this.emit(ws, state, 'error', {
          code: result.code,
          message: result.message,
          ...(result.retryAfter === undefined ? {} : { retryAfterMs: result.retryAfter * 1000 }),
        });
      }
      await this.schedule();
      return;
    }
    if (commandFrame) {
      this.emit(ws, state, 'error', {
        code: 'forbidden',
        message: 'A controller ticket is required',
      });
      return;
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
        this.closeAndBroadcast(
          ws,
          state,
          4001,
          'Invalid reauthorization',
          'reauthorization_failed'
        );
        return;
      }
      const fresh = ticketSchema.safeParse(ticket);
      if (!fresh.success) {
        this.closeAndBroadcast(
          ws,
          state,
          4001,
          'Invalid reauthorization',
          'reauthorization_failed'
        );
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
    } else if (frame.type === 'subscribe' && state.ticket.role !== 'runner') {
      state.subscribed = true;
      this.emit(ws, state, 'instances', { instances: this.instances(state.ticket.tenant) });
    } else if (frame.type === 'reply' && state.ticket.role === 'runner') {
      this.acceptReply(ws, state, frame.commandID, frame.body);
      await this.schedule();
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
      // Viewers only need a new snapshot when this heartbeat changes what they can
      // see; a heartbeat that refreshes the timestamp alone must not fan out.
      const signatureBefore = this.presenceSignature(tenant);
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
      if (this.presenceSignature(tenant) !== signatureBefore) this.broadcast('heartbeat');
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

  async command(input: { ticket: string; command: unknown }): Promise<Response> {
    const ticket = await verifyTicket(input.ticket, this.env, 'session-presence');
    if (
      !ticket ||
      ticket.role !== 'controller' ||
      ticket.sessionID !== undefined ||
      !this.ctx.id.equals(this.env.SESSION_PRESENCE_DO.idFromName(presenceName(ticket.userID)))
    ) {
      return Response.json(
        { error: { code: 'forbidden', message: 'A controller ticket is required' } },
        { status: 403 }
      );
    }
    await this.sweep();
    const result = this.acceptCommand(ticket, input.command, null);
    if (!result.ok) {
      await this.schedule();
      return Response.json(
        { error: { code: result.code, message: result.message } },
        {
          status: result.status,
          headers:
            result.retryAfter === undefined
              ? undefined
              : { 'retry-after': String(result.retryAfter) },
        }
      );
    }
    const pending = Promise.withResolvers<Response>();
    const timer = setTimeout(
      () => {
        this.db
          .delete(presenceCommandRoutes)
          .where(eq(presenceCommandRoutes.command_id, result.commandID))
          .run();
        this.httpWaiters.delete(result.commandID);
        pending.resolve(
          Response.json(
            {
              commandID: result.commandID,
              instanceID: result.instanceID,
              status: 'unknown',
            },
            { status: 202 }
          )
        );
      },
      Math.max(0, result.expiresAt - Date.now())
    );
    this.httpWaiters.set(result.commandID, {
      resolve: pending.resolve,
      cancel: () => clearTimeout(timer),
    });
    await this.schedule();
    return pending.promise;
  }

  private acceptCommand(
    ticket: LiveTicket,
    input: unknown,
    controllerConnectionID: string | null
  ): CommandResult {
    if (ticket.role !== 'controller' || ticket.exp * 1000 <= Date.now()) {
      return {
        ok: false,
        status: 403,
        code: 'forbidden',
        message: 'A controller ticket is required',
      };
    }
    const now = Date.now();
    this.expireCommands(now);
    const window = Math.floor(now / 60_000);
    const key = JSON.stringify([ticket.userID, ticket.tenant.type, ticket.tenant.id]);
    const prior = this.db
      .select()
      .from(presenceCommandRates)
      .where(eq(presenceCommandRates.key, key))
      .get();
    const used = prior?.window === window ? prior.count : 0;
    if (used >= LIVE_LIMITS.rates.controller) {
      return {
        ok: false,
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'Presence command rate limit exceeded',
        retryAfter: Math.max(1, Math.ceil(((window + 1) * 60_000 - now) / 1000)),
      };
    }
    this.db
      .insert(presenceCommandRates)
      .values({ key, window, count: used + 1 })
      .onConflictDoUpdate({ target: presenceCommandRates.key, set: { window, count: used + 1 } })
      .run();
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        status: 400,
        code: 'invalid_request',
        message: 'Invalid instance command',
      };
    const command = parsed.data;
    const body = {
      commandID: command.commandID,
      instanceID: command.instanceID,
      payload: command.body,
    };
    if (
      byteLength(command) > LIVE_LIMITS.messageBytes ||
      byteLength({
        v: 1,
        channel: 'commands',
        seq: Number.MAX_SAFE_INTEGER,
        from: ticket.userID,
        at: now,
        type: command.type,
        body,
      }) > LIVE_LIMITS.messageBytes
    ) {
      return {
        ok: false,
        status: 413,
        code: 'message_too_large',
        message: 'Instance command exceeds the message limit',
      };
    }
    const runner = this.connections().find(
      ([, state]) =>
        state.ticket.role === 'runner' &&
        state.instanceID === command.instanceID &&
        sameTenant(state.ticket.tenant, ticket.tenant) &&
        this.advertisements.has(state.connectionID) &&
        this.online(state, now)
    );
    if (!runner)
      return {
        ok: false,
        status: 409,
        code: 'instance_offline',
        message: 'The instance is not online',
      };
    if (
      this.db
        .select()
        .from(presenceCommandRoutes)
        .where(eq(presenceCommandRoutes.command_id, command.commandID))
        .get()
    ) {
      return {
        ok: false,
        status: 409,
        code: 'command_conflict',
        message: 'The command ID is already pending',
      };
    }
    const outstanding = this.db.select({ count: count() }).from(presenceCommandRoutes).get();
    if ((outstanding?.count ?? 0) >= COMMAND_ROUTE_LIMIT) {
      return {
        ok: false,
        status: 503,
        code: 'service_overloaded',
        message: 'Presence command routing is full',
      };
    }
    const expiresAt = now + COMMAND_TIMEOUT_MS;
    if (!this.emit(runner[0], runner[1], command.type, body, 'commands', ticket.userID)) {
      return {
        ok: false,
        status: 409,
        code: 'instance_offline',
        message: 'The instance is not online',
      };
    }
    this.db
      .insert(presenceCommandRoutes)
      .values({
        command_id: command.commandID,
        controller_connection_id: controllerConnectionID,
        runner_connection_id: runner[1].connectionID,
        tenant_type: ticket.tenant.type,
        tenant_id: ticket.tenant.id,
        instance_id: command.instanceID,
        expires_at: expiresAt,
      })
      .run();
    liveMetric(this.env, {
      route: 'presence_command',
      role: ticket.role,
      bytes: byteLength(command),
      fanout: 1,
    });
    return { ok: true, commandID: command.commandID, instanceID: command.instanceID, expiresAt };
  }

  private acceptReply(ws: WebSocket, state: Attachment, commandID: string, payload: unknown): void {
    const now = Date.now();
    this.expireCommands(now);
    const route = this.db
      .select()
      .from(presenceCommandRoutes)
      .where(eq(presenceCommandRoutes.command_id, commandID))
      .get();
    if (
      !route ||
      route.runner_connection_id !== state.connectionID ||
      route.instance_id !== state.instanceID ||
      route.tenant_type !== state.ticket.tenant.type ||
      route.tenant_id !== state.ticket.tenant.id ||
      !this.online(state, now)
    ) {
      this.emit(ws, state, 'error', {
        code: 'command_not_found',
        message: 'No pending command for this runner',
      });
      return;
    }
    const body = { commandID, instanceID: route.instance_id, payload };
    if (
      byteLength({
        v: 1,
        channel: 'control',
        seq: Number.MAX_SAFE_INTEGER,
        from: state.ticket.userID,
        at: now,
        type: 'reply',
        body,
      }) > LIVE_LIMITS.messageBytes
    ) {
      this.emit(ws, state, 'error', {
        code: 'message_too_large',
        message: 'Instance reply exceeds the message limit',
      });
      return;
    }
    this.db
      .delete(presenceCommandRoutes)
      .where(eq(presenceCommandRoutes.command_id, commandID))
      .run();
    const waiter = this.httpWaiters.get(commandID);
    if (waiter) {
      this.httpWaiters.delete(commandID);
      waiter.cancel();
      waiter.resolve(
        Response.json({
          commandID,
          instanceID: route.instance_id,
          status: 'replied',
          body: payload,
        })
      );
    } else if (route.controller_connection_id !== null) {
      const controller = this.connections().find(
        ([, saved]) =>
          saved.connectionID === route.controller_connection_id &&
          saved.ticket.role === 'controller' &&
          saved.ticket.exp * 1000 > now &&
          saved.ticket.tenant.type === route.tenant_type &&
          saved.ticket.tenant.id === route.tenant_id
      );
      if (controller)
        this.emit(controller[0], controller[1], 'reply', body, 'control', state.ticket.userID);
    }
  }

  private finishUnknown(route: CommandRoute): void {
    const removed = this.db
      .delete(presenceCommandRoutes)
      .where(eq(presenceCommandRoutes.command_id, route.command_id))
      .returning()
      .get();
    if (!removed) return;
    const waiter = this.httpWaiters.get(route.command_id);
    if (waiter) {
      this.httpWaiters.delete(route.command_id);
      waiter.cancel();
      waiter.resolve(
        Response.json(
          {
            commandID: route.command_id,
            instanceID: route.instance_id,
            status: 'unknown',
          },
          { status: 202 }
        )
      );
    } else if (route.controller_connection_id !== null) {
      const controller = this.connections().find(
        ([, saved]) =>
          saved.connectionID === route.controller_connection_id &&
          saved.ticket.role === 'controller' &&
          saved.ticket.exp * 1000 > Date.now() &&
          saved.ticket.tenant.type === route.tenant_type &&
          saved.ticket.tenant.id === route.tenant_id
      );
      if (controller)
        this.emit(controller[0], controller[1], 'command_status', {
          commandID: route.command_id,
          instanceID: route.instance_id,
          status: 'unknown',
        });
    }
  }

  private expireCommands(now: number): void {
    for (const route of this.db
      .select()
      .from(presenceCommandRoutes)
      .where(lte(presenceCommandRoutes.expires_at, now))
      .all())
      this.finishUnknown(route);
    this.db
      .delete(presenceCommandRates)
      .where(lt(presenceCommandRates.window, Math.floor(now / 60_000)))
      .run();
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const state = this.attachment(ws);
    if (state && !state.closed) this.closeAndBroadcast(ws, state, code, reason, 'socket_closed');
    await this.schedule();
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const state = this.attachment(ws);
    if (state) this.closeAndBroadcast(ws, state, 1011, 'Transport unavailable', 'socket_error');
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
    if (next.length > WATCH_LIMIT || byteLength(next) > 100_000) {
      diagnostic(this.env, {
        operation: 'relayWatch',
        stage: 'watch_budget',
        tenant: tenant.type,
        outcome: 'error',
        cause: 'watch_budget',
        queueDepth: next.length,
      });
      throw new Error('Presence watch budget exceeded');
    }
    const persisted = phase(
      this.env,
      'relayWatch',
      'watch_storage',
      () => this.ctx.storage.put('watches', next),
      tenant.type
    );
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
    await phase(this.env, 'relayWatch', 'schedule', () => this.schedule(), tenant.type);
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

  /** Instances a viewer could see, with the advertisement text already serialized. */
  private *advertisedInstances(tenant?: Tenant) {
    for (const [, state] of this.connections()) {
      const advertisement = this.advertisements.get(state.connectionID);
      if (
        state.ticket.role !== 'runner' ||
        state.instanceID === undefined ||
        !advertisement ||
        (tenant && !sameTenant(tenant, state.ticket.tenant))
      )
        continue;
      yield {
        instanceID: state.instanceID,
        state,
        advertisement: advertisement.value,
        encoded: advertisement.encoded,
      };
    }
  }

  private instances(tenant?: Tenant): Instance[] {
    const now = Date.now();
    const result: Instance[] = [];
    for (const { instanceID, state, advertisement } of this.advertisedInstances(tenant)) {
      result.push({
        instanceID,
        tenant: state.ticket.tenant,
        advertisement,
        online: this.online(state, now),
        lastHeartbeatAt: state.lastHeartbeatAt,
      });
    }
    return result;
  }

  /** What a subscribed viewer would receive, excluding the per-heartbeat timestamp. */
  private presenceSignature(tenant: Tenant): string {
    const now = Date.now();
    const entries: string[] = [];
    for (const { instanceID, state, encoded } of this.advertisedInstances(tenant)) {
      entries.push(JSON.stringify([instanceID, encoded, this.online(state, now)]));
    }
    return entries.sort().join('\n');
  }

  /** Only an advertised runner appears in a viewer's instance list. */
  private contributesToInstances(state: Attachment): boolean {
    return (
      state.ticket.role === 'runner' &&
      state.instanceID !== undefined &&
      this.advertisements.has(state.connectionID)
    );
  }

  private emit(
    ws: WebSocket,
    state: Attachment,
    type: string,
    body: unknown,
    channel: 'commands' | 'control' = 'control',
    from = 'server'
  ): boolean {
    state.seq++;
    this.saveAttachment(ws, state);
    if (
      !send(ws, {
        v: 1,
        channel,
        seq: state.seq,
        from,
        at: Date.now(),
        type,
        body,
      })
    ) {
      this.closeAndBroadcast(ws, state, 1011, 'Transport unavailable', 'socket_error');
      return false;
    }
    return true;
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
    for (const route of this.db
      .select()
      .from(presenceCommandRoutes)
      .where(
        or(
          eq(presenceCommandRoutes.runner_connection_id, state.connectionID),
          eq(presenceCommandRoutes.controller_connection_id, state.connectionID)
        )
      )
      .all())
      this.finishUnknown(route);
    try {
      const replyCode = code === 1005 || code === 1006 || code === 1015 ? 1000 : code;
      ws.close(replyCode, reason);
    } catch {
      // The runtime may already have closed a failed transport.
    }
  }

  private closeAndBroadcast(
    ws: WebSocket,
    state: Attachment,
    code: number,
    closeReason: string,
    reason: BroadcastReason
  ): void {
    const visible = this.contributesToInstances(state);
    this.close(ws, state, code, closeReason);
    if (visible) this.broadcast(reason);
  }

  private broadcast(reason: BroadcastReason): void {
    let fanout = 0;
    const snapshots = new Map<string, Instance[]>();
    for (const [ws, state] of this.connections()) {
      if (
        state.ticket.role !== 'runner' &&
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
    liveMetric(this.env, { route: 'presence_broadcast', role: 'viewer', reason, fanout });
  }

  private async sweep(): Promise<void> {
    const now = Date.now();
    this.expireCommands(now);
    let reason: BroadcastReason | undefined;
    for (const [ws, state] of this.connections()) {
      const expired = state.ticket.exp * 1000 <= now;
      const stale =
        state.ticket.role === 'runner' && state.lastHeartbeatAt + LIVE_LIMITS.staleMs <= now;
      if (expired || stale) {
        if (this.contributesToInstances(state))
          reason ??= expired ? 'ticket_expired' : 'heartbeat_stale';
        this.close(
          ws,
          state,
          expired ? 4001 : 4000,
          expired ? 'Ticket expired' : 'Heartbeat stale'
        );
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
    if (reason) this.broadcast(reason);
  }

  private async schedule(): Promise<void> {
    let due = Infinity;
    for (const [, state] of this.connections()) {
      due = Math.min(due, state.ticket.exp * 1000);
      if (state.ticket.role === 'runner')
        due = Math.min(due, state.lastHeartbeatAt + LIVE_LIMITS.staleMs);
    }
    for (const watch of this.watches) due = Math.min(due, watch.expiresAt);
    const command = this.db
      .select()
      .from(presenceCommandRoutes)
      .orderBy(asc(presenceCommandRoutes.expires_at))
      .limit(1)
      .get();
    if (command) due = Math.min(due, command.expires_at);
    const rate = this.db
      .select()
      .from(presenceCommandRates)
      .orderBy(asc(presenceCommandRates.window))
      .limit(1)
      .get();
    if (rate) due = Math.min(due, (rate.window + 1) * 60_000);
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
