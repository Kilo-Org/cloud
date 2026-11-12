import { DurableObject } from 'cloudflare:workers';
import { and, asc, count, eq, gte, isNotNull, isNull, lt, lte, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { migrate } from 'drizzle-orm/durable-sqlite/migrator';
import { z } from 'zod';

import migrations from '../../drizzle-relay/migrations';
import { relayCommands, relayRates, relayState, relayWatches } from '../db/relay-sqlite-schema';
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
import { isBoundedJson, sessionIDSchema, tenantSchema, type Tenant } from '../protocol';
import { getPresenceStub } from './SessionPresenceDO';
import { diagnostic, metricsEnabled, phase, syncPhase } from '../metrics';

const commandSchema = z.strictObject({
  channel: z.literal('commands'),
  type: z.string().min(1).max(256),
  body: z.unknown().default(null).refine(isBoundedJson),
  commandID: z.string().min(1).max(256),
  liveOnly: z.boolean().optional(),
  ttlMs: z.number().int().min(1).max(LIVE_LIMITS.mailboxMaxMs).optional(),
});
const frameSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('subscribe'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ type: z.literal('ack'), commandID: z.string().min(1).max(256) }),
  z.strictObject({ type: z.literal('reauth'), ticket: z.string().min(1).max(8192) }),
]);
const eventSchema = z.strictObject({
  channel: z.literal('events'),
  type: z.string().min(1).max(256),
  body: z.unknown().default(null).refine(isBoundedJson),
});
const attachmentSchema = z.strictObject({
  ticket: z.strictObject({
    version: z.literal(1),
    aud: z.literal('session-relay'),
    env: z.string(),
    tenant: tenantSchema,
    sessionID: sessionIDSchema,
    userID: z.string(),
    role: z.enum(['runner', 'viewer', 'controller']),
    exp: z.number(),
    iat: z.number(),
  }),
  subscribed: z.boolean(),
  reauthNotified: z.boolean(),
  closed: z.boolean(),
});
type Attachment = z.infer<typeof attachmentSchema>;
type CommandRow = typeof relayCommands.$inferSelect;
type EventEntry = { seq: number; at: number; encoded: string; bytes: number };
type WatchSubject = { userID: string; tenant: Tenant; sessionID: string };

const encoder = new TextEncoder();
const receiptMs = LIVE_LIMITS.mailboxMaxMs;
const sequenceBlock = 1024;
const watchRefreshMs = 75_000;

function error(status: number, code: string, message: string): Response {
  const headers = new Headers();
  if (status === 503) headers.set('retry-after', String(Math.ceil(reconnectHint() / 1000)));
  if (status === 429)
    headers.set(
      'retry-after',
      String(Math.max(1, Math.ceil((60_000 - (Date.now() % 60_000)) / 1000)))
    );
  return Response.json({ error: { code, message } }, { status, headers });
}

