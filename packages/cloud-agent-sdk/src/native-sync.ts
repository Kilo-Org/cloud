import { z } from 'zod';
import {
  fetchNativeSnapshot,
  type NativeMessage,
  type NativeSnapshot,
} from './native-sync-snapshot';
import { cloudAgentSdkRuntime } from './runtime';

const tenantSchema = z.object({ type: z.enum(['user', 'organization']), id: z.string() });
const envelopeSchema = z.object({
  v: z.literal(1),
  channel: z.enum(['events', 'commands', 'control']),
  seq: z.number().int().nonnegative(),
  from: z.string(),
  at: z.number(),
  type: z.string(),
  body: z.unknown(),
});
const ticketSchema = z.object({ ticket: z.string(), expiresAt: z.iso.datetime() });
const grantSchema = z.object({ token: z.string(), expiresAt: z.iso.datetime() });
const commandStatusSchema = z.enum(['queued', 'delivered', 'expired']);
const instanceSchema = z.object({
  instanceID: z.string(),
  tenant: tenantSchema,
  online: z.boolean(),
  advertisement: z
    .object({
      name: z.string(),
      projectName: z.string(),
      kind: z.string(),
      sessions: z.array(z.string()),
    })
    .passthrough(),
});
const listSchema = z.object({
  items: z.array(
    z.object({
      sessionID: z.string(),
      tenant: tenantSchema,
      createdAt: z.number(),
      live: z.boolean(),
    })
  ),
  cursor: z.string().nullable(),
});
export type NativeEvent = z.infer<typeof envelopeSchema>;
export type NativeSessionSummary = z.infer<typeof listSchema>['items'][number];
export type NativeConnection = 'connecting' | 'connected' | 'disconnected';
export type NativePresenceState = {
  connection: NativeConnection;
  instances: z.infer<typeof instanceSchema>[];
  error?: string | undefined;
};
export type NativeSessionState = {
  connection: NativeConnection;
  runnerConnected: boolean;
  messages: NativeMessage[];
  events: NativeEvent[];
  commands: Record<string, 'queued' | 'delivered' | 'expired'>;
  error?: string | undefined;
};
export type NativeInstanceReply = {
  commandID: string;
  instanceID: string;
  status: 'replied' | 'unknown';
  body?: unknown;
};
export type NativeInstanceCommand =
  | 'create_session'
  | 'list_directories'
  | 'list_models'
  | 'list_agents';
