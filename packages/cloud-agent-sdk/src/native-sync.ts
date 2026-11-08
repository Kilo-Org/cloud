import { z } from 'zod';
import {
  fetchNativeSnapshot,
  type NativeSnapshot,
  type NativeSnapshotMessage,
  type NativeSnapshotSession,
} from './native-sync-snapshot';
import { applyNativeEvent, applyNativeSessionEvent } from './native-conversation-reducer';
import {
  reduceNativePendingRequests,
  type NativePendingRequests,
} from './native-conversation-source';
import { cloudAgentSdkRuntime } from './runtime';
import {
  hasUnresolvedKilo2Assets,
  kilo2AssetKey,
  readKilo2FileReferences,
  type Kilo2FileReference,
} from './kilo2-source-messages';

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
  /** Snapshot fields accept undefined so merged state patches can explicitly clear them. */
  session?: NativeSnapshotSession | undefined;
  snapshot?: { position: number; revision: number } | undefined;
  /** Canonical message identities awaiting a revision-pinned native snapshot. */
  pendingSnapshotMessageIDs?: string[] | undefined;
  assetURLs?: Readonly<Record<string, string>> | undefined;
  messages: NativeSnapshotMessage[];
  pending: NativePendingRequests;
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
const recordSchema = z.record(z.string(), z.unknown());
function record(value: unknown) {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
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

type NativeRecoveryRequirement = {
  frame: NativeEvent;
  messageID: string;
  revision: number;
  position: number;
  files: Kilo2FileReference[];
};

/** A newer unrelated snapshot is not proof that a missing native tool was stored. */
function snapshotCoversLiveGap(
  snapshot: NativeSnapshot,
  requirement: NativeRecoveryRequirement
): boolean {
  if (snapshot.revision <= requirement.revision || snapshot.position < requirement.position)
    return false;
  const item = snapshot.messages.find(item => item.message.id === requirement.messageID);
  if (!item || item.incomplete || hasUnresolvedKilo2Assets(item.message, snapshot.assetURLs))
    return false;
  const files = readKilo2FileReferences(item.message);
  if (
    requirement.files.some(
      expected =>
        !files.some(
          file =>
            file.id === expected.id && file.uri === expected.uri && file.mime === expected.mime
        )
    )
  )
    return false;
  const native = record(record(requirement.frame.body)['data']);
  const data = record(native['data']);
  const created = native['created'];
  if (requirement.frame.type.startsWith('session.tool.')) {
    let part: NonNullable<NativeSnapshotMessage['message']['content']>[number] | undefined;
    for (let index = (item.message.content?.length ?? 0) - 1; index >= 0; index--) {
      const candidate = item.message.content?.[index];
      if (candidate?.type === 'tool' && candidate.id === data['id']) {
        part = candidate;
        break;
      }
    }
    if (!part?.state) return false;
    if (requirement.frame.type === 'session.tool.called')
      return (
        typeof created === 'number' && (part.time?.ran ?? part.time?.completed ?? -1) >= created
      );
    if (
      requirement.frame.type === 'session.tool.success' ||
      requirement.frame.type === 'session.tool.failed'
    )
      return (
        typeof created === 'number' &&
        (part.time?.completed ?? -1) >= created &&
        (part.state.status === 'completed' || part.state.status === 'error')
      );
    return (
      part.state.status !== 'streaming' ||
      (requirement.frame.type === 'session.tool.input.ended' && part.state.input === data['text'])
    );
  }
  if (/^session\.(text|reasoning)\./.test(requirement.frame.type))
    return item.message.time.completed !== undefined;
  if (requirement.frame.type === 'session.inbox.enqueued')
    return typeof created === 'number' && item.message.time.created >= created;
  return true;
}

/** Non-content-addressed native files need fresh authorization after their content is replaced. */
function nativeAssetURLsAfterMessages(
  previous: NativeSnapshotMessage[],
  messages: NativeSnapshotMessage[],
  assetURLs: Readonly<Record<string, string>> | undefined
) {
  if (!assetURLs) return assetURLs;
  let changed: Record<string, string> | undefined;
  for (const item of messages) {
    const before = previous.find(candidate => candidate.message.id === item.message.id);
    if (before?.message === item.message) continue;
    for (const file of readKilo2FileReferences(item.message)) {
      const key = kilo2AssetKey(file.id, file.uri, file.mime);
      if (/^(media:|data:|https?:\/\/)/.test(file.uri) || assetURLs[key] === undefined) continue;
      const replaced =
        file.contentIndex === undefined
          ? before?.message.files !== item.message.files
          : before?.message.content?.[file.contentIndex]?.state?.content !==
            item.message.content?.[file.contentIndex]?.state?.content;
      if (!replaced) continue;
      changed ??= { ...assetURLs };
      delete changed[key];
    }
  }
  return changed ?? assetURLs;
}

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
        await (
          await this.response('/v1/auth/exchange', {
            method: 'POST',
            headers: { Authorization: `Bearer ${credential}` },
            body: JSON.stringify({ version: 1, ...(organizationID ? { organizationID } : {}) }),
          })
        ).json()
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
  private async response(path: string, init?: RequestInit): Promise<Response> {
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
    return response;
  }
  private async authorizedResponse(
    path: string,
    init?: RequestInit,
    organizationID?: string
  ): Promise<Response> {
    const grant = await this.grant(organizationID);
    if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
    try {
      return await this.response(path, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${grant.token}` },
      });
    } catch (error) {
      if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
      if (!(error instanceof NativeSyncError) || error['status'] !== 401) throw error;
      this.grants.delete(organizationID ?? '');
      const renewed = await this.grant(organizationID);
      if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
      return await this.response(path, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${renewed.token}` },
      });
    }
  }
  async request<T>(path: string, init?: RequestInit, organizationID?: string): Promise<T> {
    // Snapshot parsing lives at its canonical boundary; other callers validate below.
    try {
      return (await (await this.authorizedResponse(path, init, organizationID)).json()) as T;
    } catch (error) {
      if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
      throw error;
    }
  }
  private async requestAsset(
    path: string,
    advertisedBytes: number,
    init?: RequestInit,
    organizationID?: string
  ): Promise<ArrayBuffer> {
    try {
      const response = await this.authorizedResponse(path, init, organizationID);
      const reader = response.body?.getReader();
      try {
        const length = response.headers.get('Content-Length');
        if (length !== null) {
          if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) {
            throw new NativeSyncError('invalid_content_length');
          }
          if (Number(length) > advertisedBytes) {
            throw new NativeSyncError('blob_hash_mismatch');
          }
        }
        if (!reader) {
          if (advertisedBytes === 0) return new ArrayBuffer(0);
          throw new NativeSyncError('blob_hash_mismatch');
        }
        const bytes = new Uint8Array(advertisedBytes);
        let offset = 0;
        while (true) {
          const result = await reader.read();
          if (result.done) {
            if (offset !== advertisedBytes) throw new NativeSyncError('blob_hash_mismatch');
            return bytes.buffer;
          }
          if (result.value.byteLength > advertisedBytes - offset) {
            throw new NativeSyncError('blob_hash_mismatch');
          }
          bytes.set(result.value, offset);
          offset += result.value.byteLength;
        }
      } catch (error) {
        try {
          await reader?.cancel();
        } catch {
          // The bounded read fails closed even if the stream cannot be canceled.
        }
        throw error;
      } finally {
        reader?.releaseLock();
      }
    } catch (error) {
      if (init?.signal?.aborted) throw new NativeSyncError('request_canceled');
      throw error;
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
  /** Read canonical native history using the same tenant-scoped grant as live control. */
  getSnapshot(
    sessionID: string,
    organizationID?: string,
    signal?: AbortSignal
  ): Promise<NativeSnapshot> {
    return fetchNativeSnapshot(
      <T>(route: string, init?: RequestInit) => this.request<T>(route, init, organizationID),
      sessionID,
      signal,
      (route: string, advertisedBytes: number, init?: RequestInit) =>
        this.requestAsset(route, advertisedBytes, init, organizationID)
    );
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
      pending: { permissions: [], questions: [] },
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
      requirements: Map<number, NativeRecoveryRequirement>;
      completed: boolean;
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
    const visible = (messages: NativeSnapshotMessage[]) =>
      clearedIDs.size === 0 ? messages : messages.filter(item => !clearedIDs.has(item.message.id));
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
      this.getSnapshot(sessionID, organizationID, signal);
    const snapshot = async (epoch: SocketEpoch) => {
      const next = await readSnapshot(epoch);
      if (!epoch.current() || next.position < snapshotPosition) return;
      snapshotPosition = next.position;
      publish({
        session: next.session,
        snapshot: { position: next.position, revision: next.revision },
        messages: visible(next.messages),
        assetURLs: next.assetURLs,
        pendingSnapshotMessageIDs: state.pendingSnapshotMessageIDs?.filter(
          id =>
            !next.messages.some(
              item =>
                item.message.id === id &&
                !item.incomplete &&
                !hasUnresolvedKilo2Assets(item.message, next.assetURLs)
            )
        ),
      });
    };
    const markGap = () => {
      integrityGap = true;
      integrityError = 'Native transcript may be incomplete because live replay is unavailable.';
      publish({});
    };
    const recoverIncomplete = (epoch: SocketEpoch, force = false) => {
      if (
        recovery ||
        !epoch.current() ||
        (!force &&
          state.session &&
          !state.messages.some(message => message.incomplete) &&
          !state.pendingSnapshotMessageIDs?.length)
      )
        return;
      const controller = new AbortController();
      const current: Recovery = {
        attempt: 0,
        replay: [],
        requirements: new Map(),
        completed: false,
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
        current.requirements.clear();
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
          let session = next.session;
          let assetURLs = next.assetURLs;
          const requiredReplay = new Set(current.requirements.keys());
          if (!stale) {
            for (const [seq, requirement] of current.requirements)
              if (snapshotCoversLiveGap(next, requirement)) current.requirements.delete(seq);
          }
          for (const item of current.replay) {
            const ephemeral =
              item.frame.type.endsWith('.delta') || item.frame.type === 'session.tool.progress';
            if (
              !ephemeral &&
              requiredReplay.has(item.frame.seq) &&
              !current.requirements.has(item.frame.seq)
            )
              continue;
            if (
              !beyond(item.frame, next.position) &&
              !current.requirements.has(item.frame.seq) &&
              !(ephemeral && requiredReplay.has(item.frame.seq))
            )
              continue;
            const previous = messages;
            messages = applyNativeEvent(messages, item.frame, session);
            assetURLs = nativeAssetURLsAfterMessages(previous, messages, assetURLs);
            session = applyNativeSessionEvent(session, item.frame);
          }
          if (!stale) {
            snapshotPosition = next.position;
            publish({
              session,
              snapshot: { position: next.position, revision: next.revision },
              messages: visible(messages),
              assetURLs,
              pendingSnapshotMessageIDs: state.pendingSnapshotMessageIDs?.filter(
                id =>
                  [...current.requirements.values()].some(
                    requirement => requirement.messageID === id
                  ) ||
                  !next.messages.some(
                    item =>
                      item.message.id === id &&
                      !item.incomplete &&
                      !hasUnresolvedKilo2Assets(item.message, next.assetURLs)
                  )
              ),
            });
          }
          // A stale snapshot cannot prune replay needed by a later consistent read.
          if (!stale) {
            current.replay = current.replay.filter(item => {
              if (beyond(item.frame, next.position) || current.requirements.has(item.frame.seq))
                return true;
              epoch.release(item.bytes);
              return false;
            });
          }
          if (
            state.session &&
            !state.messages.some(
              item => item.incomplete || hasUnresolvedKilo2Assets(item.message, state.assetURLs)
            ) &&
            !state.pendingSnapshotMessageIDs?.length
          ) {
            if (!integrityGap) {
              integrityError = undefined;
              publish({ error: undefined });
            }
            current.completed = true;
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
          if (!current.completed && current.replay.length > 0 && epoch.current()) markGap();
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
            state.session &&
            !integrityGap &&
            !state.messages.some(message => message.incomplete) &&
            !state.pendingSnapshotMessageIDs?.length
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
        // Validate/project before accepting the relay cursor. A malformed native
        // value must not acknowledge an event that this client failed to retain.
        const messages = beyond(frame, snapshotPosition)
          ? visible(applyNativeEvent(state.messages, frame, state.session))
          : state.messages;
        const pending = reduceNativePendingRequests(state.pending, frame);
        const session = applyNativeSessionEvent(state.session, frame);
        const assetURLs = nativeAssetURLsAfterMessages(state.messages, messages, state.assetURLs);
        const newGaps = messages.filter(item => {
          const previous = state.messages.find(previous => previous.message.id === item.message.id);
          const missingDependency =
            item.incomplete &&
            (!previous?.incomplete || (item !== previous && item.message === previous.message));
          return (
            missingDependency ||
            (!item.incomplete &&
              hasUnresolvedKilo2Assets(item.message, assetURLs) &&
              !state.pendingSnapshotMessageIDs?.includes(item.message.id))
          );
        });
        let pendingSnapshotMessageIDs = state.pendingSnapshotMessageIDs;
        if (newGaps.length)
          pendingSnapshotMessageIDs = [
            ...new Set([
              ...(pendingSnapshotMessageIDs ?? []),
              ...newGaps.map(item => item.message.id),
            ]),
          ];
        if (frame.type === 'session.moved') {
          const eventID = z.string().startsWith('evt_').parse(record(body['data'])['id']);
          const messageID = `msg_${eventID.slice(4)}`;
          if (!messages.some(item => item.message.id === messageID && !item.incomplete))
            pendingSnapshotMessageIDs = [
              ...new Set([...(pendingSnapshotMessageIDs ?? []), messageID]),
            ];
        }
        if (!recovery && (!session || newGaps.length || pendingSnapshotMessageIDs?.length))
          recoverIncomplete(epoch, true);
        if (recovery) {
          if (!epoch.retain(bytes)) {
            epoch.fail(new NativeSyncError('live_backlog_overflow'));
            return;
          }
          recovery.replay.push({ frame, bytes });
          for (const item of newGaps)
            recovery.requirements.set(frame.seq, {
              frame,
              messageID: item.message.id,
              revision: state.snapshot?.revision ?? -1,
              position:
                typeof body['syncPosition'] === 'number' ? body['syncPosition'] : snapshotPosition,
              files: readKilo2FileReferences(item.message),
            });
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
          session,
          pending,
          messages,
          assetURLs,
          pendingSnapshotMessageIDs,
        });
        if (
          frame.type === 'session.moved' ||
          (frame.type.startsWith('session.execution.') &&
            frame.type !== 'session.execution.started') ||
          newGaps.length ||
          !session
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
          for (const item of state.messages) clearedIDs.add(item.message.id);
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
        for (const item of state.messages) clearedIDs.add(item.message.id);
        publish({ messages: [] });
      },
      close: () => {
        closed = true;
        connection.close();
        recovery?.cancel();
        state = {
          ...state,
          session: undefined,
          snapshot: undefined,
          pendingSnapshotMessageIDs: undefined,
          assetURLs: undefined,
          messages: [],
          pending: { permissions: [], questions: [] },
          events: [],
          commands: {},
        };
        clearedIDs.clear();
        remoteState = undefined;
        identity = undefined;
      },
    };
  }
}
