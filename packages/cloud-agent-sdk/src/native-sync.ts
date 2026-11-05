import { z } from 'zod';
import { fetchNativeSnapshot, type NativeMessage } from './native-sync-snapshot';
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
    try {
      // Snapshot parsing lives at the snapshot boundary; all other callers validate their responses below.
      return (await this.json(path, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${grant.token}` },
      })) as T;
    } catch (error) {
      if (!(error instanceof NativeSyncError) || error['status'] !== 401) throw error;
      this.grants.delete(organizationID ?? '');
      const renewed = await this.grant(organizationID);
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
    onFrame: (frame: NativeEvent, send: (value: unknown) => boolean) => Promise<void> | void,
    onConnection: (state: NativeConnection, error?: string) => void
  ) {
    let stopped = false;
    let socket: NativeSocket | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectAfterMs = 1000;
    let generation = 0;
    let frames = Promise.resolve();
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
              if (current !== generation || stopped) return;
              onConnection('disconnected', reason(error));
              socket?.close();
            });
        },
        Math.max(0, deadline - Date.now())
      );
    };
    const reconnect = (error?: unknown) => {
      if (stopped) return;
      clearTimeout(renewalTimer);
      onConnection('disconnected', error ? reason(error) : undefined);
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
      onConnection('connecting');
      try {
        const ticket = await mint();
        if (stopped || current !== generation) return;
        const url = new URL(path, this.options.baseUrl);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        const next = new this.socketConstructor(url.href, [`kilo-session-ticket.${ticket.ticket}`]);
        socket = next;
        const sendCurrent = (value: unknown) => !stopped && current === generation && send(value);
        next.onerror = () => {
          if (current === generation) next.close();
        };
        next.onclose = () => {
          if (current === generation) reconnect();
        };
        next.onmessage = event => {
          if (typeof event['data'] !== 'string') return;
          const data = event['data'];
          frames = frames
            .then(async () => {
              if (stopped || current !== generation) return;
              const frame = envelopeSchema.parse(JSON.parse(data));
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
                  if (!stopped && current === generation)
                    send({ type: 'reauth', ticket: ticket.ticket });
                }
                if (frame.type === 'reauthorized') scheduleRenewal(body);
              }
              await onFrame(frame, sendCurrent);
            })
            .catch((error: unknown) => {
              if (stopped || current !== generation) return;
              onConnection('disconnected', reason(error));
              next.close();
            });
        };
      } catch (error) {
        if (current === generation) reconnect(error);
      }
    };
    void connect();
    return {
      send,
      close: () => {
        stopped = true;
        generation++;
        clearTimeout(reconnectTimer);
        clearTimeout(renewalTimer);
        socket?.close();
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
    let recoveryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelRecovery: (() => void) | undefined;
    let remoteState: NativeEvent | undefined;
    const clearedIDs = new Set<string>();
    const publish = (patch: Partial<NativeSessionState>) => {
      if (closed) return;
      state = { ...state, ...patch };
      listener(state);
    };
    const snapshot = async () => {
      const snapshot = await fetchNativeSnapshot(
        <T>(route: string) => this.request<T>(route, undefined, organizationID),
        sessionID
      );
      snapshotPosition = snapshot.position;
      if (!closed)
        publish({ messages: snapshot.messages.filter(message => !clearedIDs.has(message.id)) });
    };
    const connection = this.socket(
      `${path}/live`,
      `${path}/live-ticket`,
      organizationID,
      async (frame, send) => {
        const body = record(frame.body);
        if (frame.channel === 'control') {
          if (frame.type === 'hello') {
            publish({ runnerConnected: body['runnerConnected'] === true });
            if (lastSeq === undefined) {
              await snapshot();
              lastSeq = frame.seq;
            }
            if (!closed) send({ type: 'subscribe', afterSeq: lastSeq });
          }
          if (frame.type === 'reset_required') {
            await snapshot();
            lastSeq = typeof body['seq'] === 'number' ? body['seq'] : frame.seq;
            if (!closed) send({ type: 'subscribe', afterSeq: lastSeq });
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
        const ephemeral = frame.type.endsWith('.delta') || frame.type === 'session.tool.progress';
        const beyondSnapshot =
          typeof body['syncPosition'] !== 'number' ||
          body['syncPosition'] > snapshotPosition ||
          (ephemeral && body['syncPosition'] === snapshotPosition);
        publish({
          events,
          messages: !beyondSnapshot
            ? state.messages
            : applyNativeEvent(state.messages, frame).filter(
                message => !clearedIDs.has(message.id)
              ),
        });
        if (
          frame.type.startsWith('session.execution.') &&
          frame.type !== 'session.execution.started' &&
          state.messages.some(message => message.incomplete)
        ) {
          // The producer uploads asynchronously. Recover omitted/deferred parts only
          // from a complete durable snapshot, never by declaring partial text complete.
          for (let attempt = 0; attempt < 4 && !closed; attempt++) {
            await new Promise<void>(resolve => {
              cancelRecovery = resolve;
              recoveryTimer = setTimeout(resolve, 250 * 2 ** attempt);
            });
            if (closed) break;
            await snapshot();
            if (!state.messages.some(message => message.incomplete)) break;
          }
        }
      },
      (connection, error) => {
        publish({
          connection,
          error,
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
        clearTimeout(recoveryTimer);
        cancelRecovery?.();
        connection.close();
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
      ? message['content'].map(part => ({ ...record(part) }))
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
      const part = parts[index];
      if (!part) return message;
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
    if (frame.type === 'session.message.content.updated' && Array.isArray(data['content']))
      return { ...message, content: data['content'] };
    return message;
  });
}