/** One authenticated, opaque live stream and bounded offline mailbox per tenant/session. */
export class SessionRelayDO extends DurableObject<Env> {
  private db;
  private seq = 0;
  private replayFloor = 0;
  private ring: EventEntry[] = [];
  private ringBytes = 0;
  private ceiling = 0;
  private purged = false;
  private alarmAt: number | null = null;
  private watchRefreshAt = Date.now() + watchRefreshMs;
  private watchSerial: Promise<void> = Promise.resolve();
  private watchQueueDepth = 0;
  private runnerRates = new Map<string, { window: number; count: number }>();
  private attachments = new Map<WebSocket, Attachment>();
  // Highest event sequence handed to each socket. Memory only: after reconstruction the replay floor
  // already starts at the stored sequence ceiling, so a persisted value could never change replay.
  private delivered = new WeakMap<WebSocket, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = drizzle(ctx.storage, { logger: false });
    void ctx.blockConcurrencyWhile(() =>
      phase(env, 'relayInitialize', 'initialize', async () => {
        await migrate(this.db, migrations);
        this.db.insert(relayState).values({ id: 1, seq: 0 }).onConflictDoNothing().run();
        const state = this.db.select().from(relayState).where(eq(relayState.id, 1)).get();
        this.seq = state?.seq ?? 0;
        this.ceiling = this.seq;
        this.purged = state?.purged ?? false;
        this.replayFloor = this.seq;
        this.alarmAt = await ctx.storage.getAlarm();
        for (const ws of ctx.getWebSockets()) this.attachment(ws);
      })
    );
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      return error(426, 'upgrade_required', 'Expected a WebSocket upgrade');
    const token = socketTicket(request);
    const ticket = token ? await this.authorize(token) : undefined;
    if (this.purged || !ticket) return error(401, 'unauthorized', 'Invalid relay ticket');
    this.sweep();
    if (!this.takeRate(ticket))
      return error(429, 'rate_limit_exceeded', 'Relay rate limit exceeded');
    const sockets = this.sockets();
    if (ticket.role === 'runner') {
      const prior = sockets.find(([, state]) => state.ticket.role === 'runner');
      if (prior && prior[1].ticket.userID !== ticket.userID)
        return error(409, 'runner_connected', 'A runner is already connected');
      if (prior) this.close(prior[0], prior[1], 4009, 'Runner replaced by reconnect', true);
    }
    if (
      ticket.role !== 'runner' &&
      sockets.filter(([, state]) => state.ticket.role !== 'runner').length >= LIVE_LIMITS.viewers
    )
      return error(503, 'service_overloaded', 'The relay viewer limit is reached');

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const state: Attachment = { ticket, subscribed: false, reauthNotified: false, closed: false };
    this.ctx.acceptWebSocket(server);
    this.saveAttachment(server, state);
    this.control(server, 'hello', {
      seq: this.seq,
      runnerConnected: Boolean(this.runner()),
      reconnectAfterMs: reconnectHint(),
      reauthAt: new Date(ticket.exp * 1000 - LIVE_LIMITS.heartbeatMs).toISOString(),
      expiresAt: new Date(ticket.exp * 1000).toISOString(),
    });
    if (ticket.role === 'runner') {
      this.deliverMailbox(server);
      this.broadcastControl('runner_status', { runnerConnected: true });
    } else {
      this.ctx.waitUntil(this.notifyWatch(ticket));
    }
    await this.schedule();
    liveMetric(this.env, { route: 'relay.connect', role: ticket.role });
    const selected = socketProtocol(request);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: selected ? { 'Sec-WebSocket-Protocol': selected } : undefined,
    });
  }
  /** Permanent tombstone: even pre-delete tickets can never reopen this relay. */
  async purge(): Promise<void> {
    this.purged = true;
    this.ctx.storage.transactionSync(() => {
      this.db.update(relayState).set({ seq: 0, purged: true }).where(eq(relayState.id, 1)).run();
      this.db.delete(relayCommands).where(gte(relayCommands.ordinal, 0)).run();
      this.db.delete(relayRates).where(gte(relayRates.count, 0)).run();
    });
    this.seq = 0;
    this.ceiling = 0;
    this.replayFloor = 0;
    this.ring = [];
    this.ringBytes = 0;
    this.runnerRates.clear();
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.attachment(ws);
      if (state && !state.closed) this.close(ws, state, 4001, 'Session deleted');
    }
    await this.watchSerial;
    try {
      for (const row of this.db.select().from(relayWatches).all()) {
        await getPresenceStub(this.env, row.user_id).watch({
          tenant: tenantSchema.parse(row.tenant),
          sessionID: row.session_id,
          watching: false,
        });
        this.db.delete(relayWatches).where(eq(relayWatches.user_id, row.user_id)).run();
      }
    } finally {
      await this.schedule();
    }
  }

  async command(input: { ticket: string; command: unknown }): Promise<Response> {
    const ticket = await this.authorize(input.ticket);
    if (this.purged || !ticket || ticket.role !== 'controller')
      return error(403, 'forbidden', 'A controller ticket is required');
    this.sweep();
    if (!this.takeRate(ticket))
      return error(429, 'rate_limit_exceeded', 'Relay rate limit exceeded');
    const response = this.acceptCommand(ticket, input.command);
    await this.schedule();
    return response;
  }

  async commandStatus(input: { ticket: string; commandID: string }): Promise<Response> {
    const ticket = await this.authorize(input.ticket);
    if (this.purged || !ticket || ticket.role === 'runner')
      return error(403, 'forbidden', 'A viewer or controller ticket is required');
    this.sweep();
    if (!this.takeRate(ticket, 'status'))
      return error(429, 'rate_limit_exceeded', 'Relay rate limit exceeded');
    await this.schedule();
    if (!z.string().min(1).max(256).safeParse(input.commandID).success)
      return error(400, 'invalid_request', 'Invalid command ID');
    const row = this.db
      .select()
      .from(relayCommands)
      .where(eq(relayCommands.command_id, input.commandID))
      .get();
    if (!row) return error(404, 'not_found', 'Unknown or no longer retained command');
    return Response.json({ commandID: row.command_id, status: row.status });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.purged) return;
    const state = this.attachment(ws);
    if (!state || state.closed) return;
    if (state.ticket.exp * 1000 <= Date.now()) {
      this.close(ws, state, 1008, 'Relay ticket expired');
      await this.schedule();
      return;
    }
    if (!this.takeRate(state.ticket)) {
      this.control(ws, 'error', { code: 'rate_limit_exceeded' });
      return;
    }
    if (
      typeof message !== 'string' ||
      encoder.encode(message).byteLength > LIVE_LIMITS.messageBytes
    ) {
      this.close(ws, state, 1009, 'Message exceeds the relay limit');
      await this.schedule();
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(message);
    } catch {
      this.control(ws, 'error', { code: 'invalid_request' });
      return;
    }
    const frame = frameSchema.safeParse(value);
    if (frame.success && frame.data.type === 'subscribe' && state.ticket.role !== 'runner') {
      // An unchanged subscription leaves the sweep and the presence watch to the alarm.
      if (this.subscribe(ws, state, frame.data.afterSeq)) {
        this.sweep();
        this.ctx.waitUntil(this.notifyWatch(state.ticket));
      }
      await this.schedule();
      return;
    }
    if (state.ticket.role !== 'runner') this.sweep();
    if (frame.success) {
      if (frame.data.type === 'reauth') {
        const ticket = await this.authorize(frame.data.ticket);
        const current = this.attachment(ws);
        if (
          this.purged ||
          !ticket ||
          !current ||
          current.closed ||
          current.ticket.exp * 1000 <= Date.now() ||
          !sameTicket(current.ticket, ticket)
        ) {
          if (current && !current.closed) this.close(ws, current, 1008, 'Invalid reauthorization');
        } else {
          current.ticket = ticket;
          current.reauthNotified = false;
          this.saveAttachment(ws, current);
          this.control(ws, 'reauthorized', {
            expiresAt: new Date(ticket.exp * 1000).toISOString(),
            reauthAt: new Date(ticket.exp * 1000 - LIVE_LIMITS.heartbeatMs).toISOString(),
          });
          if (ticket.role !== 'runner') this.ctx.waitUntil(this.notifyWatch(ticket));
        }
      } else if (frame.data.type === 'ack' && state.ticket.role === 'runner') {
        this.ack(frame.data.commandID);
      } else {
        this.control(ws, 'error', { code: 'forbidden' });
      }
    } else if (state.ticket.role === 'runner') {
      const event = eventSchema.safeParse(value);
      if (event.success) this.publish(ws, state.ticket, event.data);
      else this.control(ws, 'error', { code: 'invalid_request' });
      return;
    } else if (state.ticket.role === 'controller') {
      const response = this.acceptCommand(state.ticket, value);
      const body: unknown = await response.json();
      const failure = z
        .object({ error: z.object({ code: z.string(), message: z.string() }) })
        .safeParse(body);
      this.control(
        ws,
        response.ok ? 'command_status' : 'error',
        failure.success ? failure.data.error : body
      );
    } else {
      this.control(ws, 'error', { code: 'forbidden' });
    }
    await this.schedule();
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    const state = this.attachment(ws);
    if (state && !state.closed) this.close(ws, state, code, reason);
    await this.schedule();
  }

  override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    const state = this.attachment(ws);
    if (state && !state.closed) this.close(ws, state, 1011, 'WebSocket error');
    await this.schedule();
  }

  override async alarm(): Promise<void> {
    this.alarmAt = null;
    this.sweep();
    const users = new Map<string, WatchSubject>();
    for (const [ws, state] of this.sockets()) {
      if (
        state.ticket.role !== 'runner' &&
        !state.reauthNotified &&
        state.ticket.exp * 1000 - LIVE_LIMITS.heartbeatMs <= Date.now()
      ) {
        state.reauthNotified = true;
        this.saveAttachment(ws, state);
        this.control(ws, 'reauth_required', {
          expiresAt: new Date(state.ticket.exp * 1000).toISOString(),
        });
      }
      if (state.ticket.role !== 'runner') users.set(state.ticket.userID, state.ticket);
    }
    if (Date.now() >= this.watchRefreshAt) {
      for (const row of this.db.select().from(relayWatches).all()) {
        users.set(row.user_id, {
          tenant: tenantSchema.parse(row.tenant),
          sessionID: row.session_id,
          userID: row.user_id,
        });
      }
      for (const ticket of users.values()) this.ctx.waitUntil(this.notifyWatch(ticket));
      this.watchRefreshAt = Date.now() + watchRefreshMs;
    }
    await this.schedule();
  }

  private async authorize(token: string): Promise<Attachment['ticket'] | undefined> {
    if (this.purged) return undefined;
    const ticket = await verifyTicket(token, this.env, 'session-relay');
    if (this.purged || !ticket?.sessionID) return undefined;
    const name = JSON.stringify([ticket.tenant.type, ticket.tenant.id, ticket.sessionID]);
    if (!this.env.SESSION_RELAY_DO.idFromName(name).equals(this.ctx.id)) return undefined;
    const parsed = attachmentSchema.shape.ticket.safeParse(ticket);
    return parsed.success ? parsed.data : undefined;
  }

  private attachment(ws: WebSocket): Attachment | undefined {
    const cached = this.attachments.get(ws);
    if (cached) return cached;
    let value: unknown;
    try {
      value = ws.deserializeAttachment();
    } catch {
      ws.close(1008, 'Invalid relay attachment');
      return undefined;
    }
    const parsed = attachmentSchema.safeParse(value);
    if (!parsed.success) {
      ws.close(1008, 'Invalid relay attachment');
      return undefined;
    }
    if (parsed.data.closed) {
      ws.close(1000, 'Relay connection closed');
      return undefined;
    }
    this.attachments.set(ws, parsed.data);
    return parsed.data;
  }

  private saveAttachment(ws: WebSocket, state: Attachment): void {
    ws.serializeAttachment(state);
    if (state.closed) this.attachments.delete(ws);
    else this.attachments.set(ws, state);
  }

  private sockets(): Array<[WebSocket, Attachment]> {
    const sockets: Array<[WebSocket, Attachment]> = [];
    for (const [ws, state] of this.attachments) {
      if (!state.closed && state.ticket.exp * 1000 > Date.now()) sockets.push([ws, state]);
    }
    return sockets;
  }

  private runner(): WebSocket | undefined {
    return this.sockets().find(([, state]) => state.ticket.role === 'runner')?.[0];
  }

  private takeRate(ticket: LiveTicket, operation: 'write' | 'status' = 'write'): boolean {
    const now = Date.now();
    const window = Math.floor(now / 60_000);
    if (ticket.role === 'runner') {
      const prior = this.runnerRates.get(ticket.userID);
      const used = prior?.window === window ? prior.count : 0;
      if (used >= LIVE_LIMITS.rates.runner) return false;
      this.runnerRates.set(ticket.userID, { window, count: used + 1 });
      return true;
    }
    const key = JSON.stringify([ticket.userID, ticket.role, operation]);
    const prior = this.db.select().from(relayRates).where(eq(relayRates.key, key)).get();
    const used = prior?.window === window ? prior.count : 0;
    if (used >= LIVE_LIMITS.rates[ticket.role]) return false;
    this.db
      .insert(relayRates)
      .values({ key, window, count: used + 1 })
      .onConflictDoUpdate({
        target: relayRates.key,
        set: { window, count: used + 1 },
      })
      .run();
    return true;
  }

  private control(ws: WebSocket, type: string, body: unknown): boolean {
    return send(ws, {
      v: 1,
      channel: 'control',
      seq: this.seq,
      from: 'server',
      at: Date.now(),
      type,
      body,
    });
  }

  private broadcastControl(type: string, body: unknown): void {
    for (const [ws, state] of this.sockets()) {
      if (state.ticket.role !== 'runner') this.control(ws, type, body);
    }
  }

  private close(
    ws: WebSocket,
    state: Attachment,
    code: number,
    reason: string,
    replaced = false
  ): void {
    state.closed = true;
    this.saveAttachment(ws, state);
    // A peer that sent no Close code is reported as 1005, which cannot go on the wire.
    ws.close(code === 1005 || code === 1006 || code === 1015 ? 1000 : code, reason.slice(0, 100));
    if (state.ticket.role === 'runner') {
      this.expireLiveOnly();
      if (!replaced)
        this.broadcastControl('runner_status', { runnerConnected: Boolean(this.runner()) });
    } else if (!this.purged) this.ctx.waitUntil(this.notifyWatch(state.ticket));
  }

  private notifyWatch(ticket: Pick<LiveTicket, 'userID' | 'tenant' | 'sessionID'>): Promise<void> {
    if (!ticket.sessionID) return Promise.resolve();
    const subject: WatchSubject = {
      userID: ticket.userID,
      tenant: ticket.tenant,
      sessionID: ticket.sessionID,
    };
    syncPhase(
      this.env,
      'relayWatch',
      'watch_storage',
      () =>
        this.db
          .insert(relayWatches)
          .values({
            user_id: subject.userID,
            tenant: subject.tenant,
            session_id: subject.sessionID,
          })
          .onConflictDoNothing()
          .run(),
      subject.tenant.type
    );
    const queuedAt = metricsEnabled(this.env) ? performance.now() : 0;
    this.watchQueueDepth++;
    const task = this.watchSerial
      .then(async () => {
        diagnostic(this.env, {
          operation: 'relayWatch',
          stage: 'watch_queue',
          tenant: subject.tenant.type,
          durationMs: queuedAt ? performance.now() - queuedAt : 0,
          queueDepth: this.watchQueueDepth,
        });
        const watching =
          !this.purged &&
          this.sockets().some(
            ([, state]) => state.ticket.role !== 'runner' && state.ticket.userID === subject.userID
          );
        await phase(
          this.env,
          'relayWatch',
          'watch_rpc',
          () =>
            getPresenceStub(this.env, subject.userID).watch({
              tenant: subject.tenant,
              sessionID: subject.sessionID,
              watching,
            }),
          subject.tenant.type
        );
        const stillWatching =
          !this.purged &&
          this.sockets().some(
            ([, state]) => state.ticket.role !== 'runner' && state.ticket.userID === subject.userID
          );
        if (!watching && !stillWatching)
          syncPhase(
            this.env,
            'relayWatch',
            'watch_storage',
            () =>
              this.db.delete(relayWatches).where(eq(relayWatches.user_id, subject.userID)).run(),
            subject.tenant.type
          );
      })
      .catch(error => {
        diagnostic(this.env, {
          operation: 'relayWatch',
          stage: 'watch_queue',
          tenant: subject.tenant.type,
          outcome: 'error',
          error,
          queueDepth: this.watchQueueDepth,
        });
        console.error('Relay presence watch failed');
        for (const [ws, state] of this.sockets()) {
          if (state.ticket.role !== 'runner' && state.ticket.userID === subject.userID)
            this.control(ws, 'error', {
              code: 'watch_unavailable',
              message: 'Live publishing could not be enabled',
            });
        }
      })
      .finally(() => {
        this.watchQueueDepth--;
      });
    this.watchSerial = task;
    return task;
  }

  private trimRing(now: number): void {
    while (this.ring.length > 0) {
      const first = this.ring[0];
      if (
        !first ||
        (first.at > now - LIVE_LIMITS.ringMs && this.ringBytes <= LIVE_LIMITS.ringBytes)
      )
        break;
      this.ring.shift();
      this.ringBytes -= first.bytes;
      this.replayFloor = first.seq;
    }
  }

  /** Replays only what this socket has not received; true when its subscription changed. */
  private subscribe(ws: WebSocket, state: Attachment, afterSeq: number): boolean {
    this.trimRing(Date.now());
    const wasSubscribed = state.subscribed;
    state.subscribed = afterSeq >= this.replayFloor && afterSeq <= this.seq;
    this.saveAttachment(ws, state);
    if (afterSeq < this.replayFloor || afterSeq > this.seq) {
      this.control(ws, 'reset_required', { seq: this.seq });
      return wasSubscribed;
    }
    const cursor = Math.max(afterSeq, this.delivered.get(ws) ?? 0);
    let replayed = false;
    for (const entry of this.ring) {
      if (entry.seq <= cursor) continue;
      if (!this.sendEncoded(ws, state, entry.encoded)) return false;
      replayed = true;
    }
    this.delivered.set(ws, this.seq);
    this.control(ws, 'subscribed', { seq: this.seq, cursor });
    return !wasSubscribed || replayed;
  }

  private sendEncoded(ws: WebSocket, state: Attachment, encoded: string): boolean {
    try {
      ws.send(encoded);
      return true;
    } catch {
      this.close(ws, state, 1011, 'Event delivery failed');
      return false;
    }
  }

  private publish(ws: WebSocket, ticket: LiveTicket, event: z.infer<typeof eventSchema>): void {
    if (this.seq >= Number.MAX_SAFE_INTEGER) {
      this.control(ws, 'error', { code: 'sequence_exhausted' });
      return;
    }
    const at = Date.now();
    const seq = this.seq + 1;
    const encoded = JSON.stringify({
      v: 1,
      channel: 'events',
      seq,
      from: ticket.userID,
      at,
      type: event.type,
      body: event.body,
    });
    const bytes = encoder.encode(encoded).byteLength;
    if (bytes > LIVE_LIMITS.messageBytes) {
      this.control(ws, 'error', { code: 'message_too_large' });
      return;
    }
    if (seq > this.ceiling) {
      const ceiling = Math.min(Number.MAX_SAFE_INTEGER, this.ceiling + sequenceBlock);
      this.db.update(relayState).set({ seq: ceiling }).where(eq(relayState.id, 1)).run();
      this.ceiling = ceiling;
    }
    this.seq = seq;
    this.ring.push({ seq, at, encoded, bytes });
    this.ringBytes += bytes;
    this.trimRing(at);
    let fanout = 0;
    for (const [viewer, state] of this.sockets()) {
      if (state.ticket.role !== 'runner' && state.subscribed) {
        if (!this.sendEncoded(viewer, state, encoded)) continue;
        this.delivered.set(viewer, seq);
        fanout++;
      }
    }
    liveMetric(this.env, {
      route: 'relay.events',
      role: 'runner',
      bytes,
      fanout,
      latencyMs: Date.now() - at,
    });
  }

  private acceptCommand(ticket: LiveTicket, input: unknown): Response {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) return error(400, 'invalid_request', 'Invalid command frame');
    const command = parsed.data;
    const payload = JSON.stringify(command.body);
    const bytes = encoder.encode(JSON.stringify(command)).byteLength;
    // Reserve envelope overhead too, so accepted payloads always fit the runner's wire bound.
    const envelope = this.commandEnvelope({
      command_id: command.commandID,
      from: ticket.userID,
      type: command.type,
      payload,
      expires_at: Date.now() + (command.ttlMs ?? LIVE_LIMITS.mailboxDefaultMs),
      live_only: command.liveOnly ?? false,
      created_at: Date.now(),
    });
    if (
      bytes > LIVE_LIMITS.messageBytes ||
      encoder.encode(JSON.stringify({ ...envelope, seq: Number.MAX_SAFE_INTEGER })).byteLength >
        LIVE_LIMITS.messageBytes
    )
      return error(413, 'message_too_large', 'Command exceeds the relay limit');
    const prior = this.db
      .select()
      .from(relayCommands)
      .where(eq(relayCommands.command_id, command.commandID))
      .get();
    if (prior) return Response.json({ commandID: command.commandID, status: prior.status });
    const runner = this.runner();
    if (command.liveOnly && !runner)
      return error(409, 'runner_offline', 'This command requires a connected runner');
    const active = this.db
      .select({ items: count(), bytes: sum(relayCommands.bytes) })
      .from(relayCommands)
      .where(isNotNull(relayCommands.payload))
      .get();
    if (
      (active?.items ?? 0) >= LIVE_LIMITS.mailboxItems ||
      Number(active?.bytes ?? 0) + bytes > LIVE_LIMITS.mailboxBytes
    )
      return error(503, 'service_overloaded', 'The command mailbox is full');
    this.makeReceiptRoom();
    const now = Date.now();
    this.db
      .insert(relayCommands)
      .values({
        command_id: command.commandID,
        from: ticket.userID,
        type: command.type,
        payload,
        bytes,
        live_only: command.liveOnly ?? false,
        created_at: now,
        expires_at: now + (command.ttlMs ?? LIVE_LIMITS.mailboxDefaultMs),
        delivered_at: null,
        status: 'queued',
        finished_at: null,
      })
      .run();
    const row = this.db
      .select()
      .from(relayCommands)
      .where(eq(relayCommands.command_id, command.commandID))
      .get();
    const delivered = Boolean(runner && row && this.deliverCommand(runner, row));
    liveMetric(this.env, {
      route: 'relay.commands',
      role: ticket.role,
      bytes,
      fanout: runner ? 1 : 0,
    });
    return Response.json({
      commandID: command.commandID,
      status: delivered ? 'delivered' : 'queued',
    });
  }

  private commandEnvelope(
    row: Pick<
      CommandRow,
      'command_id' | 'from' | 'type' | 'payload' | 'expires_at' | 'live_only' | 'created_at'
    >
  ) {
    const payload: unknown = row.payload === null ? null : JSON.parse(row.payload);
    if (!isBoundedJson(payload)) throw new Error('Invalid stored relay command payload');
    return {
      v: 1,
      channel: 'commands',
      seq: this.seq,
      from: row.from,
      at: row.created_at,
      type: row.type,
      body: {
        commandID: row.command_id,
        payload,
        expiresAt: new Date(row.expires_at).toISOString(),
        liveOnly: row.live_only,
      },
    };
  }

  private deliverCommand(ws: WebSocket, row: CommandRow): boolean {
    if (!send(ws, this.commandEnvelope(row))) {
      const state = this.attachment(ws);
      if (state && !state.closed) this.close(ws, state, 1011, 'Command delivery failed');
      return false;
    }
    this.db
      .update(relayCommands)
      .set({
        status: 'delivered',
        delivered_at: row.delivered_at ?? Date.now(),
      })
      .where(eq(relayCommands.command_id, row.command_id))
      .run();
    if (row.status !== 'delivered')
      this.broadcastControl('command_status', { commandID: row.command_id, status: 'delivered' });
    return true;
  }

  private deliverMailbox(ws: WebSocket): void {
    const rows = this.db
      .select()
      .from(relayCommands)
      .where(isNotNull(relayCommands.payload))
      .orderBy(asc(relayCommands.ordinal))
      .all();
    for (const row of rows) {
      if (!this.attachment(ws)?.closed) this.deliverCommand(ws, row);
    }
  }

  private ack(commandID: string): void {
    const row = this.db
      .update(relayCommands)
      .set({ status: 'delivered', payload: null, bytes: 0, finished_at: Date.now() })
      .where(
        and(
          eq(relayCommands.command_id, commandID),
          eq(relayCommands.status, 'delivered'),
          isNotNull(relayCommands.payload)
        )
      )
      .returning()
      .get();
    if (row) this.broadcastControl('command_status', { commandID, status: 'delivered' });
  }

  private makeReceiptRoom(): void {
    const total = this.db.select({ items: count() }).from(relayCommands).get()?.items ?? 0;
    if (total < LIVE_LIMITS.mailboxItems) return;
    const finished = this.db
      .select({ ordinal: relayCommands.ordinal })
      .from(relayCommands)
      .where(isNull(relayCommands.payload))
      .orderBy(asc(relayCommands.finished_at))
      .limit(total - LIVE_LIMITS.mailboxItems + 1)
      .all();
    for (const row of finished)
      this.db.delete(relayCommands).where(eq(relayCommands.ordinal, row.ordinal)).run();
  }

  private expireLiveOnly(): void {
    const expired = this.db
      .update(relayCommands)
      .set({ status: 'expired', payload: null, bytes: 0, finished_at: Date.now() })
      .where(and(eq(relayCommands.status, 'queued'), eq(relayCommands.live_only, true)))
      .returning({ commandID: relayCommands.command_id })
      .all();
    for (const row of expired)
      this.broadcastControl('command_status', { commandID: row.commandID, status: 'expired' });
    this.db
      .update(relayCommands)
      .set({ payload: null, bytes: 0, finished_at: Date.now() })
      .where(
        and(
          eq(relayCommands.status, 'delivered'),
          eq(relayCommands.live_only, true),
          isNotNull(relayCommands.payload)
        )
      )
      .run();
  }

  private sweep(): void {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.attachment(ws);
      if (state && !state.closed && state.ticket.exp * 1000 <= now)
        this.close(ws, state, 1008, 'Relay ticket expired');
    }
    if (!this.runner()) this.expireLiveOnly();
    const expired = this.db
      .update(relayCommands)
      .set({ status: 'expired', payload: null, bytes: 0, finished_at: now })
      .where(and(eq(relayCommands.status, 'queued'), lte(relayCommands.expires_at, now)))
      .returning({ commandID: relayCommands.command_id })
      .all();
    for (const row of expired)
      this.broadcastControl('command_status', { commandID: row.commandID, status: 'expired' });
    this.db
      .update(relayCommands)
      .set({ payload: null, bytes: 0, finished_at: now })
      .where(
        and(
          eq(relayCommands.status, 'delivered'),
          isNotNull(relayCommands.payload),
          lte(relayCommands.expires_at, now)
        )
      )
      .run();
    this.db
      .delete(relayCommands)
      .where(and(isNull(relayCommands.payload), lte(relayCommands.finished_at, now - receiptMs)))
      .run();
    this.db
      .delete(relayRates)
      .where(lt(relayRates.window, Math.floor(now / 60_000)))
      .run();
    this.trimRing(now);
  }

  private async schedule(): Promise<void> {
    const now = Date.now();
    let next = Number.POSITIVE_INFINITY;
    for (const [, state] of this.sockets()) {
      if (state.ticket.role === 'runner') continue;
      next = Math.min(next, state.ticket.exp * 1000);
      if (!state.reauthNotified)
        next = Math.min(next, Math.max(now + 1, state.ticket.exp * 1000 - LIVE_LIMITS.heartbeatMs));
    }
    if (this.db.select().from(relayWatches).limit(1).get())
      next = Math.min(next, this.watchRefreshAt);
    const queued = this.db
      .select({ at: relayCommands.expires_at })
      .from(relayCommands)
      .where(isNotNull(relayCommands.payload))
      .orderBy(asc(relayCommands.expires_at))
      .limit(1)
      .get();
    const finished = this.db
      .select({ at: relayCommands.finished_at })
      .from(relayCommands)
      .where(isNotNull(relayCommands.finished_at))
      .orderBy(asc(relayCommands.finished_at))
      .limit(1)
      .get();
    if (queued) next = Math.min(next, queued.at);
    if (finished?.at !== null && finished?.at !== undefined)
      next = Math.min(next, finished.at + receiptMs);
    const rates = this.db.select().from(relayRates).limit(1).get();
    if (rates) next = Math.min(next, (rates.window + 1) * 60_000);
    const deadline = Number.isFinite(next) ? Math.max(now + 1, next) : null;
    if (deadline === this.alarmAt) return;
    this.alarmAt = deadline;
    if (deadline === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(deadline);
  }
}

export function getRelayStub(
  env: Pick<Env, 'SESSION_RELAY_DO'>,
  tenant: Tenant,
  sessionID: string
) {
  const name = JSON.stringify([tenant.type, tenant.id, sessionID]);
  return env.SESSION_RELAY_DO.get(env.SESSION_RELAY_DO.idFromName(name));
}