export type NativePresenceConnection = {
  command(
    instanceID: string,
    type: NativeInstanceCommand,
    body?: unknown
  ): Promise<NativeInstanceReply>;
  close(): void;
};
export type NativeSessionConnection = {
  sendMessage(
    text: string,
    options?: { queueIfOffline?: boolean; ttlMs?: number }
  ): Promise<string>;
  interrupt(): Promise<string>;
  respondPermission(requestID: string, reply: 'once' | 'always' | 'reject'): Promise<string>;
  replyQuestion(requestID: string, answers: string[][]): Promise<string>;
  rejectQuestion(requestID: string): Promise<string>;
  sendCommand(command: string, args?: string): Promise<string>;
  getCommandStatus(commandID: string): Promise<'queued' | 'delivered' | 'expired'>;
  clear(): void;
  close(): void;
};
export type NativeSocket = {
  readyState: number;
  onopen: WebSocket['onopen'];
  onmessage: WebSocket['onmessage'];
  onclose: WebSocket['onclose'];
  onerror: WebSocket['onerror'];
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export type NativeSocketConstructor = new (url: string, protocols: string[]) => NativeSocket;
export type NativeSyncOptions = {
  baseUrl: string;
  getCredential: () => Promise<string>;
  fetch?: typeof fetch;
  WebSocket?: NativeSocketConstructor;
};
export class NativeSyncError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    public readonly retryAfterMs = 0
  ) {
    super(code);
    this.name = 'NativeSyncError';
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const reason = (error: unknown) =>
  error instanceof Error ? error['message'] : 'Native connection failed';
/**
 * Authorization failures and deleted sessions cannot recover by reconnecting. A 404 stays
 * retryable: a just-created session is briefly unknown until its runner registers it.
 */
const isPermanent = (error: unknown) =>
  (error instanceof NativeSyncError && (error.status === 401 || error.status === 403)) ||
  (error instanceof Error && 'code' in error && error.code === 'session_deleted');

// Count UTF-16 storage conservatively for raw frames and retained parsed replay.
const liveFrameBytes = 512 * 1024;
const liveBacklogBytes = 4 * 1024 * 1024;
const liveBacklogCount = 1024;
type SocketEpoch = {
  signal: AbortSignal;
  current: () => boolean;
  retain: (bytes: number) => boolean;
  release: (bytes: number) => void;
  fail: (error: unknown) => void;
};

/** Native v2 only. The legacy session-ingest/cloud-agent transport is deliberately unchanged. */
export class NativeSyncClient {
  private readonly fetcher: typeof fetch;
  private readonly socketConstructor: NativeSocketConstructor;
  private readonly grants = new Map<string, Promise<z.infer<typeof grantSchema>>>();
  constructor(private readonly options: NativeSyncOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.socketConstructor = options.WebSocket ?? globalThis.WebSocket;
  }
  private async grant(organizationID?: string) {
    const key = organizationID ?? '';
    const existing = this.grants.get(key);
    if (existing) {
      const grant = await existing;
      if (Date.parse(grant.expiresAt) > Date.now() + 30_000) return grant;
    }
    const pending = (async () => {
      const credential = await this.options.getCredential();
      return grantSchema.parse(
        await this.json('/v1/auth/exchange', {
          method: 'POST',
          headers: { Authorization: `Bearer ${credential}` },
          body: JSON.stringify({ version: 1, ...(organizationID ? { organizationID } : {}) }),
        })
      );
    })();
    this.grants.set(key, pending);
    try {
      return await pending;
    } catch (error) {
      this.grants.delete(key);
      throw error;
    }
  }
  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetcher(new URL(path, this.options.baseUrl).href, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    if (!response.ok) {
      const body = record(await response.json().catch(() => null));
      const error = record(body['error']);
      const retry = response.headers.get('Retry-After');
      const retryAfterMs = retry
        ? /^\d+$/.test(retry)
          ? Number(retry) * 1000
          : Math.max(0, Date.parse(retry) - Date.now())
        : 0;
      throw new NativeSyncError(
        typeof error['code'] === 'string' ? error['code'] : `HTTP ${response.status}`,
        response.status,
        retryAfterMs
      );
    }
    return response.json();
  }
  async request<T>(path: string, init?: RequestInit, organizationID?: string): Promise<T> {
    const grant = await this.grant(organizationID);
    if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
    try {
      // Snapshot parsing lives at the snapshot boundary; all other callers validate their responses below.
      return (await this.json(path, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${grant.token}` },
      })) as T;
    } catch (error) {
      if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
      if (!(error instanceof NativeSyncError) || error['status'] !== 401) throw error;
      this.grants.delete(organizationID ?? '');
      const renewed = await this.grant(organizationID);
      if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
      return (await this.json(path, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${renewed.token}` },
      })) as T;
    }
  }
  async listSessions(cursor?: string) {
    return listSchema.parse(
      await this.request(
        `/v1/sessions?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
      )
    );
  }
  private socket(
    path: string,
    ticketPath: string,
    organizationID: string | undefined,
    onFrame: (
      frame: NativeEvent,
      send: (value: unknown) => boolean,
      epoch: SocketEpoch,
      bytes: number
    ) => Promise<void> | void,
    onConnection: (state: NativeConnection, error?: string) => void
  ) {
    let stopped = false;
    let socket: NativeSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAfterMs = 1000;
    let generation = 0;
    let retire: (() => void) | undefined;
    const send = (value: unknown) => {
      if (stopped || socket?.readyState !== 1) return false;
      socket.send(JSON.stringify(value));
      return true;
    };
    const mint = async () =>
      ticketSchema.parse(
        await this.request(
          ticketPath,
          {
            method: 'POST',
            body: JSON.stringify({ role: 'controller' }),
          },
          organizationID
        )
      );
    const scheduleRenewal = (body: Record<string, unknown>) => {
      clearTimeout(renewalTimer);
      const deadline =
        typeof body['reauthAt'] === 'string'
          ? Date.parse(body['reauthAt'])
          : typeof body['expiresAt'] === 'string'
            ? Date.parse(body['expiresAt']) - 30_000
            : NaN;
      if (!Number.isFinite(deadline)) return;
      const current = generation;
      renewalTimer = setTimeout(
        () => {
          void mint()
            .then(ticket => {
              if (current === generation && !stopped)
                send({ type: 'reauth', ticket: ticket.ticket });
            })
            .catch((error: unknown) => {
              if (current === generation && !stopped) reconnect(error);
            });
        },
        Math.max(0, deadline - Date.now())
      );
    };
    const reconnect = (error?: unknown) => {
      if (stopped) return;
      generation++;
      retire?.();
      retire = undefined;
      clearTimeout(renewalTimer);
      socket?.close();
      socket = undefined;
      onConnection('disconnected', error ? reason(error) : undefined);
      if (isPermanent(error)) {
        stopped = true;
        return;
      }
      clearTimeout(reconnectTimer);
      const retry = error instanceof NativeSyncError ? error['retryAfterMs'] : 0;
      reconnectTimer = setTimeout(
        () => {
          void connect();
        },
        Math.max(retry, reconnectAfterMs) + Math.random() * reconnectAfterMs
      );
    };
    const connect = async () => {
      if (stopped) return;
      const current = ++generation;
      const controller = new AbortController();
      const queue: { data: string; bytes: number }[] = [];
      let retainedBytes = 0;
      let retainedCount = 0;
      let draining = false;
      const epoch: SocketEpoch = {
        signal: controller.signal,
        current: () => !stopped && current === generation && !controller.signal.aborted,
        retain: bytes => {
          if (
            !epoch.current() ||
            retainedCount >= liveBacklogCount ||
            retainedBytes + bytes > liveBacklogBytes
          )
            return false;
          retainedCount++;
          retainedBytes += bytes;
          return true;
        },
        release: bytes => {
          retainedCount--;
          retainedBytes -= bytes;
        },
        fail: error => {
          if (epoch.current()) reconnect(error);
        },
      };
      retire = () => {
        for (const item of queue) epoch.release(item.bytes);
        queue.length = 0;
        controller.abort();
      };
      onConnection('connecting');
      try {
        const ticket = await mint();
        if (!epoch.current()) return;
        const url = new URL(path, this.options.baseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const next = new this.socketConstructor(url.href, [`kilo-session-ticket.${ticket.ticket}`]);
        socket = next;
        const sendCurrent = (value: unknown) => epoch.current() && send(value);
        const drain = async () => {
          if (draining) return;
          draining = true;
          try {
            while (epoch.current() && queue.length > 0) {
              const item = queue.shift();
              if (!item) return;
              epoch.release(item.bytes);
              const frame = envelopeSchema.parse(JSON.parse(item.data));
              item.data = '';
              if (frame.channel === 'control') {
                const body = record(frame.body);
                if (frame.type === 'hello') {
                  if (typeof body['reconnectAfterMs'] === 'number')
                    reconnectAfterMs = Math.min(60_000, Math.max(1000, body['reconnectAfterMs']));
                  onConnection('connected');
                  scheduleRenewal(body);
                }
                if (frame.type === 'reauth_required') {
                  const ticket = await mint();
                  if (!epoch.current()) return;
                  sendCurrent({ type: 'reauth', ticket: ticket.ticket });
                }
                if (frame.type === 'reauthorized') scheduleRenewal(body);
              }
              await onFrame(frame, sendCurrent, epoch, item.bytes);
            }
          } catch (error) {
            epoch.fail(error);
          } finally {
            draining = false;
          }
        };
        next.onerror = () => {
          if (epoch.current()) next.close();
        };
        next.onclose = () => epoch.fail(undefined);
        next.onmessage = event => {
          if (!epoch.current() || typeof event['data'] !== 'string') return;
          const data = event['data'];
          const bytes = data.length * 2;
          if (bytes > liveFrameBytes || !epoch.retain(bytes)) {
            epoch.fail(
              new NativeSyncError(
                bytes > liveFrameBytes ? 'live_frame_too_large' : 'live_backlog_overflow'
              )
            );
            return;
          }
          queue.push({ data, bytes });
          void drain();
        };
      } catch (error) {
        epoch.fail(error);
      }
    };
    void connect();
    return {
      send,
      close: () => {
        stopped = true;
        generation++;
        retire?.();
        retire = undefined;
        clearTimeout(reconnectTimer);
        clearTimeout(renewalTimer);
        socket?.close();
        socket = undefined;
      },
    };
  }
  connectPresence(
    listener: (state: NativePresenceState) => void,
    organizationID?: string
  ): NativePresenceConnection {
    let state: NativePresenceState = { connection: 'connecting', instances: [] };
    const pending = new Map<
      string,
      {
        resolve: (value: NativeInstanceReply) => void;
        timer: ReturnType<typeof setTimeout>;
        instanceID: string;
      }
    >();
    const publish = (patch: Partial<NativePresenceState>) => {
      state = { ...state, ...patch };
      listener(state);
    };
    const settleUnknown = () => {
      for (const [commandID, call] of pending) {
        clearTimeout(call.timer);
        call.resolve({ commandID, instanceID: call.instanceID, status: 'unknown' });
      }
      pending.clear();
    };
    const connection = this.socket(
      '/v1/presence',
      '/v1/presence/ticket',
      organizationID,
      (frame, send) => {
        if (frame.channel !== 'control') return;
        const body = record(frame.body);
        if (frame.type === 'hello') send({ type: 'subscribe' });
        if (frame.type === 'instances')
          publish({ instances: z.array(instanceSchema).parse(body['instances']) });
        if (
          frame.type === 'reply' ||
          (frame.type === 'command_status' && body['status'] === 'unknown')
        ) {
          if (typeof body['commandID'] !== 'string') return;
          const call = pending.get(body['commandID']);
          if (!call || body['instanceID'] !== call.instanceID) return;
          clearTimeout(call.timer);
          pending.delete(body['commandID']);
          call.resolve({
            commandID: body['commandID'],
            instanceID: call.instanceID,
            status: frame.type === 'reply' ? 'replied' : 'unknown',
            body: body['payload'],
          });
        }
        if (frame.type === 'error')
          publish({
            error: typeof body['code'] === 'string' ? body['code'] : 'Presence command failed',
          });
      },
      (connection, error) => {
        if (connection === 'disconnected') settleUnknown();
        publish({ connection, error, ...(connection === 'disconnected' ? { instances: [] } : {}) });
      }
    );
    return {
      command: (instanceID: string, type: NativeInstanceCommand, body: unknown = {}) => {
        if (
          state.connection !== 'connected' ||
          !state.instances.some(entry => entry.instanceID === instanceID && entry.online)
        ) {
          return Promise.reject<NativeInstanceReply>(new NativeSyncError('instance_offline'));
        }
        const commandID = cloudAgentSdkRuntime.randomUUID();
        // ES2022/Hermes consumers do not provide Promise.withResolvers.
        return new Promise<NativeInstanceReply>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(commandID);
            resolve({ commandID, instanceID, status: 'unknown' });
          }, 10_000);
          pending.set(commandID, { resolve, timer, instanceID });
          if (!connection.send({ channel: 'commands', type, instanceID, commandID, body })) {
            clearTimeout(timer);
            pending.delete(commandID);
            reject(new NativeSyncError('instance_offline'));
          }
        });
      },
      close: () => {
        connection.close();
        settleUnknown();
      },
    };
  }
  connectSession(
    sessionID: string,
    listener: (state: NativeSessionState) => void,
    organizationID?: string
  ): NativeSessionConnection {
    const path = `/v1/sessions/${encodeURIComponent(sessionID)}`;
    let state: NativeSessionState = {
      connection: 'connecting',
      runnerConnected: false,
      messages: [],
      events: [],
      commands: {},
    };
    let lastSeq: number | undefined;
    let snapshotPosition = -1;
    let identity: { incarnation: string; runID?: string } | undefined;
    let closed = false;
    type Recovery = {
      attempt: number;
      replay: { frame: NativeEvent; bytes: number }[];
      cancel: () => void;
    };
    let recovery: Recovery | undefined;
    let integrityError: string | undefined;
    let failureError: string | undefined;
    let integrityGap = false;
    let remoteState: NativeEvent | undefined;
    const clearedIDs = new Set<string>();
    const publish = (patch: Partial<NativeSessionState>) => {
      if (closed) return;
      if ('error' in patch) failureError = patch.error;
      const error =
        integrityError && failureError && integrityError !== failureError
          ? `${integrityError} ${failureError}`
          : (integrityError ?? failureError);
      state = { ...state, ...patch, error };
      listener(state);
    };
    const visible = (messages: NativeMessage[]) =>
      clearedIDs.size === 0 ? messages : messages.filter(message => !clearedIDs.has(message.id));
    const beyond = (frame: NativeEvent, position: number) => {
      const syncPosition = record(frame.body)['syncPosition'];
      const ephemeral = frame.type.endsWith('.delta') || frame.type === 'session.tool.progress';
      return (
        typeof syncPosition !== 'number' ||
        syncPosition > position ||
        (ephemeral && syncPosition === position)
      );
    };
    const readSnapshot = (epoch: SocketEpoch, signal = epoch.signal) =>
      fetchNativeSnapshot(
        <T>(route: string, init?: RequestInit) => this.request<T>(route, init, organizationID),
        sessionID,
        signal
      );
    const snapshot = async (epoch: SocketEpoch) => {
      const next = await readSnapshot(epoch);
      if (!epoch.current() || next.position < snapshotPosition) return;
      snapshotPosition = next.position;
      publish({ messages: visible(next.messages) });
    };
    const markGap = () => {
      integrityGap = true;
      integrityError = 'Native transcript may be incomplete because live replay is unavailable.';
      publish({});
    };
    const recoverIncomplete = (epoch: SocketEpoch) => {
      if (recovery || !epoch.current() || !state.messages.some(message => message.incomplete))
        return;
      const controller = new AbortController();
      const current: Recovery = {
        attempt: 0,
        replay: [],
        cancel: () => {
          if (current.replay.length > 0) markGap();
          dispose();
        },
      };
      recovery = current;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      const dispose = () => {
        clearTimeout(timer);
        controller.abort();
        wake?.();
        for (const item of current.replay) epoch.release(item.bytes);
        current.replay.length = 0;
        if (recovery === current) recovery = undefined;
      };
      epoch.signal.addEventListener('abort', current.cancel, { once: true });
      void (async () => {
        for (;;) {
          // ES2022/Hermes consumers do not provide Promise.withResolvers.
          await new Promise<void>(resolve => {
            wake = resolve;
            timer = setTimeout(resolve, 250 * 2 ** current.attempt++);
          });
          if (!epoch.current() || recovery !== current) return;
          let next: NativeSnapshot;
          try {
            next = await readSnapshot(epoch, controller.signal);
          } catch (error) {
            if (!epoch.current() || recovery !== current) return;
            if (isPermanent(error)) {
              epoch.fail(error);
              return;
            }
            if (current.attempt >= 4) {
              integrityError = `Native transcript recovery is incomplete: ${reason(error)}`;
              publish({});
              return;
            }
            continue;
          }
          if (!epoch.current() || recovery !== current) return;
          const stale = next.position < snapshotPosition;
          let messages = next.messages;
          for (const item of current.replay)
            if (beyond(item.frame, next.position))
              messages = applyNativeEvent(messages, item.frame);
          if (!stale) {
            snapshotPosition = next.position;
            publish({ messages: visible(messages) });
          }
          // A stale snapshot cannot prune replay needed by a later consistent read.
          if (!stale) {
            current.replay = current.replay.filter(item => {
              if (beyond(item.frame, next.position)) return true;
              epoch.release(item.bytes);
              return false;
            });
          }
          if (!state.messages.some(item => item.incomplete)) {
            if (!integrityGap) {
              integrityError = undefined;
              publish({ error: undefined });
            }
            return;
          }
          if (current.attempt >= 4) {
            integrityError = 'Native transcript recovery is incomplete.';
            publish({});
            return;
          }
        }
      })()
        .catch((error: unknown) => {
          if (epoch.current() && recovery === current) publish({ error: reason(error) });
        })
        .finally(() => {
          epoch.signal.removeEventListener('abort', current.cancel);
          dispose();
        });
    };
    const connection = this.socket(
      `${path}/live`,
      `${path}/live-ticket`,
      organizationID,
      async (frame, send, epoch, bytes) => {
        const body = record(frame.body);
        if (frame.channel === 'control') {
          if (frame.type === 'hello') {
            publish({ runnerConnected: body['runnerConnected'] === true });
            if (lastSeq === undefined) {
              await snapshot(epoch);
              if (!epoch.current()) return;
              lastSeq = frame.seq;
            }
            send({ type: 'subscribe', afterSeq: lastSeq });
            recoverIncomplete(epoch);
          }
          if (frame.type === 'reset_required') {
            markGap();
            recovery?.cancel();
            await snapshot(epoch);
            if (!epoch.current()) return;
            lastSeq = typeof body['seq'] === 'number' ? body['seq'] : frame.seq;
            send({ type: 'subscribe', afterSeq: lastSeq });
            recoverIncomplete(epoch);
          }
          if (
            frame.type === 'subscribed' &&
            !integrityGap &&
            !state.messages.some(message => message.incomplete)
          ) {
            integrityError = undefined;
            publish({ error: undefined });
          }
          if (frame.type === 'runner_status') {
            if (body['runnerConnected'] !== true) identity = undefined;
            publish({ runnerConnected: body['runnerConnected'] === true });
          }
          if (frame.type === 'command_status' && typeof body['commandID'] === 'string') {
            const parsed = commandStatusSchema.safeParse(body['status']);
            if (parsed.success)
              publish({ commands: { ...state.commands, [body['commandID']]: parsed.data } });
          }
          if (frame.type === 'error')
            publish({
              error: typeof body['code'] === 'string' ? body['code'] : 'Session command failed',
            });
          return;
        }
        if (frame.channel !== 'events' || (lastSeq !== undefined && frame.seq <= lastSeq)) return;
        if (recovery) {
          if (!epoch.retain(bytes)) {
            epoch.fail(new NativeSyncError('live_backlog_overflow'));
            return;
          }
          recovery.replay.push({ frame, bytes });
        }
        lastSeq = frame.seq;
        if (typeof body['incarnation'] === 'string')
          identity = {
            incarnation: body['incarnation'],
            ...(typeof body['runID'] === 'string' ? { runID: body['runID'] } : {}),
          };
        if (frame.type === 'remote.state') remoteState = frame;
        const recent =
          frame.type === 'remote.state'
            ? []
            : state.events.filter(event => event['type'] !== 'remote.state').slice(-498);
        const events =
          frame.type === 'remote.state'
            ? [frame]
            : [...(remoteState ? [remoteState] : []), ...recent, frame];
        publish({
          events,
          messages: beyond(frame, snapshotPosition)
            ? visible(applyNativeEvent(state.messages, frame))
            : state.messages,
        });
        if (
          frame.type.startsWith('session.execution.') &&
          frame.type !== 'session.execution.started'
        )
          recoverIncomplete(epoch);
      },
      (connection, error) => {
        const backlog = error === 'live_backlog_overflow' || error === 'live_frame_too_large';
        if (backlog) {
          if (lastSeq === undefined) integrityGap = true;
          const exceeded =
            error === 'live_frame_too_large'
              ? 'live frame exceeded the size limit'
              : 'live backlog exceeded the limit';
          integrityError = integrityGap
            ? `Native transcript may be incomplete because its ${exceeded}.`
            : `Native ${exceeded}. Recovering ordered replay.`;
        }
        publish({
          connection,
          error: backlog ? undefined : error,
          ...(connection !== 'connected' ? { runnerConnected: false } : {}),
        });
      }
    );
    const command = async (
      type: string,
      body: unknown,
      options: { liveOnly?: boolean; ttlMs?: number } = {}
    ) => {
      if (closed) throw new NativeSyncError('connection_closed');
      if (options.liveOnly && (state.connection !== 'connected' || !state.runnerConnected))
        throw new NativeSyncError('runner_offline');
      const commandID = cloudAgentSdkRuntime.randomUUID();
      const result = z.object({ commandID: z.string(), status: commandStatusSchema }).parse(
        await this.request(
          `${path}/commands`,
          {
            method: 'POST',
            body: JSON.stringify({ channel: 'commands', commandID, type, body, ...options }),
          },
          organizationID
        )
      );
      publish({ commands: { ...state.commands, [result.commandID]: result.status } });
      return result.commandID;
    };
    const live = (type: string, body: Record<string, unknown> = {}) => {
      if (!identity?.runID)
        return Promise.reject<string>(new NativeSyncError('active_run_unknown'));
      return command(type, { ...body, ...identity }, { liveOnly: true });
    };
    return {
      sendMessage: (text: string, options: { queueIfOffline?: boolean; ttlMs?: number } = {}) => {
        if (!text.trim()) return Promise.reject<string>(new NativeSyncError('empty_message'));
        return command(
          'send_message',
          { text },
          {
            liveOnly: !options.queueIfOffline,
            ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
          }
        );
      },
      interrupt: () => live('interrupt'),
      respondPermission: (requestID: string, reply: 'once' | 'always' | 'reject') =>
        live('permission_respond', { requestID, reply }),
      replyQuestion: (requestID: string, answers: string[][]) =>
        live('question_reply', { requestID, answers }),
      rejectQuestion: (requestID: string) => live('question_reject', { requestID }),
      sendCommand: (input: string, args?: string) => {
        const name = input.trim().replace(/^\//, '').split(/\s+/, 1)[0];
        if (name === 'clear') {
          for (const message of state.messages) clearedIDs.add(message.id);
          publish({ messages: [] });
          return Promise.resolve('local-clear');
        }
        if (!['compact', 'new', 'skill', 'models', 'agents'].includes(name ?? ''))
          return Promise.reject<string>(new NativeSyncError('unsafe_command'));
        return command(
          'send_command',
          { command: input, ...(args === undefined ? {} : { args }) },
          { liveOnly: true }
        );
      },
      getCommandStatus: async (commandID: string) => {
        const result = z
          .object({ commandID: z.string(), status: commandStatusSchema })
          .parse(
            await this.request(
              `${path}/commands/${encodeURIComponent(commandID)}`,
              undefined,
              organizationID
            )
          );
        publish({ commands: { ...state.commands, [result.commandID]: result.status } });
        return result.status;
      },
      clear: () => {
        for (const message of state.messages) clearedIDs.add(message.id);
        publish({ messages: [] });
      },
      close: () => {
        closed = true;
        connection.close();
        recovery?.cancel();
        state = { ...state, messages: [], events: [], commands: {} };
        clearedIDs.clear();
        remoteState = undefined;
        identity = undefined;
      },
    };
  }
}

/** Projects native public events, not the unrelated v1 transcript format. */
export function applyNativeEvent(messages: NativeMessage[], frame: NativeEvent): NativeMessage[] {
  const event = record(record(frame.body)['data']);
  const data = record(event['data']);
  const messageID =
    typeof data['assistantMessageID'] === 'string'
      ? data['assistantMessageID']
      : frame.type === 'session.message.content.updated' && typeof data['messageID'] === 'string'
        ? data['messageID']
        : undefined;
  if (frame.type === 'session.step.started' && messageID) {
    if (messages.some(message => message.id === messageID)) return messages;
    return [...messages, { id: messageID, role: 'assistant', content: [], seq: frame.seq }];
  }
  if (frame.type === 'session.inbox.enqueued') {
    const item = record(data['item']);
    const payload = record(item['payload']);
    const text =
      item['type'] === 'user' && typeof payload['text'] === 'string' ? payload['text'] : undefined;
    const inboxID = typeof data['inboxID'] === 'string' ? data['inboxID'] : undefined;
    if (inboxID && text && !messages.some(entry => entry.id === inboxID))
      return [...messages, { id: inboxID, role: 'user', content: text, seq: frame.seq }];
  }
  if (!messageID) return messages;
  return messages.map(message => {
    if (message.id !== messageID) return message;
    const parts = Array.isArray(message['content'])
      ? message['content'].map(part => record(part))
      : [];
    const partOrdinals = message.partOrdinals
      ? [...message.partOrdinals]
      : parts.map((_, index) => index);
    const ordinal = typeof data['ordinal'] === 'number' ? data['ordinal'] : 0;
    const kind = frame.type.startsWith('session.reasoning.') ? 'reasoning' : 'text';
    if (/^session\.(text|reasoning)\.(started|delta|ended)$/.test(frame.type)) {
      let index = partOrdinals.indexOf(ordinal);
      if (index < 0) {
        index = parts.length;
        partOrdinals.push(ordinal);
      }
      const previous = record(parts[index]);
      parts[index] = {
        ...previous,
        type: kind,
        text: frame.type.endsWith('.started')
          ? ''
          : frame.type.endsWith('.ended')
            ? data['text']
            : `${typeof previous['text'] === 'string' ? previous['text'] : ''}${typeof data['delta'] === 'string' ? data['delta'] : ''}`,
      };
      const ordered = partOrdinals
        .map((ordinal, index) => ({ ordinal, part: parts[index] }))
        .sort((a, b) => a.ordinal - b.ordinal);
      return {
        ...message,
        content: ordered.map(item => item.part),
        partOrdinals: ordered.map(item => item.ordinal),
      };
    }
    if (frame.type.startsWith('session.tool.')) {
      let index = parts.findIndex(part => part['id'] === data['id']);
      if (index < 0) {
        index = parts.length;
        parts.push({ type: 'tool', id: data['id'], name: data['name'], state: {} });
        partOrdinals.push((partOrdinals.at(-1) ?? -1) + 1);
      }
      const previous = parts[index];
      if (!previous) return message;
      const part = { ...previous };
      parts[index] = part;
      const state = record(part['state']);
      if (frame.type === 'session.tool.input.delta')
        part['state'] = {
          ...state,
          status: 'streaming',
          input: `${typeof state['input'] === 'string' ? state['input'] : ''}${typeof data['delta'] === 'string' ? data['delta'] : ''}`,
        };
      else if (frame.type === 'session.tool.input.ended')
        part['state'] = { ...state, status: 'streaming', input: data['text'] };
      else if (frame.type === 'session.tool.called')
        part['state'] = { status: 'running', input: data['input'] };
      else if (frame.type === 'session.tool.success')
        part['state'] = {
          ...state,
          status: 'completed',
          content: data['content'],
          metadata: data['metadata'],
        };
      else if (frame.type === 'session.tool.failed')
        part['state'] = { ...state, status: 'error', error: data['error'] };
      else if (frame.type === 'session.tool.progress')
        part['state'] = { ...state, metadata: data['metadata'] };
      return { ...message, content: parts, partOrdinals };
    }
    if (frame.type === 'session.message.content.updated' && Array.isArray(data['content'])) {
      const { partOrdinals: _replaced, ...rest } = message;
      return { ...rest, content: data['content'] };
    }
    return message;
  });
}
