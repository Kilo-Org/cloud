import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildGlanceableSnapshot,
  buildOpaqueScopeKey,
} from '../../../../packages/app-shared/src/glanceable-agents-snapshot';
import { getWorkerDb } from '@kilocode/db/client';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { NotificationChannelDO, NotificationsService } from '../../../notifications/src/index';
import { GLANCEABLE_DELIVERY_MIN_INTERVAL_MS } from '../../../notifications/src/lib/glanceable-refresh';
import {
  sendPushNotifications,
  type ExpoPushMessage,
} from '../../../notifications/src/lib/expo-push';
import type * as ExpoPushModule from '../../../notifications/src/lib/expo-push';
import type { Env } from '../env';

// Mock only the runtime base classes; the producers, coordinator, and delivery adapter stay real.
vi.mock('cloudflare:workers', () => {
  class WorkerBase {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }
  return { DurableObject: WorkerBase, WorkerEntrypoint: WorkerBase };
});
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('../../../notifications/src/lib/expo-push', async importOriginal => ({
  ...(await importOriginal<typeof ExpoPushModule>()),
  sendPushNotifications: vi.fn(),
}));

const sessionIngestMocks = vi.hoisted(() => ({
  resetAttentionStatusOnCliDisconnect: vi.fn(async () => undefined),
  claimSessionReadyPush: vi.fn(async () => undefined),
  getSessionIngestDO: vi.fn(),
}));

vi.mock('./SessionIngestDO', () => ({
  getSessionIngestDO: sessionIngestMocks.getSessionIngestDO,
}));

const sessionAccessMocks = vi.hoisted(() => ({
  resolveAccessibleKiloSession: vi.fn(),
}));

vi.mock('../services/session-access', () => ({
  resolveAccessibleKiloSession: sessionAccessMocks.resolveAccessibleKiloSession,
}));

import {
  CLI_ABSENCE_ATTENTION_RESET_MS,
  MAX_CATALOG_RESULT_BYTES,
  MAX_DURABLE_RESULT_BYTES,
  UserConnectionDO,
} from './UserConnectionDO';
import type { Instance } from '../types/user-connection-protocol';

type MockWS = {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  readyState: number;
  _attachment: unknown;
  _tags: string[];
  serializeAttachment(att: unknown): void;
  deserializeAttachment(): unknown;
};

function createMockWs(tags: string[] = [], attachment?: unknown): MockWS {
  const ws: MockWS = {
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
    _attachment: attachment ?? null,
    _tags: tags,
    serializeAttachment(att: unknown) {
      ws._attachment = att;
    },
    deserializeAttachment() {
      return ws._attachment;
    },
  };
  return ws;
}

/** In-memory Map-backed KV fake for ctx.storage (put/get/delete/list/alarm). */
function makeStorageFake() {
  const store = new Map<string, unknown>();
  let alarmTime: number | null = null;
  return {
    store,
    kv: {
      get: (key: string) => store.get(key),
      put: (key: string, value: unknown) => {
        store.set(key, value);
      },
      delete: (key: string) => store.delete(key),
      list: (opts?: { prefix?: string }) =>
        new Map([...store].filter(([key]) => key.startsWith(opts?.prefix ?? ''))),
    },
    deleteAlarm: vi.fn(async () => {
      alarmTime = null;
    }),
    put: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn(async <T = unknown>(key: string): Promise<T | undefined> => {
      return store.get(key) as T | undefined;
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async <T = unknown>(opts?: { prefix?: string }): Promise<Map<string, T>> => {
      const result = new Map<string, T>();
      const prefix = opts?.prefix ?? '';
      for (const [key, value] of store) {
        if (key.startsWith(prefix)) {
          result.set(key, value as T);
        }
      }
      return result;
    }),
    // The glanceable deferral reads the current alarm before re-arming it, so
    // the fake must model the alarm rather than return `undefined`.
    getAlarm: vi.fn(async () => alarmTime),
    setAlarm: vi.fn(async (scheduledTime: number | Date) => {
      alarmTime = typeof scheduledTime === 'number' ? scheduledTime : scheduledTime.getTime();
    }),
  };
}

function createMockCtx() {
  const sockets: MockWS[] = [];
  const storage = makeStorageFake();
  return {
    sockets,
    storage,
    addSocket(ws: MockWS) {
      sockets.push(ws);
    },
    removeSocket(ws: MockWS) {
      const idx = sockets.indexOf(ws);
      if (idx !== -1) sockets.splice(idx, 1);
    },
    build() {
      return {
        getWebSockets(tag?: string): MockWS[] {
          if (!tag) return [...sockets];
          return sockets.filter(ws => ws._tags.includes(tag));
        },
        acceptWebSocket(ws: MockWS, tags: string[]) {
          ws._tags = tags;
          sockets.push(ws);
        },
        getTags(ws: MockWS) {
          return ws._tags;
        },
        storage,
        // Auto-run waitUntil work so delayed readyPush / rename catch-up settle in tests.
        waitUntil: vi.fn((p: Promise<unknown>) => {
          void Promise.resolve(p).catch(() => undefined);
        }),
      };
    },
  };
}

/** Drain microtasks so waitUntil-scheduled async IIFEs settle. */
async function flushAsync(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

/**
 * The aggregate delivery coordinator wakes a device at most once per account
 * scope per `GLANCEABLE_DELIVERY_MIN_INTERVAL_MS`, deferring a change inside the
 * window to the Durable Object alarm. The glanceable cases below assert the
 * connection DO's own per-status-change trigger, so step the wall clock past
 * the window between heartbeats. The window itself is covered by
 * `services/notifications/src/lib/glanceable-refresh.test.ts`.
 */
function useDeliveryWindowClock(): { tick: () => void } {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    tick: () => {
      now += GLANCEABLE_DELIVERY_MIN_INTERVAL_MS + 1_000;
    },
  };
}

function makeSession(
  id: string,
  status = 'busy',
  title = 'Test',
  parentSessionId?: string,
  platform?: string
) {
  const base = platform ? { id, status, title, platform } : { id, status, title };
  return parentSessionId ? { ...base, parentSessionId } : base;
}

function parseSent(ws: MockWS, callIndex = 0): unknown {
  const call = ws.send.mock.calls[callIndex];
  if (!call) throw new Error(`No send call at index ${callIndex}`);
  return JSON.parse(call[0] as string);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function allSent(ws: MockWS): Record<string, unknown>[] {
  return ws.send.mock.calls.map(c => {
    const parsed: unknown = JSON.parse(String(c[0]));
    if (!isRecord(parsed)) {
      throw new Error(`Expected JSON object but got: ${String(c[0])}`);
    }
    return parsed;
  });
}

/** Extract the correlationId that was sent to CLI for a given command. */
function getCorrelationId(cliWs: MockWS, callIndex = 0): string {
  const msgs = allSent(cliWs);
  const cmdMsgs = msgs.filter(m => m.type === 'command');
  const msg = cmdMsgs[callIndex];
  if (!msg) throw new Error(`No command call at index ${callIndex}`);
  return msg.id as string;
}

/** Instantiate a fresh DO with a mock context. Returns the DO and helpers. */
function setup(env: Partial<Env> = {}) {
  const mockCtx = createMockCtx();
  const ctx = mockCtx.build();
  const doInstance = new UserConnectionDO(ctx as never, env as Env);
  return { doInstance, ctx, mockCtx };
}

function pendingGlanceableKey(userId: string, organizationId: string | null): string {
  return `glanceable-pending:${JSON.stringify([userId, organizationId])}`;
}

function setupGlanceableDelivery(foreignSessionIds: string[] = []) {
  const messages: ExpoPushMessage[] = [];
  vi.mocked(getWorkerDb).mockReturnValue(
    drizzle(async (sql, params) => {
      if (sql.includes('from "cli_sessions_v2"')) {
        return {
          rows: foreignSessionIds.filter(id => params.includes(id)).map(id => [id, 'usr_2', null]),
        };
      }
      if (sql.includes('from "user_activity_tokens"')) return { rows: [] };
      if (sql.includes('from "user_push_tokens"'))
        return { rows: [['ExponentPushToken[ios]', null]] };
      throw new Error(`Unexpected query: ${sql}`);
    }) as never
  );
  vi.mocked(sendPushNotifications).mockImplementation(async incoming => {
    messages.push(...incoming);
    return { ticketTokenPairs: [], staleTokens: [], ticketErrors: [] };
  });
  const storage = makeStorageFake();
  const notificationEnv = {
    HYPERDRIVE: { connectionString: 'postgres://unused' },
    KILO_WEB_API_BASE_URL: 'https://snapshot.test',
    INTERNAL_API_SECRET: { get: async () => 'test-internal-secret' },
    EXPO_ACCESS_TOKEN: { get: async () => 'test-expo-token' },
    NOTIFICATION_CHANNEL_DO: {
      idFromName: (userId: string) => userId,
      get: () => channel,
    },
  };
  const channel = new NotificationChannelDO(
    {
      storage: {
        ...storage,
        transaction: async (fn: (tx: typeof storage) => Promise<unknown>) => fn(storage),
      },
    } as never,
    notificationEnv as never
  );
  const service = new NotificationsService({} as never, notificationEnv as never);
  const env: Partial<Env> = { NOTIFICATIONS: service as never };
  const result = setup(env);
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    if (typeof init.body !== 'string') throw new Error('Expected a JSON request body');
    const scope = JSON.parse(init.body) as { userId: string; organizationId: string | null };
    return Response.json(
      buildGlanceableSnapshot({
        ...scope,
        sessions: result.doInstance.getActiveSessions(),
        now: Date.now(),
      })
    );
  });
  return { ...result, env, messages, channelStorage: storage };
}

function connectWebSocket(doInstance: UserConnectionDO, connectionId: string): MockWS {
  const client = createMockWs();
  const server = createMockWs();
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = client;
      1 = server;
    }
  );
  vi.stubGlobal(
    'Response',
    class {
      constructor(_body?: BodyInit | null, _init?: ResponseInit) {}
    }
  );

  doInstance.fetch(
    new Request(`http://local/web?connectionId=${connectionId}&kiloUserId=usr_1`, {
      headers: { Upgrade: 'websocket' },
    })
  );
  return server;
}

function connectCliSocket(doInstance: UserConnectionDO, connectionId: string): MockWS {
  const client = createMockWs();
  const server = createMockWs();
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = client;
      1 = server;
    }
  );
  vi.stubGlobal(
    'Response',
    class {
      constructor(_body?: BodyInit | null, _init?: ResponseInit) {}
    }
  );

  doInstance.fetch(
    new Request(`http://local/cli?connectionId=${connectionId}`, {
      headers: { Upgrade: 'websocket' },
    })
  );
  return server;
}

/** Create a CLI WebSocket and add it to the context with proper attachment. */
function addCliSocket(
  mockCtx: ReturnType<typeof createMockCtx>,
  connectionId: string,
  sessions: Array<{
    id: string;
    status: string;
    title: string;
    platform?: string;
  }> = [],
  instance?: Instance,
  kiloUserId?: string
): MockWS {
  const attachment: {
    role: 'cli';
    connectionId: string;
    sessions: typeof sessions;
    instance?: typeof instance;
    kiloUserId?: string;
  } = { role: 'cli', connectionId, sessions };
  if (instance) attachment.instance = instance;
  if (kiloUserId) attachment.kiloUserId = kiloUserId;
  const ws = createMockWs(['cli'], attachment);
  mockCtx.addSocket(ws);
  return ws;
}

/** Create a web WebSocket and add it to the context. */
function addWebSocket(
  mockCtx: ReturnType<typeof createMockCtx>,
  connectionId = 'web-1',
  subscribedSessions: string[] = [],
  kiloUserId = 'usr_1'
): MockWS {
  const attachment = { role: 'web' as const, connectionId, subscribedSessions, kiloUserId };
  const ws = createMockWs(['web'], attachment);
  mockCtx.addSocket(ws);
  return ws;
}

/** Send a heartbeat from a CLI ws */
function sendHeartbeat(
  doInstance: UserConnectionDO,
  cliWs: MockWS,
  sessions: Array<{
    id: string;
    status: string;
    title: string;
    platform?: string;
    scheduledAt?: string;
    prLink?: { platform: string; prUrl: string; prNumber: number };
  }>,
  options: {
    protocolVersion?: string;
    capabilities?: { attachments?: boolean; sessionClone?: boolean };
    instance?: Instance;
  } = {}
) {
  const msg = JSON.stringify({
    type: 'heartbeat',
    sessions,
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
  });
  void doInstance.webSocketMessage(cliWs as never, msg);
}

/** Send a subscribe from a web ws */
async function sendSubscribe(doInstance: UserConnectionDO, webWs: MockWS, sessionId: string) {
  const msg = JSON.stringify({ type: 'subscribe', sessionId });
  await doInstance.webSocketMessage(webWs as never, msg);
  await flushAsync();
}

/** Send an unsubscribe from a web ws */
function sendUnsubscribe(doInstance: UserConnectionDO, webWs: MockWS, sessionId: string) {
  const msg = JSON.stringify({ type: 'unsubscribe', sessionId });
  void doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a viewer ping from a web ws */
function sendPing(doInstance: UserConnectionDO, webWs: MockWS, nonce: string) {
  const msg = JSON.stringify({ type: 'ping', nonce });
  void doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a command from a web ws. Auto-flushes so durable-before-send
 * dispatch completes before callers inspect CLI state. */
async function sendCommand(
  doInstance: UserConnectionDO,
  webWs: MockWS,
  opts: {
    id: string;
    command: string;
    sessionId?: string;
    connectionId?: string;
    data?: unknown;
    mutationId?: string;
  }
): Promise<void> {
  const msg = JSON.stringify({ type: 'command', ...opts });
  await doInstance.webSocketMessage(webWs as never, msg);
  await flushAsync();
}

/** Send a response from a CLI ws. Durable-before-send means the live
 * response arrives after storage.put; flushAsync settles the waitUntil
 * promise in the test harness. */
async function sendCliResponse(
  doInstance: UserConnectionDO,
  cliWs: MockWS,
  opts: { id: string; result?: unknown; error?: unknown }
): Promise<void> {
  const msg = JSON.stringify({ type: 'response', ...opts });
  void doInstance.webSocketMessage(cliWs as never, msg);
  await flushAsync();
}

function createResultWithSerializedBytes(targetBytes: number): {
  padding: string;
} {
  const framingBytes = new TextEncoder().encode(JSON.stringify({ padding: '' })).byteLength;
  const result = { padding: 'x'.repeat(targetBytes - framingBytes) };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength !== targetBytes) {
    throw new Error(`Result fixture does not serialize to ${targetBytes} bytes`);
  }
  return result;
}

function createUtf8OversizedResult(): { padding: string } {
  const framingBytes = JSON.stringify({ padding: '' }).length;
  const result = {
    padding: 'é'.repeat(Math.floor((MAX_CATALOG_RESULT_BYTES - framingBytes) / 2) + 1),
  };
  if (
    JSON.stringify(result).length >= MAX_CATALOG_RESULT_BYTES ||
    new TextEncoder().encode(JSON.stringify(result)).byteLength <= MAX_CATALOG_RESULT_BYTES
  ) {
    throw new Error('UTF-8 catalog fixture does not cross the byte-only boundary');
  }
  return result;
}

/** Trigger CLI disconnect (awaits attention reset before broadcast). */
async function disconnectCli(doInstance: UserConnectionDO, cliWs: MockWS) {
  await doInstance.webSocketClose(cliWs as never, 0, '', false);
}

/** Trigger web disconnect */
function disconnectWeb(doInstance: UserConnectionDO, webWs: MockWS) {
  void doInstance.webSocketClose(webWs as never, 0, '', false);
}

describe('UserConnectionDO', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockReset();
    sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockResolvedValue(undefined);
    sessionIngestMocks.claimSessionReadyPush.mockReset();
    sessionIngestMocks.getSessionIngestDO.mockReset();
    sessionIngestMocks.getSessionIngestDO.mockReturnValue({
      resetAttentionStatusOnCliDisconnect: sessionIngestMocks.resetAttentionStatusOnCliDisconnect,
      claimSessionReadyPush: sessionIngestMocks.claimSessionReadyPush,
    });
    sessionAccessMocks.resolveAccessibleKiloSession.mockReset();
    sessionAccessMocks.resolveAccessibleKiloSession.mockResolvedValue({
      kiloSessionId: 'ses_12345678901234567890123456',
      organizationId: null,
      cloudAgentSessionScopeId: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('notifySessionEvent', () => {
    it('broadcasts semantic session events to web sockets only', async () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx);
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const session = {
        source: 'v2' as const,
        sessionId: 'ses_12345678901234567890123456',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
        title: 'Test',
        createdOnPlatform: 'web',
        organizationId: null,
        gitUrl: null,
        gitBranch: null,
        parentSessionId: null,
        worktreeId: 'worktree_11111111-1111-4111-8111-111111111111',
        status: 'idle' as const,
        statusUpdatedAt: null,
      };

      const result = await doInstance.notifySessionEvent({
        type: 'session.created',
        data: { source: 'v2', session, changedAt: session.updatedAt },
      });

      expect(result).toEqual({ delivered: 1 });
      expect(parseSent(webWs)).toEqual({
        type: 'system',
        event: 'session.created',
        data: { source: 'v2', session, changedAt: session.updatedAt },
      });
      expect(cliWs.send).not.toHaveBeenCalled();
    });

    it('rejects invalid session event payloads without broadcasting', async () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx);

      await expect(
        doInstance.notifySessionEvent({
          type: 'session.created',
          data: { source: 'v1' },
        } as never)
      ).rejects.toThrow();
      expect(webWs.send).not.toHaveBeenCalled();
    });
  });

  describe('hasActiveCliSession', () => {
    it('tracks whether a connected CLI heartbeat currently owns the session', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      expect(doInstance.hasActiveCliSession('ses_1')).toBe(false);

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_1')]);

      expect(doInstance.hasActiveCliSession('ses_1')).toBe(true);

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(doInstance.hasActiveCliSession('ses_1')).toBe(false);
    });

    it('reconstructs live session ownership from a hibernated CLI attachment', async () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1', [makeSession('ses_1')]);

      expect(doInstance.hasActiveCliSession('ses_1')).toBe(true);
    });
  });

  describe('glanceable aggregate transitions', () => {
    it('delivers rowless personal busy, retry, attention-clear, and idle heartbeats through the real coordinator', async () => {
      const { doInstance, mockCtx, messages } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const clock = useDeliveryWindowClock();
      for (const status of ['busy', 'retry', 'question', 'busy', 'idle']) {
        clock.tick();
        sendHeartbeat(doInstance, cliWs, [makeSession('s1', status)]);
        await flushAsync();
      }
      expect(messages.map(message => message.data)).toMatchObject([
        { status: 'happy', running: 1, needsInput: 0, idle: 0 },
        // The retry and the question deliver the same counts, because one
        // orange state covers both, but each still delivers: the coordinator
        // resends on a root status change, not on a count change.
        { status: 'happy', running: 0, needsInput: 1, idle: 0 },
        { status: 'happy', running: 0, needsInput: 1, idle: 0 },
        { status: 'happy', running: 1, needsInput: 0, idle: 0 },
        // Idle is a count, not an empty aggregate.
        { status: 'happy', running: 0, needsInput: 0, idle: 1 },
      ]);
      expect(messages.every(message => message._contentAvailable && !message.body)).toBe(true);
      expect(
        messages.every(
          message =>
            message.data?.scopeKey ===
            buildOpaqueScopeKey({ userId: 'usr_1', organizationId: null })
        )
      ).toBe(true);
      expect(messages.every(message => message.data?.organizationBound === false)).toBe(true);
    });

    it('delivers a question -> permission move inside the delivery window', async () => {
      const { doInstance, mockCtx, messages } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const clock = useDeliveryWindowClock();
      clock.tick();
      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
      await flushAsync();
      expect(messages).toHaveLength(1);
      // No clock tick: still inside the delivery window. The Approve control
      // gates nothing here except this window, so the move must not wait it out.
      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'permission')]);
      await flushAsync();
      expect(messages.map(message => message.data)).toMatchObject([
        { needsInput: 1, needsApproval: 0 },
        { needsInput: 1, needsApproval: 1 },
      ]);
    });

    it('defers a counts-only move inside the delivery window and arms the trailing alarm', async () => {
      const { doInstance, mockCtx, messages, channelStorage } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const clock = useDeliveryWindowClock();
      clock.tick();
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await flushAsync();
      expect(messages).toHaveLength(1);
      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'idle')]);
      await flushAsync();
      // Deferred to the trailing alarm, not delivered on the spot.
      expect(messages).toHaveLength(1);
      // The deferral is stored and the alarm is armed at its deadline. Without
      // both, the trailing delivery that lands the final counts never runs and
      // the deferral is a silent drop.
      const pending = (await channelStorage.get(pendingGlanceableKey('usr_1', null))) as
        | { dueAt: number }
        | undefined;
      expect(pending).toMatchObject({ userId: 'usr_1', organizationId: null });
      expect(channelStorage.setAlarm).toHaveBeenCalledWith(pending?.dueAt);
    });

    it('does not authorize a foreign-owned row from a real authenticated heartbeat', async () => {
      const { doInstance, mockCtx, messages } = setupGlanceableDelivery(['foreign']);
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('foreign')]);
      await flushAsync();
      expect(messages).toEqual([]);
      expect(allSent(cliWs)).toContainEqual({ type: 'heartbeat_ack' });
    });

    it('resends only when a reorder, rename, or child attention changes the roots', async () => {
      const { doInstance, mockCtx, messages } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const clock = useDeliveryWindowClock();
      clock.tick();
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2', 'retry')]);
      await flushAsync();
      // A reorder and a rename leave every root status unchanged: no resend.
      clock.tick();
      sendHeartbeat(doInstance, cliWs, [makeSession('s2', 'retry', 'Renamed'), makeSession('s1')]);
      await flushAsync();
      // A child raise hoists NEEDS INPUT onto its root, so the counts change.
      clock.tick();
      sendHeartbeat(doInstance, cliWs, [
        makeSession('s1'),
        makeSession('s2', 'retry'),
        makeSession('child', 'question', 'Child', 's1'),
      ]);
      await flushAsync();
      clock.tick();
      sendHeartbeat(doInstance, cliWs, [
        makeSession('s1'),
        makeSession('s2', 'retry'),
        makeSession('child', 'busy', 'Child', 's1'),
      ]);
      await flushAsync();
      expect(messages.map(message => message.data)).toMatchObject([
        { running: 1, needsInput: 1, idle: 0 },
        { running: 0, needsInput: 2, idle: 0 },
        { running: 1, needsInput: 1, idle: 0 },
      ]);
    });

    it('ignores child-only heartbeats and disconnects', async () => {
      const { doInstance, mockCtx, messages } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('child', 'busy', 'Child', 'parent')]);
      await flushAsync();
      await disconnectCli(doInstance, cliWs);
      await flushAsync();
      expect(messages).toEqual([]);
    });

    it('uses the persisted heartbeat attachment before delivery and after hibernation', async () => {
      const { doInstance, mockCtx, ctx, env, messages } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'retry')]);
      await flushAsync();
      const restored = new UserConnectionDO(ctx as never, env as Env);
      expect(restored.getActiveSessions()).toMatchObject([{ id: 's1', status: 'retry' }]);
      sendHeartbeat(restored, cliWs, [makeSession('s1', 'retry')]);
      await flushAsync();
      expect(messages.map(message => message.data)).toMatchObject([{ running: 0, needsInput: 1 }]);
    });

    it('delivers an empty aggregate when a root disappears from the heartbeat', async () => {
      const { doInstance, mockCtx, messages } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const clock = useDeliveryWindowClock();
      clock.tick();
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await flushAsync();
      clock.tick();
      sendHeartbeat(doInstance, cliWs, []);
      await flushAsync();
      expect(messages.map(message => message.data)).toMatchObject([
        { running: 1 },
        { status: 'empty', running: 0, needsInput: 0, idle: 0 },
      ]);
    });

    it.each([true, false])(
      'delivers disconnect without clearing the raise (socket still listed: %s)',
      async listed => {
        const { doInstance, mockCtx, ctx, messages } = setupGlanceableDelivery();
        const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
        const clock = useDeliveryWindowClock();
        clock.tick();
        sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
        await flushAsync();
        messages.length = 0;
        if (!listed) mockCtx.removeSocket(cliWs);
        // The disconnect's empty aggregate is a counts-only change and the
        // preceding heartbeat consumed the delivery window, so step the clock
        // past it; otherwise the refresh is deferred to the alarm.
        clock.tick();
        await disconnectCli(doInstance, cliWs);
        await flushAsync();
        // The raise is held, not cleared: no delegate write happens on the
        // disconnect, so the disconnect broadcast does not wait for one.
        expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
        expect(ctx.storage.store.has('attentionReset:s1')).toBe(true);
        expect(messages.map(message => message.data)).toMatchObject([
          { status: 'empty', running: 0, needsInput: 0, idle: 0 },
        ]);
      }
    );

    it('names the owning root when a disconnecting CLI owned a permission subagent', async () => {
      // A subagent raise carries `permission` on the child row and is only
      // hoisted onto its root for display. The disconnect caller names root ids
      // in `cliSessionIds`, so naming the child id in `approvalChangedSessionIds`
      // would be unknown to the server's batch query, which resolves it to the
      // personal scope — the org scope whose permission cleared would lose the
      // delivery-window exemption and the Approve control would lag a window.
      const { doInstance, mockCtx, env } = setupGlanceableDelivery();
      const service = env.NOTIFICATIONS as unknown as NotificationsService;
      const refreshParams: unknown[] = [];
      const spy = async (params: unknown) => {
        refreshParams.push(params);
      };
      service.refreshGlanceableSessions = spy as never;
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      sendHeartbeat(doInstance, cliWs, [
        makeSession('root'),
        makeSession('child', 'permission', 'Child', 'root'),
      ]);
      await flushAsync();
      refreshParams.length = 0; // the heartbeat's own refresh is a different case
      await disconnectCli(doInstance, cliWs);
      await flushAsync();
      // The named ids must stay a subset of `cliSessionIds`: the root owns the
      // child's raise, so it is the root's scope that actually moved.
      expect(refreshParams).toEqual([
        { userId: 'usr_1', cliSessionIds: ['root'], approvalChangedSessionIds: ['root'] },
      ]);
    });

    it.each(['cli-1', 'cli-2'])(
      'does not send a stale close after replacement by %s',
      async replacementId => {
        const { doInstance, mockCtx, messages } = setupGlanceableDelivery();
        const oldCli = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
        sendHeartbeat(doInstance, oldCli, [makeSession('s1')]);
        await flushAsync();
        const nextCli = addCliSocket(mockCtx, replacementId, [], undefined, 'usr_1');
        sendHeartbeat(doInstance, nextCli, [makeSession('s1')]);
        await flushAsync();
        mockCtx.removeSocket(oldCli);
        await disconnectCli(doInstance, oldCli);
        await flushAsync();
        expect(messages.map(message => message.data)).toMatchObject([{ running: 1 }]);
        expect(doInstance.getActiveSessions()).toMatchObject([
          { id: 's1', connectionId: replacementId },
        ]);
      }
    );

    it('never infers user identity for legacy sockets', async () => {
      const { doInstance, mockCtx, messages } = setupGlanceableDelivery();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await flushAsync();
      await disconnectCli(doInstance, cliWs);
      await flushAsync();
      expect(messages).toEqual([]);
    });

    it('keeps heartbeat state and acknowledgement when aggregate transport fails', async () => {
      const { doInstance, mockCtx } = setup({
        NOTIFICATIONS: {
          refreshGlanceableSessions: async () => {
            throw new Error('transport unavailable');
          },
        } as unknown as Env['NOTIFICATIONS'],
      });
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'retry')]);
      await flushAsync();
      expect(doInstance.getActiveSessions()).toMatchObject([{ id: 's1', status: 'retry' }]);
      expect(allSent(cliWs)).toContainEqual({ type: 'heartbeat_ack' });
    });
  });

  describe('heartbeat processing', () => {
    it('updates session ownership and persists attachment', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      addWebSocket(mockCtx, 'web-1');

      const sessions = [makeSession('s1'), makeSession('s2')];
      sendHeartbeat(doInstance, cliWs, sessions);

      const att = cliWs.deserializeAttachment() as { sessions: unknown[] };
      expect(att.sessions).toEqual(sessions);
    });

    it('removes session ownership when session disappears from heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const webWs2 = addWebSocket(mockCtx, 'web-2');
      await sendCommand(doInstance, webWs2, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's2',
      });
      const resp = parseSent(webWs2);
      expect(resp).toMatchObject({
        type: 'response',
        id: 'cmd-1',
        error: 'Session owner not found',
      });
    });

    it('fails an in-flight command when the session owner changes', async () => {
      const { doInstance, mockCtx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      firstOwner.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(firstOwner);
      webWs.send.mockClear();

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);
      await flushAsync();

      // The owner-change heartbeat broadcasts sessions.heartbeat and also fires
      // the SESSION_OWNER_CHANGED error response for the in-flight command. The
      // test cares about the latter; find it by type+id.
      expect(allSent(webWs).find(m => m.type === 'response' && m.id === 'cmd-1')).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
      await sendCliResponse(doInstance, firstOwner, {
        id: correlationId,
        result: 'late',
      });
      // The late sendCliResponse is filtered (the pending entry was already
      // removed by the owner-change path) so webWs sees exactly the two
      // messages produced by the owner-change heartbeat itself: the broadcast
      // sessions.heartbeat and the SESSION_OWNER_CHANGED error response.
      expect(webWs.send).toHaveBeenCalledTimes(2);
    });

    it('replays existing web subscriptions when a session gets a new CLI owner', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      const webWs = mockCtx.sockets.find(s => s._tags.includes('web'))!;
      await sendSubscribe(doInstance, webWs, 's1');

      cli1.send.mockClear();
      cli2.send.mockClear();

      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      const cli2Msgs = allSent(cli2);
      expect(cli2Msgs).toContainEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('broadcasts heartbeat to every web socket regardless of subscription', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const subWeb = addWebSocket(mockCtx, 'web-sub');
      const otherWeb = addWebSocket(mockCtx, 'web-other');

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);
      sendHeartbeat(doInstance, cli2, [makeSession('s2')]);

      await sendSubscribe(doInstance, subWeb, 's1');
      await sendSubscribe(doInstance, otherWeb, 's2');
      subWeb.send.mockClear();
      otherWeb.send.mockClear();

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      expect(subWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(subWeb)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1' },
      });
      expect(otherWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(otherWeb)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1' },
      });
    });

    it('delivers one heartbeat per web socket (delivery count equals ws count)', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const web1 = addWebSocket(mockCtx, 'web-1');
      const web2 = addWebSocket(mockCtx, 'web-2');
      const web3 = addWebSocket(mockCtx, 'web-3');

      // No subscriptions — the broadcast must still hit every web socket.
      web1.send.mockClear();
      web2.send.mockClear();
      web3.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      expect(web1.send).toHaveBeenCalledTimes(1);
      expect(web2.send).toHaveBeenCalledTimes(1);
      expect(web3.send).toHaveBeenCalledTimes(1);

      for (const ws of [web1, web2, web3]) {
        const sent = parseSent(ws) as {
          data: { connectionId: string; sessions: unknown[] };
        };
        expect(sent).toMatchObject({
          type: 'system',
          event: 'sessions.heartbeat',
          data: { connectionId: 'cli-1', sessions: [{ id: 's1' }] },
        });
      }
    });

    it('forwards the CLI-reported protocolVersion to every web socket', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        protocolVersion: '1',
      });
      await sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        protocolVersion: '1',
      });

      expect(parseSent(webWs)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1', protocolVersion: '1' },
      });
    });

    it('omits protocolVersion for a legacy CLI that never reports one', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const sent = parseSent(webWs) as { data: Record<string, unknown> };
      expect(sent.data).not.toHaveProperty('protocolVersion');
    });

    it('broadcasts removed-session information to every web socket (no subscriber special-case)', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const subWeb = addWebSocket(mockCtx, 'web-sub');
      const otherWeb = addWebSocket(mockCtx, 'web-other');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendSubscribe(doInstance, subWeb, 's1');
      subWeb.send.mockClear();
      otherWeb.send.mockClear();

      sendHeartbeat(doInstance, cliWs, []);

      expect(subWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(subWeb)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1', sessions: [] },
      });
      expect(otherWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(otherWeb)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1', sessions: [] },
      });
    });

    it('delivers heartbeat to web sockets that are not subscribed to anything', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1', sessions: [{ id: 's1' }] },
      });
    });

    it('schedules stale alarm on heartbeat', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
    });

    it('sends heartbeat_ack to CLI socket', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const msgs = allSent(cliWs);
      expect(msgs).toContainEqual({ type: 'heartbeat_ack' });
    });

    it('broadcasts a heartbeat session prLink to web sockets', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [
        {
          id: 's1',
          status: 'busy',
          title: 'PR session',
          prLink: { platform: 'github', prUrl: 'https://github.com/o/r/pull/42', prNumber: 42 },
        },
      ]);

      expect(parseSent(webWs)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: {
          connectionId: 'cli-1',
          sessions: [
            {
              id: 's1',
              prLink: {
                platform: 'github',
                prUrl: 'https://github.com/o/r/pull/42',
                prNumber: 42,
              },
            },
          ],
        },
      });
    });

    it('projects capabilities.attachments=true on every aggregateSessions row when the owning CLI advertises it', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')], {
        capabilities: { attachments: true },
      });

      const rows = doInstance.getActiveSessions();
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.capabilities).toEqual({ attachments: true });
      }
    });

    it('projects the latest connection capabilities onto every sessions.heartbeat row', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);
      await sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')], {
        capabilities: { attachments: true },
      });

      expect(parseSent(webWs)).toMatchObject({
        data: {
          sessions: [
            { id: 's1', capabilities: { attachments: true } },
            { id: 's2', capabilities: { attachments: true } },
          ],
        },
      });

      webWs.send.mockClear();
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);
      expect(parseSent(webWs)).toMatchObject({
        data: { sessions: [{ id: 's1' }, { id: 's2' }] },
      });
      const legacyRows = (parseSent(webWs) as { data: { sessions: Record<string, unknown>[] } })
        .data.sessions;
      expect(legacyRows.every(row => !Object.hasOwn(row, 'capabilities'))).toBe(true);

      webWs.send.mockClear();
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')], {
        capabilities: { attachments: false },
      });
      expect(parseSent(webWs)).toMatchObject({
        data: {
          sessions: [
            { id: 's1', capabilities: { attachments: false } },
            { id: 's2', capabilities: { attachments: false } },
          ],
        },
      });
    });

    it('omits capabilities from aggregateSessions rows when the latest heartbeat omits the field (legacy CLI)', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const rows = doInstance.getActiveSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('capabilities');
    });

    it('omits capabilities from sessions.heartbeat event envelope when the latest heartbeat omits the field', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });
      await sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const sent = parseSent(webWs) as { data: Record<string, unknown> };
      expect(sent.data).not.toHaveProperty('capabilities');
    });

    it('flips capabilities.attachments from true to false on the next heartbeat (CLI revocation)', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });
      expect(doInstance.getActiveSessions()[0].capabilities).toEqual({
        attachments: true,
      });

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: false },
      });

      const rows = doInstance.getActiveSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0].capabilities).toEqual({ attachments: false });
    });

    it('flips capabilities.attachments from absent to true when a legacy CLI starts advertising it', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      const legacy = doInstance.getActiveSessions();
      expect(legacy[0]).not.toHaveProperty('capabilities');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });

      const upgraded = doInstance.getActiveSessions();
      expect(upgraded[0].capabilities).toEqual({ attachments: true });
    });

    it('flips capabilities.attachments from false to true on the next heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: false },
      });
      expect(doInstance.getActiveSessions()[0].capabilities).toEqual({
        attachments: false,
      });

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });

      expect(doInstance.getActiveSessions()[0].capabilities).toEqual({
        attachments: true,
      });
    });

    it('projects the same owning-connection capabilities on every session row of a multi-session heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')], {
        capabilities: { attachments: false },
      });

      const rows = doInstance.getActiveSessions();
      expect(rows).toHaveLength(2);
      expect(rows[0].capabilities).toEqual({ attachments: false });
      expect(rows[1].capabilities).toEqual({ attachments: false });
    });

    it('reconstructs capabilities from a hibernated CLI attachment', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = createMockWs(['cli'], {
        role: 'cli',
        connectionId: 'cli-hiber',
        sessions: [makeSession('s1')],
        capabilities: { attachments: true },
      });
      mockCtx.addSocket(cliWs);

      const rows = doInstance.getActiveSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0].capabilities).toEqual({ attachments: true });
    });
  });

  describe('stale connection eviction', () => {
    it('closes stale connection after timeout', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      vi.spyOn(Date, 'now')
        .mockReturnValueOnce(Date.now() + 31_000) // for ensureState check
        .mockReturnValue(Date.now() + 31_000); // for alarm's Date.now()

      await doInstance.alarm();

      expect(cliWs.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
    });

    it('reschedules alarm if other live connections remain', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const staleCli = addCliSocket(mockCtx, 'stale-1');
      const freshCli = addCliSocket(mockCtx, 'fresh-1');

      sendHeartbeat(doInstance, staleCli, [makeSession('s1')]);
      sendHeartbeat(doInstance, freshCli, [makeSession('s2')]);

      ctx.storage.setAlarm.mockClear();

      const now = Date.now();
      const staleTime = now + 31_000;
      vi.spyOn(Date, 'now').mockReturnValue(staleTime);

      sendHeartbeat(doInstance, freshCli, [makeSession('s2')]);
      ctx.storage.setAlarm.mockClear();

      await doInstance.alarm();

      expect(staleCli.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
      expect(freshCli.close).not.toHaveBeenCalled();
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
    });

    it('does not evict connection with recent heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

      await doInstance.alarm();

      expect(cliWs.close).not.toHaveBeenCalled();
    });
  });

  describe('subscribe/unsubscribe', () => {
    it('sends subscribe to owning CLI when web subscribes', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      await sendSubscribe(doInstance, webWs, 's1');

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('sends the active session list when web subscribes after the socket is open', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'busy', 'Fix bug')]);
      webWs.send.mockClear();
      await sendSubscribe(doInstance, webWs, 's1');

      expect(parseSent(webWs)).toEqual({
        type: 'system',
        event: 'sessions.list',
        data: {
          sessions: [
            {
              id: 's1',
              status: 'busy',
              title: 'Fix bug',
              connectionId: 'cli-1',
            },
          ],
        },
      });
    });

    it('broadcasts subscribe to all CLIs when no owner found', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      await sendSubscribe(doInstance, webWs, 's1');

      expect(cli1.send).toHaveBeenCalled();
      expect(cli2.send).toHaveBeenCalled();
      expect(parseSent(cli1)).toEqual({ type: 'subscribe', sessionId: 's1' });
      expect(parseSent(cli2)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('duplicate subscribe is idempotent for attachment', async () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      await sendSubscribe(doInstance, webWs, 's1');
      await sendSubscribe(doInstance, webWs, 's1');

      const att = webWs.deserializeAttachment() as {
        subscribedSessions: string[];
      };
      expect(att.subscribedSessions).toEqual(['s1']);
    });

    it('unsubscribe sends to CLI when last subscriber leaves', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      await sendSubscribe(doInstance, webWs, 's1');
      cliWs.send.mockClear();

      sendUnsubscribe(doInstance, webWs, 's1');

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({
        type: 'unsubscribe',
        sessionId: 's1',
      });
    });

    it('unsubscribe does not send to CLI when other subscribers remain', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const web1 = addWebSocket(mockCtx, 'web-1');
      const web2 = addWebSocket(mockCtx, 'web-2');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      await sendSubscribe(doInstance, web1, 's1');
      await sendSubscribe(doInstance, web2, 's1');
      cliWs.send.mockClear();

      sendUnsubscribe(doInstance, web1, 's1');
      expect(cliWs.send).not.toHaveBeenCalled();

      sendUnsubscribe(doInstance, web2, 's1');
      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({
        type: 'unsubscribe',
        sessionId: 's1',
      });
    });
  });

  describe('viewer liveness', () => {
    it('replies to a viewer ping with the matching nonce only', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'viewer-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      ctx.storage.setAlarm.mockClear();
      cliWs.send.mockClear();
      webWs.send.mockClear();

      sendPing(doInstance, webWs, 'nonce-1');

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({ type: 'pong', nonce: 'nonce-1' });
      expect(doInstance.getActiveSessions()).toEqual([
        { id: 's1', status: 'busy', title: 'Test', connectionId: 'cli-1' },
      ]);
      expect(cliWs.send).not.toHaveBeenCalled();
      expect(ctx.storage.setAlarm).not.toHaveBeenCalled();
      expect(webWs.deserializeAttachment()).toEqual({
        role: 'web',
        connectionId: 'viewer-1',
        subscribedSessions: [],
        kiloUserId: 'usr_1',
      });
    });
  });

  describe('viewer connection identity', () => {
    it('replaces an older web viewer with the same connectionId and broadcasts only to its replacement', async () => {
      const { doInstance, mockCtx } = setup();
      const oldWeb = connectWebSocket(doInstance, 'viewer-1');
      oldWeb.send.mockClear();

      const newWeb = connectWebSocket(doInstance, 'viewer-1');
      newWeb.send.mockClear();

      expect(oldWeb.close).toHaveBeenCalledWith(1000, 'replaced by reconnect');

      await doInstance.notifySessionEvent({
        type: 'session.deleted',
        data: {
          source: 'v2',
          sessionId: 's1',
          parentSessionId: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          createdOnPlatform: 'web',
          deletedAt: '2026-01-01T00:00:02.000Z',
        },
      });

      expect(oldWeb.send).not.toHaveBeenCalled();
      expect(newWeb.send).toHaveBeenCalledTimes(1);
      expect(mockCtx.sockets.filter(socket => socket._tags.includes('web'))).toHaveLength(2);
    });

    it('does not migrate old subscriptions when replacing a viewer', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      const oldWeb = connectWebSocket(doInstance, 'viewer-1');
      await sendSubscribe(doInstance, oldWeb, 's1');
      cliWs.send.mockClear();

      const newWeb = connectWebSocket(doInstance, 'viewer-1');

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({
        type: 'unsubscribe',
        sessionId: 's1',
      });
      expect(newWeb.deserializeAttachment()).toEqual({
        role: 'web',
        connectionId: 'viewer-1',
        subscribedSessions: [],
        kiloUserId: 'usr_1',
      });
    });

    it('ignores messages from a viewer that has been replaced', async () => {
      const { doInstance } = setup();
      const oldWeb = connectWebSocket(doInstance, 'viewer-1');
      connectWebSocket(doInstance, 'viewer-1');
      oldWeb.send.mockClear();

      sendPing(doInstance, oldWeb, 'stale-ping');

      expect(oldWeb.send).not.toHaveBeenCalled();
    });

    it('keeps distinct viewer identities connected for independent broadcasts', async () => {
      const { doInstance } = setup();
      const firstWeb = connectWebSocket(doInstance, 'viewer-1');
      const secondWeb = connectWebSocket(doInstance, 'viewer-2');
      firstWeb.send.mockClear();
      secondWeb.send.mockClear();

      await doInstance.notifySessionEvent({
        type: 'session.deleted',
        data: {
          source: 'v2',
          sessionId: 's1',
          parentSessionId: null,
          organizationId: null,
          gitUrl: null,
          gitBranch: null,
          createdOnPlatform: 'web',
          deletedAt: '2026-01-01T00:00:02.000Z',
        },
      });

      expect(firstWeb.close).not.toHaveBeenCalled();
      expect(firstWeb.send).toHaveBeenCalledTimes(1);
      expect(secondWeb.send).toHaveBeenCalledTimes(1);
    });

    it('does not replace a CLI socket when a viewer connectionId collides', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'shared-id');

      connectWebSocket(doInstance, 'shared-id');

      expect(cliWs.close).not.toHaveBeenCalled();
    });
  });

  describe('CLI disconnect', () => {
    it('cleans up session ownership and broadcasts cli.disconnected', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(webWs.send).toHaveBeenCalled();
      const msgs = allSent(webWs);
      const disconnectMsg = msgs.find(
        (m: Record<string, unknown>) => m.type === 'system' && m.event === 'cli.disconnected'
      );
      expect(disconnectMsg).toEqual({
        type: 'system',
        event: 'cli.disconnected',
        data: { connectionId: 'cli-1' },
      });

      const web2 = addWebSocket(mockCtx, 'web-2');
      await sendCommand(doInstance, web2, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      expect(parseSent(web2)).toMatchObject({
        type: 'response',
        error: 'Session owner not found',
      });
    });

    it('sends error responses for pending commands on disconnect', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      const msgs = allSent(webWs);
      const errorResp = msgs.find(
        (m: Record<string, unknown>) => m.type === 'response' && m.id === 'cmd-1'
      );
      expect(errorResp).toMatchObject({
        type: 'response',
        id: 'cmd-1',
        error: 'CLI disconnected',
      });
    });

    it('reports owner change when an owner-fenced command target disconnects', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
    });

    it('fails pending commands as soon as their target socket is replaced', async () => {
      const { doInstance, mockCtx } = setup();
      const firstCli = connectCliSocket(doInstance, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstCli, [makeSession('s1')]);
      firstCli.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      webWs.send.mockClear();

      connectCliSocket(doInstance, 'cli-1');

      await flushAsync();

      expect(firstCli.close).toHaveBeenCalledWith(1000, 'replaced by reconnect');
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
    });

    it('sends error for connection-routed pending commands on CLI disconnect', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);

      await sendCommand(doInstance, webWs, {
        id: 'cmd-conn',
        command: 'send_message',
        connectionId: 'cli-1',
      });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      const msgs = allSent(webWs);
      const errorResp = msgs.find(
        (m: Record<string, unknown>) => m.type === 'response' && m.id === 'cmd-conn'
      );
      expect(errorResp).toMatchObject({
        type: 'response',
        id: 'cmd-conn',
        error: 'CLI disconnected',
      });
    });

    it('sends error for fallback-routed pending commands on CLI disconnect', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);

      await sendCommand(doInstance, webWs, {
        id: 'cmd-fallback',
        command: 'send_message',
      });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      const msgs = allSent(webWs);
      const errorResp = msgs.find(
        (m: Record<string, unknown>) => m.type === 'response' && m.id === 'cmd-fallback'
      );
      expect(errorResp).toMatchObject({
        type: 'response',
        id: 'cmd-fallback',
        error: 'CLI disconnected',
      });
    });

    it('reconnecting CLI — old socket close does not destroy state', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      const cli2 = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      // CLI1's close event fires (stale socket), but cli2 still holds the connectionId
      // DON'T remove cli2 from sockets — cli2 is the replacement
      // Just remove cli1 to simulate it being closed
      mockCtx.removeSocket(cli1);
      await disconnectCli(doInstance, cli1);

      cli2.send.mockClear();
      await sendSubscribe(doInstance, webWs, 's1');
      expect(cli2.send).toHaveBeenCalled();
      expect(parseSent(cli2)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('reconnecting CLI — commands sent to replacement socket are not spuriously failed', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      // cli2 connects with the same connectionId (reconnect).
      // In production, closeStaleSocket removes cli1 before cli2 is accepted.
      // Simulate that by removing cli1 from the socket list first.
      mockCtx.removeSocket(cli1);
      const cli2 = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      cli2.send.mockClear();
      webWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-new',
        command: 'send_message',
        sessionId: 's1',
      });
      expect(cli2.send).toHaveBeenCalled();
      const correlationId = getCorrelationId(cli2);

      webWs.send.mockClear();

      await disconnectCli(doInstance, cli1);

      const errorMsgs = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'cmd-new' && m.error
      );
      expect(errorMsgs).toHaveLength(0);

      webWs.send.mockClear();
      await sendCliResponse(doInstance, cli2, { id: correlationId, result: 'ok' });

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-new',
        result: 'ok',
      });
    });

    it('reconnecting CLI — pending commands from old socket get error responses', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();

      const cli2 = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      // cli1's close event fires — cmd-1 was sent on cli1's wire, cli2 never saw it
      mockCtx.removeSocket(cli1);
      await disconnectCli(doInstance, cli1);

      const msgs = allSent(webWs);
      const errorResp = msgs.find(
        (m: Record<string, unknown>) => m.type === 'response' && m.id === 'cmd-1'
      );
      expect(errorResp).toMatchObject({
        type: 'response',
        id: 'cmd-1',
        error: 'CLI disconnected',
      });
    });

    it('holds attention for owned sessions for the CLI absence window on disconnect', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('s-question', 'question'),
        makeSession('s-busy', 'busy'),
      ]);
      webWs.send.mockClear();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // Leave the socket in getWebSockets() — matches workerd during webSocketClose.
      await disconnectCli(doInstance, cliWs);

      // A dropped socket is not proof the CLI is gone: the raise is held, not
      // cleared, so the user can still answer once the CLI is back.
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
      expect(sessionIngestMocks.getSessionIngestDO).not.toHaveBeenCalled();
      expect(ctx.storage.store.get('attentionReset:s-question')).toEqual({
        kiloUserId: 'usr_1',
        dueAt: now + CLI_ABSENCE_ATTENTION_RESET_MS,
        connectionId: 'cli-1',
      });
      expect(ctx.storage.store.get('attentionReset:s-busy')).toMatchObject({
        kiloUserId: 'usr_1',
        dueAt: now + CLI_ABSENCE_ATTENTION_RESET_MS,
      });
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('holds attention when the closing socket is still listed in getWebSockets (workerd)', async () => {
      // Production wrangler/workerd keeps the closing WebSocket in getWebSockets()
      // during webSocketClose. Matching connectionId without excluding self would
      // treat every disconnect as a stale reconnect and skip the attention hold.
      // Prior unit tests always called removeSocket first, so they never caught this.
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s-question', 'question')]);
      webWs.send.mockClear();
      sessionIngestMocks.getSessionIngestDO.mockClear();
      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockClear();

      // Do NOT removeSocket — mirrors workerd during webSocketClose.
      expect(mockCtx.sockets).toContain(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
      expect(ctx.storage.store.has('attentionReset:s-question')).toBe(true);
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('does not hold attention when kiloUserId is missing on the attachment', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(sessionIngestMocks.getSessionIngestDO).not.toHaveBeenCalled();
      expect(ctx.storage.store.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        'Skipping attention status reset on CLI disconnect: missing kiloUserId on attachment',
        { ownedSessionCount: 1 }
      );
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('does not hold attention for sessions owned by another live connection', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const cli2 = addCliSocket(mockCtx, 'cli-2', [], undefined, 'usr_1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1', 'question')]);
      sendHeartbeat(doInstance, cli2, [makeSession('s1', 'question')]);
      webWs.send.mockClear();
      sessionIngestMocks.getSessionIngestDO.mockClear();
      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockClear();

      mockCtx.removeSocket(cli1);
      await disconnectCli(doInstance, cli1);

      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
      expect(ctx.storage.store.has('attentionReset:s1')).toBe(false);
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('stale reconnect close does not hold attention status', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const cli2 = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1', 'question')]);
      sendHeartbeat(doInstance, cli2, [makeSession('s1', 'question')]);
      sessionIngestMocks.getSessionIngestDO.mockClear();
      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockClear();

      mockCtx.removeSocket(cli1);
      await disconnectCli(doInstance, cli1);

      expect(sessionIngestMocks.getSessionIngestDO).not.toHaveBeenCalled();
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
      expect(ctx.storage.store.has('attentionReset:s1')).toBe(false);
    });

    it('clears held attention once the CLI absence window elapses', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      vi.spyOn(Date, 'now').mockReturnValue(now + CLI_ABSENCE_ATTENTION_RESET_MS - 1_000);
      await doInstance.alarm();
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
      expect(ctx.storage.store.has('attentionReset:s1')).toBe(true);

      vi.spyOn(Date, 'now').mockReturnValue(now + CLI_ABSENCE_ATTENTION_RESET_MS + 1);
      await doInstance.alarm();

      expect(sessionIngestMocks.getSessionIngestDO).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: 'usr_1',
        sessionId: 's1',
      });
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).toHaveBeenCalledWith(
        'usr_1',
        's1'
      );
      expect(ctx.storage.store.has('attentionReset:s1')).toBe(false);
    });

    it('keeps held attention when a live CLI re-owns the session within the window', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);
      expect(ctx.storage.store.has('attentionReset:s1')).toBe(true);

      const reconnected = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      sendHeartbeat(doInstance, reconnected, [makeSession('s1', 'question')]);
      await flushAsync();

      expect(ctx.storage.store.has('attentionReset:s1')).toBe(false);

      vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60_000);
      await doInstance.alarm();
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
    });

    it('re-arms a held clear whose delegate write failed instead of dropping it', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockRejectedValueOnce(
        new Error('db down')
      );
      vi.spyOn(Date, 'now').mockReturnValue(now + CLI_ABSENCE_ATTENTION_RESET_MS + 1);
      await doInstance.alarm();

      expect(ctx.storage.store.get('attentionReset:s1')).toMatchObject({
        dueAt: now + CLI_ABSENCE_ATTENTION_RESET_MS + 1 + 5_000,
      });
      expect(error).toHaveBeenCalledWith(
        'Failed to reset attention status after the CLI absence window',
        expect.objectContaining({ sessionId: 's1', error: 'db down' })
      );
    });

    it('keeps the alarm when a held attention reset outlives its in-memory mirror', async () => {
      const { ctx } = setup();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      // The hold was written durably, then the DO was evicted: every in-memory
      // set is gone while the KV entry (the source of truth) remains.
      await ctx.storage.put('attentionReset:s1', {
        kiloUserId: 'usr_1',
        dueAt: now + CLI_ABSENCE_ATTENTION_RESET_MS,
        connectionId: 'cli-1',
      });
      const revived = new UserConnectionDO(ctx as never, {} as Env);

      // Any later RPC that clears an unrelated session must not drop the alarm
      // the durable hold is waiting on.
      await revived.clearSession('s-other');

      expect(ctx.storage.deleteAlarm).not.toHaveBeenCalled();
      // The hold is still armed, so the durable entry cannot strand.
      await flushAsync();
      expect(ctx.storage.setAlarm).toHaveBeenCalledWith(now + CLI_ABSENCE_ATTENTION_RESET_MS);

      // The hold still fires once its window elapses.
      vi.spyOn(Date, 'now').mockReturnValue(now + CLI_ABSENCE_ATTENTION_RESET_MS + 1);
      await revived.alarm();
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).toHaveBeenCalledWith(
        'usr_1',
        's1'
      );
      expect(ctx.storage.store.has('attentionReset:s1')).toBe(false);
    });

    it('arms the alarm for a durable held reset whose mirror was lost', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await ctx.storage.put('attentionReset:s1', {
        kiloUserId: 'usr_1',
        dueAt: now + 5_000,
        connectionId: 'cli-1',
      });
      const internal = doInstance as unknown as {
        pendingAttentionResetAt: Map<string, number>;
      };
      expect(internal.pendingAttentionResetAt.size).toBe(0);

      // A wake that only ends in scheduleNextAlarm must re-list KV: the durable
      // hold has to get the alarm that fires it.
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      ctx.storage.setAlarm.mockClear();
      sendHeartbeat(doInstance, cliWs, []);
      await flushAsync();

      expect(internal.pendingAttentionResetAt.get('s1')).toBe(now + 5_000);
      expect(ctx.storage.setAlarm).toHaveBeenCalledWith(now + 5_000);
    });

    it('durably cancels a held reset when a reconnect re-owns the session after eviction', async () => {
      const { mockCtx, ctx } = setup();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      // The hold was written durably, then the DO was evicted: the in-memory
      // mirror is empty until `scheduleNextAlarm`'s asynchronous re-list.
      await ctx.storage.put('attentionReset:s1', {
        kiloUserId: 'usr_1',
        dueAt: now + CLI_ABSENCE_ATTENTION_RESET_MS,
        connectionId: 'cli-1',
      });
      const revived = new UserConnectionDO(ctx as never, {} as Env);
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');

      sendHeartbeat(revived, cliWs, [makeSession('s1', 'question')]);
      await flushAsync();

      // The reconnect must delete the durable hold even though the mirror had
      // no entry when the cancel ran, and the re-list must not re-arm it.
      expect(ctx.storage.store.has('attentionReset:s1')).toBe(false);

      vi.spyOn(Date, 'now').mockReturnValue(now + CLI_ABSENCE_ATTENTION_RESET_MS + 1);
      await revived.alarm();
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
    });
  });

  describe('web disconnect', () => {
    it('removes from all subscription sets', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);
      await sendSubscribe(doInstance, webWs, 's1');
      await sendSubscribe(doInstance, webWs, 's2');

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      const cliEventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: {},
      });
      void doInstance.webSocketMessage(cliWs as never, cliEventMsg);
    });

    it('sends unsubscribe to CLI when last subscriber leaves', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendSubscribe(doInstance, webWs, 's1');
      cliWs.send.mockClear();

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      const msgs = allSent(cliWs);
      const unsub = msgs.find((m: Record<string, unknown>) => m.type === 'unsubscribe');
      expect(unsub).toEqual({ type: 'unsubscribe', sessionId: 's1' });
    });

    it('cleans up pending commands from disconnecting web socket', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: 'ok' });
    });
  });

  describe('command routing', () => {
    it('routes web command to correct CLI by sessionId', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
        data: { text: 'hello' },
      });

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      const sent = parseSent(cliWs) as Record<string, unknown>;
      expect(sent).toMatchObject({
        type: 'command',
        command: 'send_message',
        sessionId: 's1',
        data: { text: 'hello' },
      });
      expect(typeof sent.id).toBe('string');
      expect(sent.id).not.toBe('cmd-1');
    });

    it('routes CLI response to correct web socket with original id', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });

      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { success: true },
      });

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result: { success: true },
      });
    });

    it('sanitizes a relay-shaped CLI error before forwarding it to web', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'cli',
          message: 'Command failed',
        },
      });
    });

    it('preserves CLI string errors for old-CLI compatibility', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_models',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'unknown command: list_models',
      });
    });

    it('accepts a pending response only from the targeted CLI socket', async () => {
      const { doInstance, mockCtx } = setup();
      const targetCli = addCliSocket(mockCtx, 'cli-1');
      const otherCli = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, targetCli, [makeSession('s1')]);
      sendHeartbeat(doInstance, otherCli, []);
      targetCli.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(targetCli);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, otherCli, {
        id: correlationId,
        result: 'wrong-owner',
      });
      expect(webWs.send).not.toHaveBeenCalled();

      await sendCliResponse(doInstance, targetCli, {
        id: correlationId,
        result: 'ok',
      });
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result: 'ok',
      });
    });

    it('rejects a duplicate in-flight list_models request for the same viewer session and owner', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      await sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-2',
        error: {
          source: 'relay',
          code: 'CATALOG_REQUEST_PENDING',
          message: 'Model catalog request already pending',
        },
      });
      expect(allSent(cliWs).filter(message => message.type === 'command')).toHaveLength(1);
    });

    it('expires pending commands before handling another command', async () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      vi.mocked(Date.now).mockReturnValue(now + 35_001);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'COMMAND_EXPIRED',
          message: 'Command expired',
        },
      });
      expect(allSent(cliWs).filter(message => message.type === 'command')).toHaveLength(2);
    });

    it('does not postpone pending-command expiry when heartbeats reschedule the alarm', async () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });

      ctx.storage.setAlarm.mockClear();
      vi.mocked(Date.now).mockReturnValue(now + 20_000);
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      expect(ctx.storage.setAlarm).toHaveBeenCalledWith(now + 35_000);
    });

    it('expires pending commands during alarm processing', async () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);

      vi.mocked(Date.now).mockReturnValue(now + 34_000);
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();
      vi.mocked(Date.now).mockReturnValue(now + 35_001);

      await doInstance.alarm();

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'COMMAND_EXPIRED',
          message: 'Command expired',
        },
      });
      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: 'late' });
      expect(webWs.send).toHaveBeenCalledTimes(1);
    });

    it('rejects commands after reaching the global pending-command cap', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      for (let index = 0; index < 128; index++) {
        await sendCommand(doInstance, webWs, {
          id: `cmd-${index}`,
          command: 'send_message',
          sessionId: 's1',
        });
      }

      await sendCommand(doInstance, webWs, {
        id: 'cmd-over-cap',
        command: 'send_message',
        sessionId: 's1',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-over-cap',
        error: {
          source: 'relay',
          code: 'PENDING_COMMAND_LIMIT',
          message: 'Too many pending commands',
        },
      });
      expect(allSent(cliWs).filter(message => message.type === 'command')).toHaveLength(128);
    });

    it('accepts a list_models result at exactly 512 KiB', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();
      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('rejects a list_models result one byte over 512 KiB', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1),
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CATALOG_TOO_LARGE',
          message: 'Model catalog response is too large',
        },
      });
    });

    it('rejects a multibyte list_models result over 512 KiB', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: createUtf8OversizedResult(),
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CATALOG_TOO_LARGE',
          message: 'Model catalog response is too large',
        },
      });
    });

    it('returns error when CLI not found for session', async () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx, 'web-1');

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 'unknown-session',
      });

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'Session owner not found',
      });
    });

    it('rejects a stale expected session owner without forwarding', async () => {
      const { doInstance, mockCtx } = setup();
      const currentOwner = addCliSocket(mockCtx, 'cli-1');
      const staleOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, currentOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, staleOwner, []);
      currentOwner.send.mockClear();
      staleOwner.send.mockClear();
      webWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
        connectionId: 'cli-2',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
      expect(currentOwner.send).not.toHaveBeenCalled();
      expect(staleOwner.send).not.toHaveBeenCalled();
    });

    it('routes command by connectionId to specific CLI', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, []);
      sendHeartbeat(doInstance, cli2, []);
      cli1.send.mockClear();
      cli2.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        connectionId: 'cli-2',
      });

      expect(cli1.send).not.toHaveBeenCalled();
      expect(cli2.send).toHaveBeenCalledTimes(1);
    });

    it('two web sockets with the same command id each get the correct response', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const web1 = addWebSocket(mockCtx, 'web-1');
      const web2 = addWebSocket(mockCtx, 'web-2');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      await sendCommand(doInstance, web1, {
        id: 'dup-id',
        command: 'send_message',
        sessionId: 's1',
      });
      const corr1 = getCorrelationId(cliWs, 0);

      await sendCommand(doInstance, web2, {
        id: 'dup-id',
        command: 'send_message',
        sessionId: 's1',
      });
      const corr2 = getCorrelationId(cliWs, 1);

      expect(corr1).not.toBe(corr2);

      web1.send.mockClear();
      web2.send.mockClear();

      await sendCliResponse(doInstance, cliWs, { id: corr1, result: 'result-1' });
      await sendCliResponse(doInstance, cliWs, { id: corr2, result: 'result-2' });

      expect(parseSent(web1)).toEqual({
        type: 'response',
        id: 'dup-id',
        result: 'result-1',
      });
      expect(parseSent(web2)).toEqual({
        type: 'response',
        id: 'dup-id',
        result: 'result-2',
      });
    });

    it('routes to first CLI when no sessionId or connectionId given', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();

      await sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message' });
      expect(cliWs.send).toHaveBeenCalledTimes(1);
    });
  });

  describe('command allowlist', () => {
    const ALLOWED = [
      'send_message',
      'interrupt',
      'question_reply',
      'question_reject',
      'permission_respond',
      'suggestion_accept',
      'suggestion_dismiss',
      'list_models',
      'list_commands',
      'list_directories',
      'send_command',
      'create_session',
      'exit_cli',
    ];

    it('forwards every allowed viewer command to the owning CLI', async () => {
      for (const command of ALLOWED) {
        const { doInstance, mockCtx } = setup();
        const cliWs = addCliSocket(mockCtx, 'cli-1');
        const webWs = addWebSocket(mockCtx, 'web-1');

        sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
        cliWs.send.mockClear();

        await sendCommand(doInstance, webWs, {
          id: 'cmd-1',
          command,
          sessionId: 's1',
          data: command === 'exit_cli' ? { protocolVersion: 1 } : { hello: 'world' },
        });

        expect(cliWs.send).toHaveBeenCalledTimes(1);
        const sent = parseSent(cliWs) as Record<string, unknown>;
        expect(sent).toMatchObject({
          type: 'command',
          command,
          sessionId: 's1',
        });
        expect(typeof sent.id).toBe('string');
        expect(sent.id).not.toBe('cmd-1');
      }
    });

    it('rejects a non-allowlisted command with structured COMMAND_NOT_ALLOWED', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'eval',
        sessionId: 's1',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'COMMAND_NOT_ALLOWED',
          message: 'Command is not allowed',
        },
      });
      expect(cliWs.send).not.toHaveBeenCalled();
    });

    it('rejects a non-allowlisted command even when targeting a known session owner via connectionId', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'shell',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'COMMAND_NOT_ALLOWED',
          message: 'Command is not allowed',
        },
      });
      expect(cliWs.send).not.toHaveBeenCalled();
    });

    it('rejects a non-allowlisted command with an unknown session before owner resolution', async () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx, 'web-1');

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'eval',
        sessionId: 'unknown-session',
      });

      // COMMAND_NOT_ALLOWED wins over "Session owner not found".
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'COMMAND_NOT_ALLOWED',
          message: 'Command is not allowed',
        },
      });
    });

    it('does not allocate a pending entry or forward a disallowed command', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'eval',
        sessionId: 's1',
      });
      const sent = parseSent(webWs) as Record<string, unknown>;
      expect(sent).toMatchObject({ type: 'response', id: 'cmd-1' });
      expect(sent.id).toBe('cmd-1');

      // The CLI must not have received any command envelope, and the DO must
      // not have allocated a pending slot, so a follow-up CLI response for a
      // fabricated correlation id is a no-op.
      expect(cliWs.send).not.toHaveBeenCalled();
      await sendCliResponse(doInstance, cliWs, { id: 'fabricated', result: 'noop' });
      expect(webWs.send).toHaveBeenCalledTimes(1);
    });

    it('still rejects an owner-fenced allowed command with SESSION_OWNER_CHANGED', async () => {
      const { doInstance, mockCtx } = setup();
      const currentOwner = addCliSocket(mockCtx, 'cli-1');
      const staleOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, currentOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, staleOwner, []);
      currentOwner.send.mockClear();
      staleOwner.send.mockClear();
      webWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
        connectionId: 'cli-2',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
      expect(currentOwner.send).not.toHaveBeenCalled();
      expect(staleOwner.send).not.toHaveBeenCalled();
    });
  });

  describe('list_commands dedupe and size cap', () => {
    it('rejects a duplicate in-flight list_commands request for the same viewer session and owner', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      await sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-2',
        error: {
          source: 'relay',
          code: 'CATALOG_REQUEST_PENDING',
          message: 'Model catalog request already pending',
        },
      });
      expect(allSent(cliWs).filter(message => message.type === 'command')).toHaveLength(1);
    });

    it('treats list_models and list_commands as distinct for dedupe purposes', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      await sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      expect(allSent(cliWs).filter(message => message.type === 'command')).toHaveLength(2);
    });

    it('accepts a list_commands result at exactly 512 KiB', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();
      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('rejects a list_commands result one byte over 512 KiB', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1),
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CATALOG_TOO_LARGE',
          message: 'Model catalog response is too large',
        },
      });
    });

    it('rejects a multibyte list_commands result over 512 KiB', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: createUtf8OversizedResult(),
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CATALOG_TOO_LARGE',
          message: 'Model catalog response is too large',
        },
      });
    });
  });

  describe('old CLI upgrade-required mapping', () => {
    it('maps "unknown command: list_commands" to CLI_UPGRADE_REQUIRED with slash message', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_commands',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CLI_UPGRADE_REQUIRED',
          message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
        },
      });
    });

    it('maps "unknown command: list_directories" to CLI_UPGRADE_REQUIRED with slash message', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_directories',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1, path: 'src' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_directories',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CLI_UPGRADE_REQUIRED',
          message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
        },
      });
    });

    it('maps "unknown command: send_command" to CLI_UPGRADE_REQUIRED with slash message', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { command: 'init' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: send_command',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CLI_UPGRADE_REQUIRED',
          message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
        },
      });
    });

    it('maps "unknown command: exit_cli" to CLI_UPGRADE_REQUIRED with slash message', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: exit_cli',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CLI_UPGRADE_REQUIRED',
          message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
        },
      });
    });

    it('maps "unknown command: create_session" to CLI_UPGRADE_REQUIRED with create_session message', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'create_session',
        connectionId: 'cli-1',
        data: { title: 'New session' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: create_session',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'CLI_UPGRADE_REQUIRED',
          message:
            'Creating remote sessions from mobile requires a newer Kilo CLI. Update Kilo CLI and reconnect.',
        },
      });
    });

    it('preserves "unknown command: list_models" because list_models is not in the upgrade-required set', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_models',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'unknown command: list_models',
      });
    });

    it('preserves an unrelated CLI string error for send_command', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        data: { command: 'init' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'session not ready',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'session not ready',
      });
    });

    it('does not match a longer error that merely starts with "unknown command: list_commands"', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_commands: try again',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'unknown command: list_commands: try again',
      });
    });

    it('preserves a longer exit_cli unknown-command error', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: exit_cli: session not ready',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'unknown command: exit_cli: session not ready',
      });
    });
  });

  describe('send_command / create_session negative coverage', () => {
    it('forwards two in-flight same-owner/same-session send_command requests without deduping', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { command: 'init' },
      });
      await sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'send_command',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { command: 'plan' },
      });

      const cliCommands = allSent(cliWs).filter(message => message.type === 'command');
      expect(cliCommands).toHaveLength(2);
      expect(cliCommands[0]).toMatchObject({
        type: 'command',
        command: 'send_command',
        sessionId: 's1',
        data: { command: 'init' },
      });
      expect(cliCommands[1]).toMatchObject({
        type: 'command',
        command: 'send_command',
        sessionId: 's1',
        data: { command: 'plan' },
      });
      expect(cliCommands[0].id).not.toBe(cliCommands[1].id);
      expect(webWs.send).not.toHaveBeenCalled();
    });

    it('forwards two in-flight create_session requests without deduping', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'create_session',
        connectionId: 'cli-1',
        data: { title: 'First session' },
      });
      await sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'create_session',
        connectionId: 'cli-1',
        data: { title: 'Second session' },
      });

      const cliCommands = allSent(cliWs).filter(message => message.type === 'command');
      expect(cliCommands).toHaveLength(2);
      expect(cliCommands[0]).toMatchObject({
        type: 'command',
        command: 'create_session',
        data: { title: 'First session' },
      });
      expect(cliCommands[1]).toMatchObject({
        type: 'command',
        command: 'create_session',
        data: { title: 'Second session' },
      });
      expect(cliCommands[0].id).not.toBe(cliCommands[1].id);
      expect(webWs.send).not.toHaveBeenCalled();
    });

    it('relays a send_command result over 512 KiB unchanged', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { command: 'init' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('relays a create_session result over 512 KiB unchanged', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'create_session',
        connectionId: 'cli-1',
        data: { title: 'Big session' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });
  });

  describe('exit_cli routing and relay policy', () => {
    it.each([
      { label: 'missing sessionId', input: { data: { protocolVersion: 1 } } },
      { label: 'missing data', input: { sessionId: 's1' } },
      {
        label: 'wrong protocol version',
        input: { sessionId: 's1', data: { protocolVersion: 2 } },
      },
      {
        label: 'extra data field',
        input: { sessionId: 's1', data: { protocolVersion: 1, extra: true } },
      },
      { label: 'null data', input: { sessionId: 's1', data: null } },
      {
        label: 'array data',
        input: { sessionId: 's1', data: [{ protocolVersion: 1 }] },
      },
      {
        label: 'primitive data',
        input: { sessionId: 's1', data: 'protocolVersion=1' },
      },
    ])('rejects $label before routing or pending allocation', async ({ input }) => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        ...input,
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'INVALID_COMMAND',
          message: 'Invalid command',
        },
      });
      expect(cliWs.send).not.toHaveBeenCalled();
      expect(Reflect.get(doInstance, 'pendingCommands')).toEqual(new Map());
    });

    it('routes exit_cli to the selected session owner with its data unchanged', async () => {
      const { doInstance, mockCtx } = setup();
      const selectedOwner = addCliSocket(mockCtx, 'cli-1');
      const otherCli = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, selectedOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, otherCli, [makeSession('s2')]);
      selectedOwner.send.mockClear();
      otherCli.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });

      expect(allSent(selectedOwner).filter(message => message.type === 'command')).toEqual([
        expect.objectContaining({
          type: 'command',
          command: 'exit_cli',
          sessionId: 's1',
          data: { protocolVersion: 1 },
        }),
      ]);
      expect(otherCli.send).not.toHaveBeenCalled();
    });

    it('rejects exit_cli when the selected owner snapshot is stale', async () => {
      const { doInstance, mockCtx } = setup();
      const currentOwner = addCliSocket(mockCtx, 'cli-1');
      const staleOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, currentOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, staleOwner, []);
      currentOwner.send.mockClear();
      staleOwner.send.mockClear();
      webWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-2',
        data: { protocolVersion: 1 },
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
      expect(currentOwner.send).not.toHaveBeenCalled();
      expect(staleOwner.send).not.toHaveBeenCalled();
    });

    it('rejects exit_cli when the session has no owner', async () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx, 'web-1');

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        data: { protocolVersion: 1 },
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'Session owner not found',
      });
    });

    it('does not dedupe concurrent exit_cli requests', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      await sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });

      const commands = allSent(cliWs).filter(message => message.type === 'command');
      expect(commands).toHaveLength(2);
      expect(commands[0].id).not.toBe(commands[1].id);
      expect(webWs.send).not.toHaveBeenCalled();
    });

    it('relays an exit_cli result over 512 KiB unchanged', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('resolves exit_cli successfully when heartbeat drops the session', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, []);

      await flushAsync();

      expect(allSent(webWs).find(m => m.type === 'response' && m.id === 'cmd-1')).toEqual({
        type: 'response',
        id: 'cmd-1',
        result: {},
      });
      expect(
        allSent(webWs).some(
          m =>
            m.type === 'response' &&
            m.id === 'cmd-1' &&
            isRecord(m.error) &&
            m.error.code === 'SESSION_OWNER_CHANGED'
        )
      ).toBe(false);

      const responsesBeforeLateAck = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'cmd-1'
      ).length;
      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: {} });
      expect(allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-1')).toHaveLength(
        responsesBeforeLateAck
      );
    });

    it('resolves exit_cli successfully when the owning socket closes', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result: {},
      });
    });

    it.each(['list_models', 'send_message'] as const)(
      'still fails %s with SESSION_OWNER_CHANGED when heartbeat drops the session',
      async command => {
        const { doInstance, mockCtx } = setup();
        const cliWs = addCliSocket(mockCtx, 'cli-1');
        const webWs = addWebSocket(mockCtx, 'web-1');

        sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
        cliWs.send.mockClear();
        webWs.send.mockClear();
        await sendCommand(doInstance, webWs, {
          id: 'cmd-1',
          command,
          sessionId: 's1',
          connectionId: 'cli-1',
        });
        webWs.send.mockClear();

        sendHeartbeat(doInstance, cliWs, []);

        await flushAsync();

        expect(allSent(webWs).find(m => m.type === 'response' && m.id === 'cmd-1')).toEqual({
          type: 'response',
          id: 'cmd-1',
          error: {
            source: 'relay',
            code: 'SESSION_OWNER_CHANGED',
            message: 'Session owner changed',
          },
        });
      }
    );

    it('still fails exit_cli with SESSION_OWNER_CHANGED on genuine takeover', async () => {
      const { doInstance, mockCtx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      firstOwner.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      webWs.send.mockClear();

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);

      await flushAsync();

      expect(allSent(webWs).find(m => m.type === 'response' && m.id === 'cmd-1')).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
    });

    it('still fails exit_cli with SESSION_OWNER_CHANGED when socket is replaced by reconnect', async () => {
      const { doInstance, mockCtx } = setup();
      const firstCli = connectCliSocket(doInstance, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstCli, [makeSession('s1')]);
      firstCli.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      webWs.send.mockClear();

      connectCliSocket(doInstance, 'cli-1');

      await flushAsync();

      expect(firstCli.close).toHaveBeenCalledWith(1000, 'replaced by reconnect');
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
    });
  });

  describe('CLI event forwarding', () => {
    it('forwards events to subscribed web sockets only', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const subWeb = addWebSocket(mockCtx, 'web-sub');
      const otherWeb = addWebSocket(mockCtx, 'web-other');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendSubscribe(doInstance, subWeb, 's1');
      subWeb.send.mockClear();
      otherWeb.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      void doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(subWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(subWeb)).toEqual({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      expect(otherWeb.send).not.toHaveBeenCalled();
    });

    it('sends child events to both direct child subscribers and parent subscribers', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const parentWeb = addWebSocket(mockCtx, 'web-parent');
      const childWeb = addWebSocket(mockCtx, 'web-child');

      sendHeartbeat(doInstance, cliWs, [makeSession('parent-session')]);
      await sendSubscribe(doInstance, parentWeb, 'parent-session');
      await sendSubscribe(doInstance, childWeb, 'child-session-1');
      parentWeb.send.mockClear();
      childWeb.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      void doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(parentWeb.send).toHaveBeenCalledTimes(1);
      expect(childWeb.send).toHaveBeenCalledTimes(1);
      const expected = {
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-1' },
      };
      expect(parseSent(parentWeb)).toEqual(expected);
      expect(parseSent(childWeb)).toEqual(expected);
    });

    it('deduplicates when same socket subscribes to both child and parent', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('parent-session')]);
      await sendSubscribe(doInstance, webWs, 'parent-session');
      await sendSubscribe(doInstance, webWs, 'child-session-1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      void doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
    });

    it('routes child event to parent session subscribers via parentSessionId', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('parent-session')]);
      await sendSubscribe(doInstance, webWs, 'parent-session');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
      void doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
    });

    it('drops child event when neither sessionId nor parentSessionId has subscribers', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('other-session')]);
      await sendSubscribe(doInstance, webWs, 'other-session');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'unknown-parent',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
      void doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).not.toHaveBeenCalled();
    });

    it('events without parentSessionId still route normally (backward compat)', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      void doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
    });

    it('child event does not include parentSessionId when not set', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'session.status',
        data: {},
      });
      void doInstance.webSocketMessage(cliWs as never, eventMsg);

      const sent = parseSent(webWs);
      expect(sent).not.toHaveProperty('parentSessionId');
    });
  });

  describe('broadcast resilience', () => {
    it('one closed socket does not abort send to other web sockets', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const failWeb = addWebSocket(mockCtx, 'web-fail');
      const okWeb = addWebSocket(mockCtx, 'web-ok');

      failWeb.send.mockClear();
      okWeb.send.mockClear();

      failWeb.send.mockImplementation(() => {
        throw new Error('socket closed');
      });

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      expect(okWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(okWeb)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
      });
    });
  });

  describe('ensureState (hibernation recovery)', () => {
    it('reconstructs sessionOwners and connectionSessions from CLI attachments', async () => {
      const { doInstance, mockCtx } = setup();

      const sessions = [makeSession('s1'), makeSession('s2')];
      addCliSocket(mockCtx, 'cli-1', sessions);
      const webWs = addWebSocket(mockCtx, 'web-1');

      await sendSubscribe(doInstance, webWs, 's1');

      const web2 = addWebSocket(mockCtx, 'web-2');
      await sendCommand(doInstance, web2, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });

      const cliWs = mockCtx.sockets.find(s => s._tags.includes('cli'));
      expect(cliWs?.send).toHaveBeenCalled();
      const cliMsgs = allSent(cliWs!);
      const cmdMsg = cliMsgs.find((m: Record<string, unknown>) => m.type === 'command');
      expect(cmdMsg).toMatchObject({
        type: 'command',
        command: 'send_message',
      });
    });

    it('reconstructs webSubscriptions from web attachments', async () => {
      const { doInstance, mockCtx } = setup();

      const cliWs = addCliSocket(mockCtx, 'cli-1', [makeSession('s1')]);
      const webWs = addWebSocket(mockCtx, 'web-1', ['s1']);

      const triggerMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'test',
        data: {},
      });
      void doInstance.webSocketMessage(cliWs as never, triggerMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toMatchObject({
        type: 'event',
        sessionId: 's1',
      });
    });

    it('does not restore subscriptions from a viewer already replaced before hibernation', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [makeSession('s1')]);
      const replacedWeb = addWebSocket(mockCtx, 'web-old', ['s1']);
      replacedWeb.serializeAttachment({
        role: 'web',
        connectionId: 'web-old',
        subscribedSessions: ['s1'],
        replaced: true,
      });

      void doInstance.webSocketMessage(
        cliWs as never,
        JSON.stringify({
          type: 'event',
          sessionId: 's1',
          event: 'test',
          data: {},
        })
      );

      expect(replacedWeb.send).not.toHaveBeenCalled();
    });
  });

  describe('getActiveSessions', () => {
    it('returns sessions from live CLI connections', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('s1', 'busy', 'Fix bug'),
        makeSession('s2', 'idle', 'Review PR'),
      ]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        { id: 's1', status: 'busy', title: 'Fix bug', connectionId: 'cli-1' },
        { id: 's2', status: 'idle', title: 'Review PR', connectionId: 'cli-1' },
      ]);
    });

    it('includes the CLI-reported protocolVersion on each session row', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'busy', 'Fix bug')], {
        protocolVersion: '1',
      });

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        {
          id: 's1',
          status: 'busy',
          title: 'Fix bug',
          connectionId: 'cli-1',
          protocolVersion: '1',
        },
      ]);
    });

    it('excludes sessions from stale connections without live sockets', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      mockCtx.removeSocket(cliWs);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([]);
    });

    it('excludes child sessions reported with parentSessionId in heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('root-1', 'busy', 'Root session'),
        makeSession('child-1', 'busy', 'Child session', 'root-1'),
      ]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        {
          id: 'root-1',
          status: 'busy',
          title: 'Root session',
          connectionId: 'cli-1',
        },
      ]);
    });

    it('hoists a child needs-input status onto the root row', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('root-1', 'busy', 'Root session'),
        makeSession('child-1', 'permission', 'Child session', 'root-1'),
      ]);

      expect(doInstance.getActiveSessions()).toEqual([
        { id: 'root-1', status: 'permission', title: 'Root session', connectionId: 'cli-1' },
      ]);

      sendHeartbeat(doInstance, cliWs, [
        makeSession('root-1', 'busy', 'Root session'),
        makeSession('child-1', 'busy', 'Child session', 'root-1'),
      ]);

      expect(doInstance.getActiveSessions()).toEqual([
        { id: 'root-1', status: 'busy', title: 'Root session', connectionId: 'cli-1' },
      ]);
    });

    it('emits session.status.updated on the root when a child raise appears and clears', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');
      const statusEvents = () =>
        webWs.send.mock.calls
          .map(call => JSON.parse(call[0] as string) as { event?: string; data?: unknown })
          .filter(msg => msg.event === 'session.status.updated')
          .map(
            msg => msg.data as { sessionId: string; status: string; previousStatus: string | null }
          );

      sendHeartbeat(doInstance, cliWs, [
        makeSession('root-1', 'busy', 'Root session'),
        makeSession('child-1', 'permission', 'Child session', 'root-1'),
      ]);
      expect(statusEvents()).toMatchObject([
        { sessionId: 'root-1', status: 'permission', previousStatus: null },
      ]);

      webWs.send.mockClear();
      sendHeartbeat(doInstance, cliWs, [makeSession('root-1', 'busy', 'Root session')]);
      expect(statusEvents()).toMatchObject([
        { sessionId: 'root-1', status: 'busy', previousStatus: 'permission' },
      ]);

      webWs.send.mockClear();
      sendHeartbeat(doInstance, cliWs, [makeSession('root-1', 'busy', 'Root session')]);
      expect(statusEvents()).toEqual([]);
    });

    it('cleans up child tracking when session disappears from heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('root-1', 'busy', 'Root session'),
        makeSession('child-1', 'busy', 'Child session', 'root-1'),
      ]);

      sendHeartbeat(doInstance, cliWs, [makeSession('root-1', 'idle', 'Root session')]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        {
          id: 'root-1',
          status: 'idle',
          title: 'Root session',
          connectionId: 'cli-1',
        },
      ]);
    });

    it('forwards the per-session platform when the CLI reports it (newer CLIs)', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('s1', 'busy', 'On a Mac', undefined, 'darwin'),
        makeSession('s2', 'idle', 'Other'),
      ]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        {
          id: 's1',
          status: 'busy',
          title: 'On a Mac',
          connectionId: 'cli-1',
          platform: 'darwin',
        },
        { id: 's2', status: 'idle', title: 'Other', connectionId: 'cli-1' },
      ]);
    });

    it('omits the platform key entirely for legacy CLIs (byte-identical response)', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'busy', 'Legacy')]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        { id: 's1', status: 'busy', title: 'Legacy', connectionId: 'cli-1' },
      ]);
      expect(result[0]).not.toHaveProperty('platform');
    });

    it('forwards a scheduled status and its wake time (scheduledAt)', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        {
          id: 's1',
          status: 'scheduled',
          title: 'Wake later',
          scheduledAt: '2026-09-24T09:00:00.000Z',
        },
      ]);

      expect(doInstance.getActiveSessions()).toEqual([
        {
          id: 's1',
          status: 'scheduled',
          title: 'Wake later',
          connectionId: 'cli-1',
          scheduledAt: '2026-09-24T09:00:00.000Z',
        },
      ]);
    });

    it('forwards scheduled without a wake time when the CLI omits scheduledAt', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [{ id: 's1', status: 'scheduled', title: 'Wake later' }]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        { id: 's1', status: 'scheduled', title: 'Wake later', connectionId: 'cli-1' },
      ]);
      expect(result[0]).not.toHaveProperty('scheduledAt');
    });

    it('accepts an unrecognized status without dropping the session', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [
        { id: 's1', status: 'brand-new-status', title: 'Future' },
      ]);

      expect(doInstance.getActiveSessions()).toEqual([
        { id: 's1', status: 'brand-new-status', title: 'Future', connectionId: 'cli-1' },
      ]);
    });
  });

  describe('heartbeat attachment compatibility', () => {
    // Measured by the native Workers regression, not inferred from JSON size.
    const capacityMessage =
      "A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was 16472 bytes.";
    const legacyInstance = {
      name: 'current-host',
      projectName: 'current-project',
      version: '1.0.0',
    };
    const heartbeat = {
      type: 'heartbeat',
      protocolVersion: '1',
      capabilities: { attachments: true, sessionClone: true },
      instance: {
        ...legacyInstance,
        kind: 'remote' as const,
        startedAt: '2026-08-28T12:34:56.789Z',
        gitBranch: 'feature/identity',
      },
      sessions: [
        {
          id: 'current-session',
          status: 'busy',
          title: 'Current title',
          gitUrl: 'https://github.com/org/project.git',
          gitBranch: 'session-branch',
          parentSessionId: 'parent-session',
          platform: 'darwin',
          prLink: {
            platform: 'github',
            prUrl: 'https://github.com/org/project/pull/1',
            prNumber: 1,
          },
        },
      ],
    };

    it('retries capacity with every current legacy field, then broadcasts and acknowledges', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(
        mockCtx,
        'cli-1',
        [makeSession('previous-session', 'idle')],
        { name: 'previous-host', projectName: 'previous-project', version: '0.0.0' },
        'usr_1'
      );
      const webWs = addWebSocket(mockCtx);
      doInstance.getActiveSessions();
      const now = Date.now() + 1_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const write = vi.spyOn(cliWs, 'serializeAttachment').mockImplementationOnce(() => {
        throw new Error(capacityMessage);
      });

      await doInstance.webSocketMessage(cliWs as never, JSON.stringify(heartbeat));

      expect(write).toHaveBeenCalledTimes(2);
      expect(cliWs.deserializeAttachment()).toEqual({
        role: 'cli',
        connectionId: 'cli-1',
        sessions: heartbeat.sessions,
        heartbeatAt: now,
        protocolVersion: '1',
        capabilities: heartbeat.capabilities,
        kiloUserId: 'usr_1',
        instance: legacyInstance,
      });
      expect(doInstance.hasActiveCliSession('current-session')).toBe(true);
      expect(doInstance.hasActiveCliSession('previous-session')).toBe(false);
      expect(doInstance.getConnectedInstances()).toEqual({
        instances: [
          { connectionId: 'cli-1', ...legacyInstance, capabilities: heartbeat.capabilities },
        ],
      });
      expect(allSent(webWs)).toEqual([
        {
          type: 'system',
          event: 'sessions.heartbeat',
          data: {
            connectionId: 'cli-1',
            protocolVersion: '1',
            capabilities: heartbeat.capabilities,
            sessions: [{ ...heartbeat.sessions[0], capabilities: heartbeat.capabilities }],
          },
        },
      ]);
      expect(allSent(cliWs)).toEqual([{ type: 'heartbeat_ack' }]);
    });

    it.each([{ kind: 'remote' }, { startedAt: '2026-08-28T12:34:56.789Z' }, { gitBranch: '' }])(
      'permits a capacity retry when only %j is present',
      async metadata => {
        const { doInstance, mockCtx } = setup();
        const cliWs = addCliSocket(mockCtx, 'cli-1');
        doInstance.getActiveSessions();
        vi.spyOn(cliWs, 'serializeAttachment').mockImplementationOnce(() => {
          throw new Error(capacityMessage);
        });
        await doInstance.webSocketMessage(
          cliWs as never,
          JSON.stringify({
            ...heartbeat,
            instance: { ...legacyInstance, ...metadata },
          })
        );
        expect(cliWs.deserializeAttachment()).toHaveProperty('instance', legacyInstance);
        expect(cliWs.deserializeAttachment()).toHaveProperty('sessions', heartbeat.sessions);
        expect(allSent(cliWs)).toEqual([{ type: 'heartbeat_ack' }]);
      }
    );

    it.each([
      {
        label: 'unrelated error',
        error: new Error('unrelated persistence failure'),
        instance: heartbeat.instance,
      },
      {
        label: 'wrong error class',
        error: new TypeError(capacityMessage),
        instance: heartbeat.instance,
      },
      {
        label: 'legacy-only capacity failure',
        error: new Error(capacityMessage),
        instance: legacyInstance,
      },
      {
        label: 'instance-free capacity failure',
        error: new Error(capacityMessage),
        instance: undefined,
      },
      {
        label: 'failed retry',
        error: new Error(capacityMessage),
        instance: heartbeat.instance,
        retryError: new Error('retry failed'),
      },
      {
        label: 'capacity failure on retry',
        error: new Error(capacityMessage),
        instance: heartbeat.instance,
        retryError: new Error(capacityMessage),
      },
    ])(
      'rethrows $label unchanged without broadcasting or acknowledging',
      async ({ error, instance, retryError }) => {
        const { doInstance, mockCtx } = setup();
        const cliWs = addCliSocket(mockCtx, 'cli-1', [], heartbeat.instance);
        const webWs = addWebSocket(mockCtx);
        doInstance.getActiveSessions();
        const before = structuredClone(cliWs.deserializeAttachment());
        const write = vi
          .spyOn(cliWs, 'serializeAttachment')
          .mockImplementation(() => {
            throw retryError ?? error;
          })
          .mockImplementationOnce(() => {
            throw error;
          });

        // sendHeartbeat discards its promise; await the production handler itself.
        await expect(
          doInstance.webSocketMessage(cliWs as never, JSON.stringify({ ...heartbeat, instance }))
        ).rejects.toBe(retryError ?? error);

        expect(write).toHaveBeenCalledTimes(retryError ? 2 : 1);
        expect(cliWs.deserializeAttachment()).toEqual(before);
        expect(allSent(cliWs)).toEqual([]);
        expect(allSent(webWs)).toEqual([]);
      }
    );

    it.each([undefined, legacyInstance])(
      'writes a metadata-free heartbeat once: %j',
      async instance => {
        const { doInstance, mockCtx } = setup();
        const cliWs = addCliSocket(mockCtx, 'cli-1', [], heartbeat.instance);
        doInstance.getActiveSessions();
        const write = vi.spyOn(cliWs, 'serializeAttachment');
        await doInstance.webSocketMessage(
          cliWs as never,
          JSON.stringify({ ...heartbeat, instance })
        );
        expect(write).toHaveBeenCalledTimes(1);
        const attachment = cliWs.deserializeAttachment() as {
          instance?: Instance;
          sessions: unknown;
        };
        expect(attachment.instance).toEqual(instance);
        expect(attachment.sessions).toEqual(heartbeat.sessions);
        expect(allSent(cliWs)).toEqual([{ type: 'heartbeat_ack' }]);
      }
    );
  });

  describe('getConnectedInstances', () => {
    it('returns one row per CLI socket that has an `instance` attachment', async () => {
      const { doInstance, mockCtx } = setup();
      // Use the hibernated-attachment pattern (no heartbeat) — the live
      // scan reads the `instance` directly from the attachment, which is
      // what the spec requires: a fresh value with no in-memory map.
      addCliSocket(mockCtx, 'cli-A', [], {
        name: 'laptop-A',
        projectName: 'kilo',
        version: '0.1.2',
      });
      addCliSocket(mockCtx, 'cli-B', [], {
        name: 'laptop-B',
        projectName: 'kilo',
      });
      addWebSocket(mockCtx);

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toHaveLength(2);
      expect(instances).toEqual(
        expect.arrayContaining([
          {
            connectionId: 'cli-A',
            name: 'laptop-A',
            projectName: 'kilo',
            version: '0.1.2',
          },
          { connectionId: 'cli-B', name: 'laptop-B', projectName: 'kilo' },
        ])
      );
    });

    it('omits the `version` key when the CLI did not report one', async () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1', [], {
        name: 'laptop-1',
        projectName: 'kilo',
      });

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([{ connectionId: 'cli-1', name: 'laptop-1', projectName: 'kilo' }]);
      expect(instances[0]).not.toHaveProperty('version');
    });

    it('excludes legacy CLIs that never reported an `instance`', async () => {
      const { doInstance, mockCtx } = setup();
      // Legacy CLI: pre-spawner heartbeat has no `instance`.
      const cliWs = addCliSocket(mockCtx, 'legacy-1');
      sendHeartbeat(doInstance, cliWs, []);

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([]);
    });

    it('excludes web sockets', async () => {
      const { doInstance, mockCtx } = setup();
      addWebSocket(mockCtx);
      const webWithInstance = createMockWs(['web'], {
        role: 'web',
        connectionId: 'web-1',
        subscribedSessions: [],
      } as never);
      mockCtx.addSocket(webWithInstance);

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([]);
    });

    it('reads `instance` directly from the live socket (no in-memory map)', async () => {
      const { doInstance, mockCtx } = setup();
      // Simulate a hibernated attach: socket exists, attachment has `instance`
      // set, but no heartbeat has been processed through the in-memory state.
      addCliSocket(mockCtx, 'cli-h', [], {
        name: 'laptop-h',
        projectName: 'kilo',
        version: '1.0.0',
      });

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([
        {
          connectionId: 'cli-h',
          name: 'laptop-h',
          projectName: 'kilo',
          version: '1.0.0',
        },
      ]);
    });

    it('projects metadata and both capabilities from a live hibernated attachment', async () => {
      const { doInstance, mockCtx } = setup();
      const instance: Instance = {
        name: 'laptop-cap',
        projectName: 'kilo',
        version: '1.0.0',
        kind: 'cli',
        startedAt: '2026-08-28T12:34:56.789Z',
        gitBranch: '',
      };
      const capabilities = { attachments: true, sessionClone: true };
      const cliWs = createMockWs(['cli'], {
        role: 'cli',
        connectionId: 'cli-cap',
        sessions: [],
        instance,
        capabilities,
      });
      mockCtx.addSocket(cliWs);

      expect(doInstance.getConnectedInstances()).toEqual({
        instances: [{ connectionId: 'cli-cap', ...instance, capabilities }],
      });
      cliWs.readyState = WebSocket.CLOSED;
      expect(doInstance.getConnectedInstances()).toEqual({ instances: [] });
    });

    it('omits capabilities when the CLI attachment has none (legacy CLI)', async () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-legacy-cap', [], {
        name: 'laptop-legacy',
        projectName: 'kilo',
      });

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([
        {
          connectionId: 'cli-legacy-cap',
          name: 'laptop-legacy',
          projectName: 'kilo',
        },
      ]);
      expect(instances[0]).not.toHaveProperty('capabilities');
    });

    it('refreshes instance metadata and preserves it across hibernation', async () => {
      const { doInstance, ctx, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const instance: Instance = {
        name: 'laptop-1',
        projectName: 'kilo',
        version: '0.1.0',
        kind: 'remote',
        startedAt: '2026-08-28T12:34:56.789Z',
        gitBranch: 'first-branch',
      };
      const capabilities = { attachments: true, sessionClone: true };
      sendHeartbeat(doInstance, cliWs, [], { protocolVersion: '1', instance, capabilities });
      const refreshed = { ...instance, gitBranch: 'current-branch' };
      sendHeartbeat(doInstance, cliWs, [], {
        protocolVersion: '1',
        instance: refreshed,
        capabilities,
      });

      expect(cliWs.deserializeAttachment()).toMatchObject({ instance: refreshed, capabilities });
      for (const relay of [doInstance, new UserConnectionDO(ctx as never, {} as never)]) {
        expect(relay.getConnectedInstances()).toEqual({
          instances: [{ connectionId: 'cli-1', ...refreshed, capabilities }],
        });
      }
    });

    it('drops `instance` from the attachment on a subsequent heartbeat that omits it', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [], {
        instance: { name: 'laptop-1', projectName: 'kilo' },
      });
      sendHeartbeat(doInstance, cliWs, []);

      const att = cliWs.deserializeAttachment() as { instance?: unknown };
      expect(att.instance).toBeUndefined();
    });
  });

  describe('same-host connections', () => {
    it('keeps two same-folder clients connected when they advertise the same session', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj', version: '1.2.3' };
      const sessions = [makeSession('shared', 'idle')];

      for (let cycle = 0; cycle < 3; cycle++) {
        sendHeartbeat(doInstance, first, sessions, { instance });
        sendHeartbeat(doInstance, second, sessions, { instance });

        expect(first.close).not.toHaveBeenCalled();
        expect(second.close).not.toHaveBeenCalled();
        expect(doInstance.getConnectedInstances().instances).toEqual([
          { connectionId: 'conn-1', ...instance },
          { connectionId: 'conn-2', ...instance },
        ]);
      }
    });

    it('keeps two idle same-folder clients visible immediately', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj', version: '1.2.3' };

      sendHeartbeat(doInstance, first, [], { instance });
      sendHeartbeat(doInstance, second, [], { instance });

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(doInstance.getConnectedInstances().instances).toEqual([
        { connectionId: 'conn-1', ...instance },
        { connectionId: 'conn-2', ...instance },
      ]);
    });

    it('keeps concurrent same-host connections with distinct sessions open across repeated heartbeats', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj' };

      sendHeartbeat(doInstance, first, [makeSession('s1')], { instance });
      sendHeartbeat(doInstance, second, [makeSession('s2')], { instance });
      sendHeartbeat(doInstance, first, [makeSession('s1')], { instance });
      sendHeartbeat(doInstance, second, [makeSession('s2')], { instance });

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(doInstance.getConnectedInstances().instances).toEqual([
        { connectionId: 'conn-1', ...instance },
        { connectionId: 'conn-2', ...instance },
      ]);
      expect(doInstance.getActiveSessions()).toEqual([
        expect.objectContaining({ id: 's1', connectionId: 'conn-1' }),
        expect.objectContaining({ id: 's2', connectionId: 'conn-2' }),
      ]);
    });

    it('keeps concurrent idle and active connections with the same instance identity open', async () => {
      const { doInstance, mockCtx } = setup();
      const idle = addCliSocket(mockCtx, 'conn-idle');
      const active = addCliSocket(mockCtx, 'conn-active');
      const otherIdle = addCliSocket(mockCtx, 'conn-other-idle');
      const instance = { name: 'host-a', projectName: 'proj' };

      sendHeartbeat(doInstance, idle, [], { instance });
      sendHeartbeat(doInstance, active, [makeSession('s1')], { instance });
      sendHeartbeat(doInstance, otherIdle, [], { instance });
      sendHeartbeat(doInstance, idle, [], { instance });
      sendHeartbeat(doInstance, active, [makeSession('s1')], { instance });
      sendHeartbeat(doInstance, otherIdle, [], { instance });

      expect(idle.close).not.toHaveBeenCalled();
      expect(active.close).not.toHaveBeenCalled();
      expect(otherIdle.close).not.toHaveBeenCalled();
      expect(doInstance.getConnectedInstances().instances).toHaveLength(3);
    });

    it('keeps a same-host connection open when only some sessions transfer', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj' };

      sendHeartbeat(doInstance, first, [makeSession('s1'), makeSession('s2')], { instance });
      sendHeartbeat(doInstance, second, [makeSession('s2')], { instance });

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(doInstance.getActiveSessions()).toEqual([
        expect.objectContaining({ id: 's1', connectionId: 'conn-1' }),
        expect.objectContaining({ id: 's2', connectionId: 'conn-2' }),
      ]);
    });

    it('does not mark a closing connection as replaced when it retains another session', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj' };

      sendHeartbeat(doInstance, first, [makeSession('s1'), makeSession('s2')], { instance });
      first.readyState = WebSocket.CLOSING;
      sendHeartbeat(doInstance, second, [makeSession('s2')], { instance });

      expect(first.close).not.toHaveBeenCalled();
      expect(first.deserializeAttachment()).not.toHaveProperty('replaced');
      expect(doInstance.getActiveSessions()).toEqual([
        expect.objectContaining({ id: 's1', connectionId: 'conn-1' }),
        expect.objectContaining({ id: 's2', connectionId: 'conn-2' }),
      ]);
    });

    it('removes an expired same-host connection while keeping fresh concurrent connections open', async () => {
      const { doInstance, mockCtx } = setup();
      const stale = addCliSocket(mockCtx, 'conn-stale');
      const fresh = addCliSocket(mockCtx, 'conn-fresh');
      const replacement = addCliSocket(mockCtx, 'conn-replacement');
      const instance = { name: 'host-a', projectName: 'proj' };
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

      sendHeartbeat(doInstance, stale, [], { instance });
      clock.mockReturnValue(now + 14_000);
      sendHeartbeat(doInstance, fresh, [makeSession('s2')], { instance });
      clock.mockReturnValue(now + 15_000);
      sendHeartbeat(doInstance, replacement, [], { instance });
      sendHeartbeat(doInstance, fresh, [makeSession('s2')], { instance });

      expect(stale.close).not.toHaveBeenCalled();
      expect(fresh.close).not.toHaveBeenCalled();
      expect(replacement.close).not.toHaveBeenCalled();
      expect(doInstance.getConnectedInstances().instances).toHaveLength(3);

      clock.mockReturnValue(now + 30_000);
      expect(doInstance.getConnectedInstances().instances).toEqual([
        { connectionId: 'conn-fresh', ...instance },
        { connectionId: 'conn-replacement', ...instance },
      ]);
      await doInstance.alarm();

      expect(stale.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
      expect(fresh.close).not.toHaveBeenCalled();
      expect(replacement.close).not.toHaveBeenCalled();
    });

    it('removes a stale idle connection from the instance list when its heartbeat expires', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj' };
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

      sendHeartbeat(doInstance, first, [], { instance });
      sendHeartbeat(doInstance, second, [], { instance });

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(doInstance.getConnectedInstances().instances).toEqual([
        { connectionId: 'conn-1', ...instance },
        { connectionId: 'conn-2', ...instance },
      ]);

      clock.mockReturnValue(now + 29_000);
      sendHeartbeat(doInstance, second, [], { instance });
      clock.mockReturnValue(now + 30_000);
      expect(doInstance.getConnectedInstances().instances).toEqual([
        { connectionId: 'conn-2', ...instance },
      ]);
      await doInstance.alarm();

      expect(first.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
      expect(second.close).not.toHaveBeenCalled();
    });

    it('preserves both same-folder instances across hibernation', async () => {
      const { doInstance, ctx, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj' };

      sendHeartbeat(doInstance, first, [], { instance });
      sendHeartbeat(doInstance, second, [], { instance });

      const restored = new UserConnectionDO(ctx as never, {} as never);
      expect(restored.getConnectedInstances().instances).toEqual([
        { connectionId: 'conn-1', ...instance },
        { connectionId: 'conn-2', ...instance },
      ]);
      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
    });

    it('expires a stale connection after hibernation without resetting its heartbeat age', async () => {
      const { doInstance, ctx, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');
      const instance = { name: 'host-a', projectName: 'proj' };
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

      sendHeartbeat(doInstance, first, [], { instance });
      sendHeartbeat(doInstance, second, [], { instance });
      clock.mockReturnValue(now + 29_000);
      sendHeartbeat(doInstance, second, [], { instance });
      clock.mockReturnValue(now + 30_000);

      const restored = new UserConnectionDO(ctx as never, {} as never);
      await restored.alarm();

      expect(first.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
      expect(second.close).not.toHaveBeenCalled();
    });

    it('preserves the first observed heartbeat time for legacy sockets across repeated hibernation', async () => {
      const { doInstance, ctx, mockCtx } = setup();
      const stale = addCliSocket(mockCtx, 'conn-stale');
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);

      doInstance.getActiveSessions();
      clock.mockReturnValue(now + 29_000);
      const firstRestore = new UserConnectionDO(ctx as never, {} as never);
      firstRestore.getActiveSessions();
      clock.mockReturnValue(now + 30_000);
      const secondRestore = new UserConnectionDO(ctx as never, {} as never);
      await secondRestore.alarm();

      expect(stale.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
    });

    it('preserves the initial connection time when a CLI never sends a heartbeat', async () => {
      const { doInstance, ctx } = setup();
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const silent = connectCliSocket(doInstance, 'conn-silent');

      clock.mockReturnValue(now + 30_000);
      const restored = new UserConnectionDO(ctx as never, {} as never);
      await restored.alarm();

      expect(silent.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
    });

    it('keeps both sockets open when the projectName differs', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');

      sendHeartbeat(doInstance, first, [], {
        instance: { name: 'host-a', projectName: 'proj-1' },
      });
      sendHeartbeat(doInstance, second, [], {
        instance: { name: 'host-a', projectName: 'proj-2' },
      });

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
    });

    it('keeps both sockets open when the name differs', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const second = addCliSocket(mockCtx, 'conn-2');

      sendHeartbeat(doInstance, first, [], {
        instance: { name: 'host-a', projectName: 'proj' },
      });
      sendHeartbeat(doInstance, second, [], {
        instance: { name: 'host-b', projectName: 'proj' },
      });

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
    });

    it('preserves both clients when shared-session ownership changes during a pending command', async () => {
      const { doInstance, mockCtx } = setup();
      const first = addCliSocket(mockCtx, 'conn-1');
      const webWs = addWebSocket(mockCtx, 'web-1');
      const instance = { name: 'host-a', projectName: 'proj' };

      sendHeartbeat(doInstance, first, [makeSession('s1')], { instance });
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
        connectionId: 'conn-1',
      });
      const correlationId = getCorrelationId(first);
      webWs.send.mockClear();
      const second = addCliSocket(mockCtx, 'conn-2');
      sendHeartbeat(doInstance, second, [makeSession('s1')], { instance });
      await flushAsync();

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).not.toHaveBeenCalled();
      expect(allSent(webWs).find(message => message.id === 'cmd-1')).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });

      const durable = mockCtx.storage.store.get(`pendingCommand/${correlationId}`) as {
        state: string;
        error?: unknown;
      };
      expect(durable.state).toBe('done');
      expect(durable.error).toEqual({
        source: 'relay',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      });
    });
  });

  describe('WS attachment size', () => {
    // These are JSON fixture guards, not proof of native attachment capacity.
    // The Workers regression calibrates the actual production heartbeat write.
    const LEGACY_JSON_BUDGET = 2048;
    // 184 bounded UTF-16 units can each need six JSON bytes, plus 30 bytes for
    // kind/timestamp and 81 bytes of framing: at most 1215, below 1280.
    const INSTANCE_HEADROOM = 1280;

    it('keeps maximally escaped instance metadata within its JSON bound', () => {
      const instance: Instance = {
        name: '\u0000'.repeat(64),
        projectName: '\u0000'.repeat(64),
        version: '\u0000'.repeat(32),
        kind: 'remote',
        startedAt: '2026-08-28T12:34:56.789Z',
        gitBranch: '\u0000'.repeat(24),
      };
      expect(new TextEncoder().encode(JSON.stringify(instance)).byteLength).toBeLessThan(
        INSTANCE_HEADROOM
      );
    });

    it('keeps the full representative legacy attachment below 2 KiB of JSON', async () => {
      const legacyInstance = {
        name: 'x'.repeat(64),
        projectName: 'x'.repeat(64),
        version: 'x'.repeat(32),
      };
      // Preserve four representative sessions, not a production capacity limit.
      const sessions = Array.from({ length: 4 }, (_, i) => ({
        id: `ses_${String(i).padStart(26, '0')}`,
        status: 'busy',
        title: 'T'.repeat(120),
        gitUrl: 'https://github.com/org/' + 'x'.repeat(60) + '.git',
        gitBranch: 'b'.repeat(40),
      }));

      const attachment = {
        role: 'cli' as const,
        connectionId: 'cli-1',
        sessions,
        heartbeatAt: 1_788_000_000_000,
        protocolVersion: '255.255.65535',
        capabilities: { attachments: true, sessionClone: true },
        kiloUserId: 'usr_' + 'x'.repeat(28),
        instance: legacyInstance,
      };

      const serialized = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;
      expect(serialized).toBeLessThan(LEGACY_JSON_BUDGET);
    });
  });

  describe('owner-unique active sessions', () => {
    it('emits owner-unique rows: ownership transfer with both CLIs live yields exactly one row under the new owner', async () => {
      const { doInstance, ctx, mockCtx } = setup();
      const oldOwner = addCliSocket(mockCtx, 'cli-old');
      const newOwner = addCliSocket(mockCtx, 'cli-new');

      sendHeartbeat(doInstance, oldOwner, [makeSession('ses_transfer', 'busy', 'Transfer me')]);

      // cli-new also claims the same session id while cli-old is still connected.
      // The DO routes the session to the new owner (sessionOwners.get === 'cli-new').
      sendHeartbeat(doInstance, newOwner, [makeSession('ses_transfer', 'busy', 'Transfer me')]);

      expect(ctx.getWebSockets('cli').map(ws => ws.deserializeAttachment())).toEqual([
        expect.objectContaining({ role: 'cli', connectionId: 'cli-old' }),
        expect.objectContaining({ role: 'cli', connectionId: 'cli-new' }),
      ]);

      const result = doInstance.getActiveSessions();

      expect(result).toEqual([
        {
          id: 'ses_transfer',
          status: 'busy',
          title: 'Transfer me',
          connectionId: 'cli-new',
        },
      ]);
    });
  });

  describe('edge cases', () => {
    it('ignores non-JSON messages', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      void doInstance.webSocketMessage(cliWs as never, 'not-json');
    });

    it('logs invalid CLI JSON metadata without raw payload content', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const malformed = '{"secret":"raw-secret-must-not-be-logged"';

      void doInstance.webSocketMessage(cliWs as never, malformed);

      expect(warn).toHaveBeenCalledWith('Failed to parse WebSocket message as JSON', {
        role: 'cli',
        connectionId: 'cli-1',
        byteCount: new TextEncoder().encode(malformed).byteLength,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('raw-secret-must-not-be-logged');
    });

    it('ignores messages from socket with no attachment', async () => {
      const { doInstance, mockCtx } = setup();
      const ws = createMockWs(['cli'], null);
      mockCtx.addSocket(ws);

      void doInstance.webSocketMessage(
        ws as never,
        JSON.stringify({ type: 'heartbeat', sessions: [] })
      );
    });

    it('ignores messages that fail Zod validation', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, []); // trigger ensureState

      const badMsg = JSON.stringify({ type: 'invalid_type' });
      void doInstance.webSocketMessage(cliWs as never, badMsg);

      const webWs = addWebSocket(mockCtx, 'web-1');
      void doInstance.webSocketMessage(webWs as never, badMsg);
    });

    it('logs malformed CLI message metadata without raw payload content', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const secret = 'raw-secret-must-not-be-logged';
      const malformed = JSON.stringify({
        type: 'response',
        id: 123,
        result: { secret },
      });

      void doInstance.webSocketMessage(cliWs as never, malformed);

      expect(warn).toHaveBeenCalledWith('CLI message parse failed', {
        role: 'cli',
        connectionId: 'cli-1',
        byteCount: new TextEncoder().encode(malformed).byteLength,
        issues: [{ path: ['id'], code: 'invalid_type' }],
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    });

    it('webSocketError triggers webSocketClose', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await doInstance.webSocketError(cliWs as never);

      const msgs = allSent(webWs);
      expect(msgs.some((m: Record<string, unknown>) => m.event === 'cli.disconnected')).toBe(true);
    });

    it('CLI response for unknown correlation ID is a no-op', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, []);

      await sendCliResponse(doInstance, cliWs, { id: 'nonexistent', result: 'ok' });
    });
  });

  describe('session-ready delayed push', () => {
    function setupWithIngestDO() {
      const mockCtx = createMockCtx();
      const ctx = mockCtx.build();
      const claimSessionReadyPush = vi.fn(async () => {});
      sessionIngestMocks.getSessionIngestDO.mockReturnValue({
        claimSessionReadyPush,
        resetAttentionStatusOnCliDisconnect: sessionIngestMocks.resetAttentionStatusOnCliDisconnect,
      });
      const doInstance = new UserConnectionDO(ctx as never, {} as never);
      return { doInstance, mockCtx, ctx, claimSessionReadyPush };
    }

    function addCliSocketForUser(
      mockCtx: ReturnType<typeof createMockCtx>,
      connectionId: string,
      kiloUserId: string
    ): MockWS {
      const attachment = {
        role: 'cli' as const,
        connectionId,
        sessions: [],
        kiloUserId,
      };
      const ws = createMockWs(['cli'], attachment);
      mockCtx.addSocket(ws);
      return ws;
    }

    it('writes a pending readyPush entry on first sight and does not claim immediately', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_main')]);
      await flushAsync();

      expect(claimSessionReadyPush).not.toHaveBeenCalled();
      const entry = ctx.storage.store.get('readyPush:ses_main') as {
        kiloUserId: string;
        title: string;
        fireAt: number;
        attempts: number;
      };
      expect(entry).toMatchObject({
        kiloUserId: 'usr_1',
        title: 'Test',
        fireAt: now + 5_000,
        attempts: 0,
      });

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_main')]);
      await flushAsync();
      expect(ctx.storage.put).toHaveBeenCalledTimes(1);
    });

    it('reconnect first-sight does not reset a pending readyPush fireAt or attempts', async () => {
      const { doInstance, mockCtx, ctx } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_reconnect')]);
      await flushAsync();

      const originalFireAt = now + 5_000;
      await ctx.storage.put('readyPush:ses_reconnect', {
        kiloUserId: 'usr_1',
        title: 'Test',
        fireAt: originalFireAt,
        attempts: 2,
      });
      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };
      internal.readyPushFireAt.set('ses_reconnect', originalFireAt);

      // Disconnect clears sessionOwners; reconnect is a new "first sight".
      await disconnectCli(doInstance, cliWs);
      expect(internal.readyPushFireAt.get('ses_reconnect')).toBe(originalFireAt);

      const later = now + 2_000;
      vi.spyOn(Date, 'now').mockReturnValue(later);
      ctx.storage.put.mockClear();

      const cliWs2 = addCliSocketForUser(mockCtx, 'cli-2', 'usr_1');
      sendHeartbeat(doInstance, cliWs2, [makeSession('ses_reconnect')]);
      await flushAsync();

      const entry = ctx.storage.store.get('readyPush:ses_reconnect') as {
        fireAt: number;
        attempts: number;
      };
      expect(entry.fireAt).toBe(originalFireAt);
      expect(entry.attempts).toBe(2);
      expect(ctx.storage.put).not.toHaveBeenCalled();
    });

    it('never schedules for subagent sessions', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('ses_main'),
        makeSession('ses_sub', 'busy', 'Sub', 'ses_main'),
      ]);
      await flushAsync();

      expect(ctx.storage.store.has('readyPush:ses_main')).toBe(true);
      expect(ctx.storage.store.has('readyPush:ses_sub')).toBe(false);
      expect(claimSessionReadyPush).not.toHaveBeenCalled();
    });

    it('does not schedule on sockets without a kiloUserId (legacy attachment)', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_main')]);
      await flushAsync();

      expect(ctx.storage.store.size).toBe(0);
      expect(claimSessionReadyPush).not.toHaveBeenCalled();
    });

    it('arms the alarm for a readyPush even with no heartbeat candidates', async () => {
      const { doInstance, mockCtx, ctx } = setupWithIngestDO();
      const fireAt = Date.now() + 5_000;
      await ctx.storage.put('readyPush:ses_orphan', {
        kiloUserId: 'usr_1',
        title: 'Orphan',
        fireAt,
        attempts: 0,
      });

      ctx.storage.setAlarm.mockClear();
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_arm')]);
      await flushAsync();
      await disconnectCli(doInstance, cliWs);
      ctx.storage.setAlarm.mockClear();

      await doInstance.alarm();
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
      const armedAt = ctx.storage.setAlarm.mock.calls.at(-1)?.[0] as number;
      expect(armedAt).toBe(now + 5_000);
    });

    it('arms immediately for overdue readyPush entries (never filtered by fireAt > now)', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await ctx.storage.put('readyPush:ses_overdue', {
        kiloUserId: 'usr_1',
        title: 'Old',
        fireAt: now - 1_000,
        attempts: 0,
      });
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_overdue', 'idle', 'Old')]);
      await flushAsync();
      await ctx.storage.put('readyPush:ses_overdue', {
        kiloUserId: 'usr_1',
        title: 'Old',
        fireAt: now - 1_000,
        attempts: 0,
      });
      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };
      internal.readyPushFireAt.set('ses_overdue', now - 1_000);

      ctx.storage.setAlarm.mockClear();
      claimSessionReadyPush.mockClear();
      await doInstance.alarm();

      expect(claimSessionReadyPush).toHaveBeenCalled();
      // After fire, entry deleted; remaining schedule may or may not arm
    });

    it('one-shot mirror rebuild sets flag only after successful refresh', async () => {
      const { doInstance, mockCtx, ctx } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      await ctx.storage.put('readyPush:ses_rebuild', {
        kiloUserId: 'usr_1',
        title: 'Rebuild',
        fireAt: now + 2_000,
        attempts: 0,
      });

      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
        readyPushRebuilt: boolean;
        scheduleNextAlarm: (now: number) => void;
      };
      expect(internal.readyPushFireAt.size).toBe(0);
      expect(internal.readyPushRebuilt).toBe(false);

      const cliWs = addCliSocket(mockCtx, 'cli-legacy');
      sendHeartbeat(doInstance, cliWs, []);
      await flushAsync();

      expect(internal.readyPushRebuilt).toBe(true);
      expect(internal.readyPushFireAt.get('ses_rebuild')).toBe(now + 2_000);
      expect(ctx.storage.setAlarm).toHaveBeenCalled();

      internal.readyPushFireAt.clear();
      internal.readyPushRebuilt = false;
      ctx.storage.list.mockRejectedValueOnce(new Error('kv down'));
      sendHeartbeat(doInstance, cliWs, []);
      await flushAsync();
      expect(internal.readyPushRebuilt).toBe(false);
    });

    it('alarm passes changed heartbeat title when connectionSessions diverged, else undefined', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };

      sendHeartbeat(doInstance, cliWs, [
        makeSession('ses_t', 'idle', 'Stored'),
        makeSession('ses_same', 'idle', 'Same'),
      ]);
      await flushAsync();

      sendHeartbeat(doInstance, cliWs, [
        makeSession('ses_t', 'idle', 'Generated'),
        makeSession('ses_same', 'idle', 'Same'),
      ]);
      await ctx.storage.put('readyPush:ses_t', {
        kiloUserId: 'usr_1',
        title: 'Stored',
        fireAt: now - 1,
        attempts: 0,
      });
      await ctx.storage.put('readyPush:ses_same', {
        kiloUserId: 'usr_1',
        title: 'Same',
        fireAt: now - 1,
        attempts: 0,
      });
      internal.readyPushFireAt.set('ses_t', now - 1);
      internal.readyPushFireAt.set('ses_same', now - 1);

      claimSessionReadyPush.mockClear();
      await doInstance.alarm();
      expect(claimSessionReadyPush).toHaveBeenCalledWith('usr_1', 'ses_t', 'Generated');
      expect(claimSessionReadyPush).toHaveBeenCalledWith('usr_1', 'ses_same', undefined);
    });

    it('claim-then-delete: RPC rejection keeps the entry; drops after 3 attempts', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_retry')]);
      await flushAsync();

      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };
      internal.readyPushFireAt.set('ses_retry', now - 1);
      await ctx.storage.put('readyPush:ses_retry', {
        kiloUserId: 'usr_1',
        title: 'Test',
        fireAt: now - 1,
        attempts: 0,
      });

      claimSessionReadyPush.mockRejectedValueOnce(new Error('DO down'));
      await doInstance.alarm();
      const after1 = ctx.storage.store.get('readyPush:ses_retry') as {
        attempts: number;
        fireAt: number;
      };
      expect(after1.attempts).toBe(1);
      // Retry must back off so attempts span real time (not fireAt already ≤ now).
      expect(after1.fireAt).toBe(now + 5_000);
      expect(internal.readyPushFireAt.get('ses_retry')).toBe(now + 5_000);

      vi.spyOn(Date, 'now').mockReturnValue(now + 5_000);
      claimSessionReadyPush.mockRejectedValueOnce(new Error('DO down'));
      await doInstance.alarm();
      const after2 = ctx.storage.store.get('readyPush:ses_retry') as {
        attempts: number;
        fireAt: number;
      };
      expect(after2.attempts).toBe(2);
      expect(after2.fireAt).toBe(now + 10_000);

      vi.spyOn(Date, 'now').mockReturnValue(now + 10_000);
      claimSessionReadyPush.mockRejectedValueOnce(new Error('DO down'));
      await doInstance.alarm();
      expect(ctx.storage.store.has('readyPush:ses_retry')).toBe(false);
      expect(internal.readyPushFireAt.has('ses_retry')).toBe(false);
    });

    it('claim rejection re-arms at now+backoff, not now', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_backoff')]);
      await flushAsync();

      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };
      internal.readyPushFireAt.set('ses_backoff', now - 1);
      await ctx.storage.put('readyPush:ses_backoff', {
        kiloUserId: 'usr_1',
        title: 'Test',
        fireAt: now - 1,
        attempts: 0,
      });

      claimSessionReadyPush.mockRejectedValueOnce(new Error('transport blip'));
      await doInstance.alarm();

      const entry = ctx.storage.store.get('readyPush:ses_backoff') as {
        attempts: number;
        fireAt: number;
      };
      expect(entry.attempts).toBe(1);
      expect(entry.fireAt).toBe(now + 5_000);
      expect(internal.readyPushFireAt.get('ses_backoff')).toBe(now + 5_000);

      // Same instant must not exhaust further attempts.
      claimSessionReadyPush.mockClear();
      claimSessionReadyPush.mockRejectedValue(new Error('still down'));
      await doInstance.alarm();
      expect(claimSessionReadyPush).not.toHaveBeenCalled();
      expect(
        (ctx.storage.store.get('readyPush:ses_backoff') as { attempts: number }).attempts
      ).toBe(1);
    });

    it('does not refire after a successful claim', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_ok')]);
      await flushAsync();

      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };
      internal.readyPushFireAt.set('ses_ok', now - 1);
      await ctx.storage.put('readyPush:ses_ok', {
        kiloUserId: 'usr_1',
        title: 'Test',
        fireAt: now - 1,
        attempts: 0,
      });

      await doInstance.alarm();
      expect(claimSessionReadyPush).toHaveBeenCalledTimes(1);
      expect(ctx.storage.store.has('readyPush:ses_ok')).toBe(false);

      claimSessionReadyPush.mockClear();
      await doInstance.alarm();
      expect(claimSessionReadyPush).not.toHaveBeenCalled();
    });

    it('KV is source of truth for alarm even without the mirror', async () => {
      const { doInstance, mockCtx, ctx, claimSessionReadyPush } = setupWithIngestDO();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      await ctx.storage.put('readyPush:ses_kv_only', {
        kiloUserId: 'usr_1',
        title: 'KV',
        fireAt: now - 1,
        attempts: 0,
      });
      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };
      internal.readyPushFireAt.clear();

      await doInstance.alarm();
      expect(claimSessionReadyPush).toHaveBeenCalledWith('usr_1', 'ses_kv_only', undefined);
      expect(ctx.storage.store.has('readyPush:ses_kv_only')).toBe(false);
    });

    it('stores the kiloUserId from the connection URL on the attachment', async () => {
      const { doInstance } = setupWithIngestDO();
      const client = createMockWs();
      const server = createMockWs();
      vi.stubGlobal(
        'WebSocketPair',
        class {
          0 = client;
          1 = server;
        }
      );
      vi.stubGlobal(
        'Response',
        class {
          constructor(_body?: BodyInit | null, _init?: ResponseInit) {}
        }
      );

      doInstance.fetch(
        new Request('http://local/cli?connectionId=cli-1&kiloUserId=usr_1', {
          headers: { Upgrade: 'websocket' },
        })
      );

      expect(server.deserializeAttachment()).toMatchObject({
        role: 'cli',
        kiloUserId: 'usr_1',
      });
    });
  });

  describe('notifySessionRenamed', () => {
    it('delivers session.renamed to the owning CLI and always persists KV', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [makeSession('ses_r')]);
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_r')]);

      const result = await doInstance.notifySessionRenamed('ses_r', 'Renamed Title');
      expect(result).toEqual({ delivered: true });
      expect(ctx.storage.store.get('rename:ses_r')).toMatchObject({
        title: 'Renamed Title',
      });

      const systemMsgs = allSent(cliWs).filter(
        m => m.type === 'system' && m.event === 'session.renamed'
      );
      expect(systemMsgs).toHaveLength(1);
      expect(systemMsgs[0].data).toEqual({
        sessionId: 'ses_r',
        title: 'Renamed Title',
      });
    });

    it('returns delivered:false when no owner but still persists KV', async () => {
      const { doInstance, ctx } = setup();
      const result = await doInstance.notifySessionRenamed('ses_missing', 'Offline Rename');
      expect(result).toEqual({ delivered: false });
      expect(ctx.storage.store.get('rename:ses_missing')).toMatchObject({
        title: 'Offline Rename',
      });
    });

    it('re-emits session.renamed on heartbeat title mismatch; deletes on match', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_catch', 'idle', 'Old Title')]);

      await doInstance.notifySessionRenamed('ses_catch', 'New Title');
      cliWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_catch', 'idle', 'Old Title')]);
      await flushAsync();
      const reEmits = allSent(cliWs).filter(
        m => m.type === 'system' && m.event === 'session.renamed'
      );
      expect(reEmits).toHaveLength(1);
      expect(reEmits[0].data).toEqual({
        sessionId: 'ses_catch',
        title: 'New Title',
      });
      expect(ctx.storage.store.has('rename:ses_catch')).toBe(true);

      cliWs.send.mockClear();
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_catch', 'idle', 'New Title')]);
      await flushAsync();
      const afterMatch = allSent(cliWs).filter(
        m => m.type === 'system' && m.event === 'session.renamed'
      );
      expect(afterMatch).toHaveLength(0);
      expect(ctx.storage.store.has('rename:ses_catch')).toBe(false);
    });

    it('registers rename catch-up with waitUntil on heartbeat', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_wu')]);
      await doInstance.notifySessionRenamed('ses_wu', 'Catch Up Title');

      const waitUntil = ctx.waitUntil as ReturnType<typeof vi.fn>;
      waitUntil.mockClear();
      cliWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_wu', 'idle', 'Stale')]);
      expect(waitUntil).toHaveBeenCalled();
      const registered = waitUntil.mock.calls.map(c => c[0]);
      expect(
        registered.some(
          p => p instanceof Promise || typeof (p as PromiseLike<unknown>)?.then === 'function'
        )
      ).toBe(true);

      await flushAsync();
      const reEmits = allSent(cliWs).filter(
        m => m.type === 'system' && m.event === 'session.renamed'
      );
      expect(reEmits).toHaveLength(1);
      expect(reEmits[0].data).toEqual({
        sessionId: 'ses_wu',
        title: 'Catch Up Title',
      });
    });

    it('prunes rename entries older than TTL and does not re-emit them', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const now = 1_700_000_000_000;
      const RENAME_ENTRY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_stale', 'idle', 'Old')]);

      await ctx.storage.put('rename:ses_stale', {
        title: 'Never Applied',
        at: now - RENAME_ENTRY_TTL_MS - 1,
      });

      cliWs.send.mockClear();
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_stale', 'idle', 'Old')]);
      await flushAsync();

      const reEmits = allSent(cliWs).filter(
        m => m.type === 'system' && m.event === 'session.renamed'
      );
      expect(reEmits).toHaveLength(0);
      expect(ctx.storage.store.has('rename:ses_stale')).toBe(false);
    });

    it('still re-emits a fresh rename entry within TTL', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_fresh', 'idle', 'Old')]);

      await ctx.storage.put('rename:ses_fresh', {
        title: 'Within TTL',
        at: now - 60_000,
      });

      cliWs.send.mockClear();
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_fresh', 'idle', 'Old')]);
      await flushAsync();

      const reEmits = allSent(cliWs).filter(
        m => m.type === 'system' && m.event === 'session.renamed'
      );
      expect(reEmits).toHaveLength(1);
      expect(reEmits[0].data).toEqual({
        sessionId: 'ses_fresh',
        title: 'Within TTL',
      });
      expect(ctx.storage.store.has('rename:ses_fresh')).toBe(true);
    });
  });

  // Force-hibernate mechanism: these tests simulate hibernation by
  // pre-populating the storage fake (ctx.storage.put) with durable entries,
  // then re-instantiating the DO and calling ensureState().  Cloudflare
  // Durable Object hibernation is not directly triggerable from the Vitest
  // harness; the test covers the reconstruction path instead.

  describe('durable pending commands', () => {
    it('rehydrates a CLI reply on wake and routes it to the live web socket (D8 case 1)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-1';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-a',
        originalId: 'original-req-1',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-1',
        expiresAt: now + 35_000,
        webConnectionId: 'web-1',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-a', 'busy', 'Session A')]);

      const webWs = addWebSocket(mockCtx, 'web-1');

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });

      const responses = allSent(webWs).filter(m => m.type === 'response');
      expect(responses).toHaveLength(1);
      expect(responses[0].id).toBe('original-req-1');
      expect(responses[0].result).toEqual({ ok: true });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toEqual({ ok: true });
    });

    it('keeps the durable entry and skips send when the originating web socket is gone (D8 case 2)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-2';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-b',
        originalId: 'original-req-2',
        command: 'send_message',
        targetConnectionId: 'cli-2',
        expiresAt: now + 35_000,
        webConnectionId: 'web-gone',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-2');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-b', 'busy', 'Session B')]);

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).state).toBe('done');
    });

    it('deduplicates a pending mutationId and returns an idempotent response for a non-catalog command', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const mutationId = 'mut-dedup-pending';
      await ctx.storage.put(`pendingCommand/${mutationId}`, {
        sessionId: 'ses-c',
        originalId: 'first-req',
        command: 'send_message',
        targetConnectionId: 'cli-3',
        expiresAt: now + 35_000,
        webConnectionId: 'web-3',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-3');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-c', 'busy', 'Session C')]);
      const webWs = addWebSocket(mockCtx, 'web-3');

      cliWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'second-req',
        command: 'send_message',
        sessionId: 'ses-c',
        connectionId: 'cli-3',
        data: { ok: true },
        mutationId,
      });
      await flushAsync();

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'second-req');
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toBeDefined();
      expect((responses[0].error as Record<string, unknown>).code).toBe('COMMAND_ALREADY_PENDING');

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(0);
    });

    it('returns the stored result for a done mutationId under the new request id (D8 response identity)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const mutationId = 'mut-done-1';
      await ctx.storage.put(`pendingCommand/${mutationId}`, {
        sessionId: 'ses-d',
        originalId: 'first-req-done',
        command: 'send_message',
        targetConnectionId: 'cli-4',
        expiresAt: now + 35_000,
        webConnectionId: 'web-4',
        state: 'done' as const,
        result: { stored: true },
      });

      const cliWs = addCliSocket(mockCtx, 'cli-4');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-d', 'busy', 'Session D')]);
      const webWs = addWebSocket(mockCtx, 'web-4');
      cliWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'retry-req-id',
        command: 'send_message',
        sessionId: 'ses-d',
        connectionId: 'cli-4',
        mutationId,
      });
      await flushAsync();

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'retry-req-id'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].result).toEqual({ stored: true });

      const entry = await ctx.storage.get(`pendingCommand/${mutationId}`);
      expect((entry as Record<string, unknown>).originalId).toBe('retry-req-id');

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(0);
    });

    it('returns both stored result and error for a done mutationId with combined outcome', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const mutationId = 'mut-done-combined';
      await ctx.storage.put(`pendingCommand/${mutationId}`, {
        sessionId: 'ses-dc',
        originalId: 'first-req-combined',
        command: 'send_message',
        targetConnectionId: 'cli-dc',
        expiresAt: now + 35_000,
        webConnectionId: 'web-dc',
        state: 'done' as const,
        result: { partial: 'data' },
        error: 'partial error',
      });

      const cliWs = addCliSocket(mockCtx, 'cli-dc');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-dc', 'busy', 'Session DC')]);
      const webWs = addWebSocket(mockCtx, 'web-dc');
      cliWs.send.mockClear();

      await sendCommand(doInstance, webWs, {
        id: 'retry-combined-id',
        command: 'send_message',
        sessionId: 'ses-dc',
        connectionId: 'cli-dc',
        mutationId,
      });
      await flushAsync();

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'retry-combined-id'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].result).toEqual({ partial: 'data' });
      expect(responses[0].error).toBe('partial error');

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(0);
    });

    it('behaves identically without a mutationId (per-send random correlation id)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const cliWs = addCliSocket(mockCtx, 'cli-5');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-e', 'busy', 'Session E')]);
      const webWs = addWebSocket(mockCtx, 'web-5');

      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'no-mut-req',
        command: 'send_message',
        sessionId: 'ses-e',
      });
      await flushAsync();

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(1);
      expect(cliCommands[0].id).toBeTruthy();
      expect(cliCommands[0].mutationId).toBeUndefined();

      const correlationId = cliCommands[0].id as string;
      await flushAsync();
      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { normal: true },
      });

      const responses = allSent(webWs).filter(m => m.type === 'response');
      expect(responses.some(r => r.id === 'no-mut-req' && r.result)).toBe(true);
    });

    it('does not delete the durable entry on web disconnect (step 26b)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const cliWs = addCliSocket(mockCtx, 'cli-6');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-f', 'busy', 'Session F')]);
      const webWs = addWebSocket(mockCtx, 'web-6');

      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'disconnect-req',
        command: 'send_message',
        sessionId: 'ses-f',
        connectionId: 'cli-6',
      });
      await flushAsync();

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(1);
      const correlationId = cliCommands[0].id as string;

      await flushAsync();
      let entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();

      await doInstance.webSocketClose(webWs as never, 1000, '', true);
      await flushAsync();

      entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
    });

    it('expires a durable pending entry and marks it done with COMMAND_EXPIRED_ERROR', async () => {
      const { mockCtx, ctx } = setup();

      const pastTime = Date.now() - 10_000;
      const correlationId = 'mut-expired';

      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-g',
        originalId: 'expired-req',
        command: 'send_message',
        targetConnectionId: 'cli-7',
        expiresAt: pastTime,
        webConnectionId: 'web-7',
        state: 'pending' as const,
      });

      const doInstance2 = new UserConnectionDO(ctx as never, {} as never);

      const cliWs = addCliSocket(mockCtx, 'cli-7');
      sendHeartbeat(doInstance2, cliWs, [makeSession('ses-g', 'busy', 'Session G')]);

      await doInstance2.alarm();
      await flushAsync();

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'COMMAND_EXPIRED',
        message: 'Command expired',
      });
    });

    it('counts durable entries toward the pending command cap (mutationId path)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const cliWs = addCliSocket(mockCtx, 'cli-8');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-h', 'busy', 'Session H')]);
      const webWs = addWebSocket(mockCtx, 'web-8');

      const now = Date.now();
      for (let i = 0; i < 127; i++) {
        await ctx.storage.put(`pendingCommand/prefill-${i}`, {
          sessionId: 'ses-h',
          originalId: `prefill-${i}`,
          command: 'send_message',
          targetConnectionId: 'cli-8',
          expiresAt: now + 35_000,
          webConnectionId: 'web-8',
          state: 'pending' as const,
        });
      }

      await sendCommand(doInstance, webWs, {
        id: 'at-cap',
        command: 'send_message',
        sessionId: 'ses-h',
        connectionId: 'cli-8',
      });
      await flushAsync();
      const commandsAtCap = allSent(cliWs).filter(m => m.type === 'command');
      expect(commandsAtCap.length).toBeGreaterThanOrEqual(1);

      // The second command uses a fresh mutationId. The mutationId path
      // counts durable entries: 127 prefill + 1 from the first
      // command's durable write + 1 in-memory = 129 ≥ 128. Rejected.
      cliWs.send.mockClear();
      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'over-cap',
        command: 'send_message',
        sessionId: 'ses-h',
        connectionId: 'cli-8',
        mutationId: 'fresh-cap-check',
      });
      await flushAsync();

      const rejection = allSent(webWs).filter(m => m.type === 'response' && m.id === 'over-cap');
      expect(rejection).toHaveLength(1);
      expect((rejection[0].error as Record<string, unknown>)?.code).toBe('PENDING_COMMAND_LIMIT');

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(0);
    });

    it('persists the exact CLI string error in the durable entry, not CLI_COMMAND_ERROR', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'err-1',
        command: 'list_models',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_models',
      });

      const live = parseSent(webWs) as { error: unknown };
      expect(live.error).toBe('unknown command: list_models');

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toBe('unknown command: list_models');
    });

    it('persists the exact structured CLI_UPGRADE_REQUIRED error in the durable entry', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'err-2',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_commands',
      });

      const live = parseSent(webWs) as { error: unknown };
      expect(live.error).toEqual({
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
      });
    });

    it('completes the durable write for a CLI response via ctx.waitUntil', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'dur-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { durable: true },
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toEqual({
        durable: true,
      });
    });

    it('sends the oversized-catalog error to a live web socket after rehydration', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'cat-rehydrated';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-cat',
        originalId: 'original-cat',
        command: 'list_models',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-cat',
        expiresAt: now + 35_000,
        webConnectionId: 'web-cat',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-cat');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-cat', 'busy', 'Session Cat')]);
      const webWs = addWebSocket(mockCtx, 'web-cat');
      webWs.send.mockClear();

      const oversized = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: oversized,
      });

      const responses = allSent(webWs).filter(m => m.type === 'response');
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toEqual({
        source: 'relay',
        code: 'CATALOG_TOO_LARGE',
        message: 'Model catalog response is too large',
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'CATALOG_TOO_LARGE',
        message: 'Model catalog response is too large',
      });
    });

    it('sends a bare string "CLI disconnected" to the live web socket on disconnect', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-disco',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      const msgs = allSent(webWs);
      const errorResp = msgs.find(m => m.type === 'response' && m.id === 'cmd-disco');
      expect(errorResp).toBeDefined();
      expect(errorResp!.error).toBe('CLI disconnected');
    });

    it('stores the live CLI-disconnected error in the durable entry for retries', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-dur-disco',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);
      await flushAsync();

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toBe('CLI disconnected');
    });

    it('shapes the error for a no-web D8 case 2 retry (CLI_UPGRADE_REQUIRED mapping)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-no-web-shaped';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-nw',
        originalId: 'original-nw',
        command: 'list_commands',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-nw',
        expiresAt: now + 35_000,
        webConnectionId: 'web-gone-shaped',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-nw');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-nw', 'busy', 'Session NW')]);

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_commands',
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
      });
    });

    it('shapes a non-allowlist CLI string error correctly for a no-web D8 case 2 retry', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-no-web-string';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-nws',
        originalId: 'original-nws',
        command: 'list_models',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-nws',
        expiresAt: now + 35_000,
        webConnectionId: 'web-gone-string',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-nws');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-nws', 'busy', 'Session NWS')]);

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_models',
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toBe('unknown command: list_models');
    });

    it('does not persist raw oversized catalog data for a no-web D8 case 2 retry', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-no-web-oversized';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-nwo',
        originalId: 'original-nwo',
        command: 'list_models',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-nwo',
        expiresAt: now + 35_000,
        webConnectionId: 'web-gone-oversized',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-nwo');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-nwo', 'busy', 'Session NWO')]);

      const oversized = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: oversized,
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'CATALOG_TOO_LARGE',
        message: 'Model catalog response is too large',
      });
      expect((entry as Record<string, unknown>).result).toBeUndefined();
    });

    it('shapes a relay-object CLI error to CLI_COMMAND_ERROR for a no-web D8 case 2 retry', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-no-web-relay';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-nwr',
        originalId: 'original-nwr',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-nwr',
        expiresAt: now + 35_000,
        webConnectionId: 'web-gone-relay',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-nwr');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-nwr', 'busy', 'Session NWR')]);

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'cli',
        message: 'Command failed',
      });
    });

    it('persists both result and error for a no-web D8 case 2 combined response', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-no-web-combined';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-nwc',
        originalId: 'original-nwc',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-nwc',
        expiresAt: now + 35_000,
        webConnectionId: 'web-gone-combined',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-nwc');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-nwc', 'busy', 'Session NWC')]);

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { partial: 'data' },
        error: 'something went wrong',
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toEqual({ partial: 'data' });
      expect((entry as Record<string, unknown>).error).toBe('something went wrong');
    });

    it('persists the terminal catalog-too-large outcome without a second durable read', async () => {
      // Regression test: the rehydrated catalog-too-large branch must not
      // do a second getDurablePendingCommand. It must use the value
      // captured at the top of handleCliResponse instead.
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'cat-no-second-read';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-cat2',
        originalId: 'original-cat2',
        command: 'list_models',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-cat2',
        expiresAt: now + 35_000,
        webConnectionId: 'web-cat2',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-cat2');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-cat2', 'busy', 'Session Cat2')]);
      const webWs = addWebSocket(mockCtx, 'web-cat2');
      webWs.send.mockClear();

      const oversized = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: oversized,
      });

      const responses = allSent(webWs).filter(m => m.type === 'response');
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toEqual({
        source: 'relay',
        code: 'CATALOG_TOO_LARGE',
        message: 'Model catalog response is too large',
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'CATALOG_TOO_LARGE',
        message: 'Model catalog response is too large',
      });

      expect((entry as Record<string, unknown>).result).toBeUndefined();
    });

    it('bounds non-catalog results over the durable limit before the durable write', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'big-result',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const oversized = createResultWithSerializedBytes(MAX_DURABLE_RESULT_BYTES + 1);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: oversized });

      const live = parseSent(webWs) as { id: string; result: unknown };
      expect(live.result).toEqual(oversized);

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toBeUndefined();
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'DURABLE_RESULT_TOO_LARGE',
        message: 'Result is too large to store for retries',
      });
    });

    it('stores non-catalog results at exactly the durable limit unchanged', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'exact-result',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const exact = createResultWithSerializedBytes(MAX_DURABLE_RESULT_BYTES);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: exact });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).result).toEqual(exact);
    });

    it('bounds the result in the D8 case 2 (no-web) durable write', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-no-web-big';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-big',
        originalId: 'original-big',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-big',
        expiresAt: now + 35_000,
        webConnectionId: 'web-gone-big',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-big');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-big', 'busy', 'Session Big')]);

      const oversized = createResultWithSerializedBytes(MAX_DURABLE_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: oversized });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toBeUndefined();
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'DURABLE_RESULT_TOO_LARGE',
        message: 'Result is too large to store for retries',
      });
    });

    it('delivers a CLI response exactly once when the same response arrives twice', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'dedup-cmd',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: { ok: true } });

      const firstResponses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'dedup-cmd'
      );
      expect(firstResponses).toHaveLength(1);
      expect(firstResponses[0].result).toEqual({ ok: true });

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: { ok: true } });

      const allResponses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'dedup-cmd'
      );
      expect(allResponses).toHaveLength(1);
    });

    it('ignores a live CLI response that has already expired', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      const baseTime = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(baseTime);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'expiry-cmd',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      vi.spyOn(Date, 'now').mockReturnValue(baseTime + 35_001);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: { late: true } });

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'expiry-cmd');
      expect(responses).toHaveLength(0);
    });

    it('rejects a mutationId longer than 128 characters via schema validation', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      const longMutationId = 'x'.repeat(129);
      await sendCommand(doInstance, webWs, {
        id: 'oversized-mut',
        command: 'send_message',
        sessionId: 's1',
        mutationId: longMutationId,
      });

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'oversized-mut'
      );
      expect(responses).toHaveLength(0);

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(0);
    });

    it('accepts a mutationId at exactly 128 characters', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      const exactMutationId = 'x'.repeat(128);
      await sendCommand(doInstance, webWs, {
        id: 'exact-mut',
        command: 'send_message',
        sessionId: 's1',
        mutationId: exactMutationId,
      });
      await flushAsync();

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(1);
      expect(cliCommands[0].mutationId).toBe(exactMutationId);
    });

    it('rejects a mutationId longer than 128 characters in the web message schema', async () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      const longMutationId = 'x'.repeat(129);
      const msg = JSON.stringify({
        type: 'command',
        id: 'schema-mut',
        command: 'send_message',
        mutationId: longMutationId,
      });

      void doInstance.webSocketMessage(webWs as never, msg);

      const cliCommands = allSent(mockCtx.sockets.find(s => s._tags.includes('cli'))!).filter(
        m => m.type === 'command'
      );
      expect(cliCommands).toHaveLength(0);
    });

    it('rejects a rehydrated CLI reply when the durable entry has expired', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const pastTime = Date.now() - 10_000;
      const correlationId = 'rehydrated-expired';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-re',
        originalId: 'original-re',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-re',
        expiresAt: pastTime,
        webConnectionId: 'web-re',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-re');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-re', 'busy', 'Session RE')]);
      const webWs = addWebSocket(mockCtx, 'web-re');
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { late: true },
      });

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'original-re');
      expect(responses).toHaveLength(0);

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'COMMAND_EXPIRED',
        message: 'Command expired',
      });
      expect((entry as Record<string, unknown>).result).toBeUndefined();
    });

    it('keeps the total serialized durable entry under 128 KiB when the result is at the bound', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'safety-check',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const result = createResultWithSerializedBytes(MAX_DURABLE_RESULT_BYTES);
      await sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toEqual(result);

      const serialized = new TextEncoder().encode(JSON.stringify(entry)).byteLength;
      expect(serialized).toBeLessThan(131_072);
    });
    it('delivers at most one terminal result when two rehydrated replies race', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'rehydrated-race';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-race',
        originalId: 'original-race',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-race',
        expiresAt: now + 35_000,
        webConnectionId: 'web-race',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-race');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-race', 'busy', 'Session Race')]);
      const webWs = addWebSocket(mockCtx, 'web-race');
      webWs.send.mockClear();

      // Deferred promise: holds the first reply's terminal storage.put so
      // the second reply enters the handler while the first is blocked on
      // the durable write. This ractests the marker+write window, not the
      // read.
      let release: () => void;
      const deferred = new Promise<void>(resolve => {
        release = resolve;
      });
      let deferredFired = false;
      ctx.storage.put.mockImplementation(async (key, value) => {
        // Defer only the first terminal 'done' write for the rehydrated
        // correlation id.
        if (
          !deferredFired &&
          key === `pendingCommand/${correlationId}` &&
          (value as Record<string, unknown>)?.state === 'done'
        ) {
          deferredFired = true;
          await deferred;
        }
        ctx.storage.store.set(key as string, value);
      });

      // Start the first CLI reply — the handler rehydrates the durable
      // entry, builds the in-memory entry, then blocks on the deferred
      // storage.put before sending the live response.
      void doInstance.webSocketMessage(
        cliWs as never,
        JSON.stringify({ type: 'response', id: correlationId, result: { first: true } })
      );
      await flushAsync();

      // Start the second CLI reply while the first is held on storage.put.
      // The completedCorrelationIds reservation is still set, so the
      // second reply returns early without delivering.
      void doInstance.webSocketMessage(
        cliWs as never,
        JSON.stringify({ type: 'response', id: correlationId, result: { second: true } })
      );
      await flushAsync();

      release!();
      await flushAsync();

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'original-race'
      );
      expect(responses).toHaveLength(1);
    });

    it('sends no live response and clears the marker when the terminal durable write fails', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-fail-write',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      // Make the terminal durable write fail. The mock harness fires
      // storage.put multiple times: (1) dispatchWebCommandSync creates a
      // pending entry in waitUntil, (2) the done write inside
      // handleCliResponse. Clear history and make the next call reject to
      // target the terminal write.
      ctx.storage.put.mockClear();
      ctx.storage.put.mockRejectedValueOnce(new Error('durable write failed'));

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'cmd-fail-write'
      );
      expect(responses).toHaveLength(0);

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(false);
    });

    it('sends no live response and clears the marker when the catalog durable write fails', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-catalog',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      ctx.storage.put.mockClear();
      ctx.storage.put.mockRejectedValueOnce(new Error('catalog write failed'));

      const oversized = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: oversized,
      });

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-catalog');
      expect(responses).toHaveLength(0);

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(false);
    });

    it('re-sends after a failed durable write (the CLI re-send succeeds because nothing was sent first time)', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'retry-after-fail',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      ctx.storage.put.mockClear();
      ctx.storage.put.mockRejectedValueOnce(new Error('durable write failed'));

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { first: true },
      });

      const responses1 = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'retry-after-fail'
      );
      expect(responses1).toHaveLength(0);

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(false);

      webWs.send.mockClear();
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { second: true },
      });

      const responses2 = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'retry-after-fail'
      );
      expect(responses2).toHaveLength(1);
      expect(responses2[0].result).toEqual({ second: true });
    });

    it('clears the completedCorrelationIds marker after a successful durable write and live send', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'cmd-clear',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-clear');
      expect(responses).toHaveLength(1);
      expect(responses[0].result).toEqual({ ok: true });

      // Marker must be cleared — the durable 'done' state is the dedupe guard now.
      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(false);

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
    });

    it('persists the durable entry before sending the live response', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'order-cmd',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const callOrder: string[] = [];
      ctx.storage.put.mockImplementation(async (key: string, value: unknown): Promise<void> => {
        callOrder.push('put');
        ctx.storage.store.set(key, value);
      });
      webWs.send.mockImplementation((..._args: unknown[]) => {
        callOrder.push('send');
      });

      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });

      const putIdx = callOrder.indexOf('put');
      const sendIdx = callOrder.indexOf('send');
      expect(putIdx).toBeGreaterThanOrEqual(0);
      expect(sendIdx).toBeGreaterThanOrEqual(0);
      expect(putIdx).toBeLessThan(sendIdx);
    });

    it('retries an in-memory disconnect terminal write before one live response', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'disconnect-write-fail',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();
      ctx.storage.put.mockRejectedValueOnce(new Error('durable write failed'));

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      await flushAsync();

      const responses = allSent(webWs).filter(
        message => message.type === 'response' && message.id === 'disconnect-write-fail'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toBe('CLI disconnected');
      expect(markers.size).toBe(0);
      const entry = await ctx.storage.get(`pendingCommand/${getCorrelationId(cliWs)}`);
      expect(entry).toMatchObject({ state: 'done', error: 'CLI disconnected' });
    });

    it('retries an in-memory owner-change terminal write before one live response', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      await sendCommand(doInstance, webWs, {
        id: 'owner-write-fail',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();
      ctx.storage.put.mockRejectedValueOnce(new Error('durable write failed'));

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      await flushAsync();

      const responses = allSent(webWs).filter(
        message => message.type === 'response' && message.id === 'owner-write-fail'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toEqual({
        source: 'relay',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      });
      expect(markers.size).toBe(0);
      const entry = await ctx.storage.get(`pendingCommand/${getCorrelationId(firstOwner)}`);
      expect(entry).toMatchObject({
        state: 'done',
        error: {
          source: 'relay',
          code: 'SESSION_OWNER_CHANGED',
          message: 'Session owner changed',
        },
      });
    });

    it('fences a disconnect terminal outcome while its durable write is pending', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'disconnect-fence',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      let resolvePut: (() => void) | undefined;
      ctx.storage.put.mockImplementationOnce(
        (key, value) =>
          new Promise<void>(resolve => {
            resolvePut = () => {
              ctx.storage.store.set(key, value);
              resolve();
            };
          })
      );

      mockCtx.removeSocket(cliWs);
      const closing = disconnectCli(doInstance, cliWs);
      await Promise.resolve();

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(true);

      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: { wrong: true } });
      expect(
        allSent(webWs).filter(
          message => message.type === 'response' && message.id === 'disconnect-fence'
        )
      ).toHaveLength(0);

      resolvePut?.();
      await closing;

      const responses = allSent(webWs).filter(
        message => message.type === 'response' && message.id === 'disconnect-fence'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toBe('CLI disconnected');
      expect(markers.has(correlationId)).toBe(false);
    });

    it('fences an owner-change terminal outcome while its durable write is pending', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      await sendCommand(doInstance, webWs, {
        id: 'owner-fence',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(firstOwner);
      webWs.send.mockClear();

      let resolvePut: (() => void) | undefined;
      ctx.storage.put.mockImplementationOnce(
        (key, value) =>
          new Promise<void>(resolve => {
            resolvePut = () => {
              ctx.storage.store.set(key, value);
              resolve();
            };
          })
      );

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);
      await Promise.resolve();

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(true);

      await sendCliResponse(doInstance, firstOwner, { id: correlationId, result: { wrong: true } });
      expect(
        allSent(webWs).filter(
          message => message.type === 'response' && message.id === 'owner-fence'
        )
      ).toHaveLength(0);

      resolvePut?.();
      await flushAsync();

      const responses = allSent(webWs).filter(
        message => message.type === 'response' && message.id === 'owner-fence'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toEqual({
        source: 'relay',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      });
      expect(markers.has(correlationId)).toBe(false);
    });

    it('continues disconnect cleanup after one terminal write retries', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'first-disconnect',
        command: 'send_message',
        sessionId: 's1',
      });
      await sendCommand(doInstance, webWs, {
        id: 'second-disconnect',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();
      ctx.storage.put.mockRejectedValueOnce(new Error('durable write failed'));

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);
      await flushAsync();

      for (const id of ['first-disconnect', 'second-disconnect']) {
        const responses = allSent(webWs).filter(
          message => message.type === 'response' && message.id === id
        );
        expect(responses).toHaveLength(1);
        expect(responses[0].error).toBe('CLI disconnected');
      }
      expect(
        allSent(webWs).some(
          message => message.type === 'system' && message.event === 'cli.disconnected'
        )
      ).toBe(true);
    });

    it('fences every matching disconnect command before the first terminal write settles', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'fence-first',
        command: 'send_message',
        sessionId: 's1',
      });
      await sendCommand(doInstance, webWs, {
        id: 'fence-second',
        command: 'send_message',
        sessionId: 's1',
      });
      const [firstCorrelationId, secondCorrelationId] = [
        getCorrelationId(cliWs, 0),
        getCorrelationId(cliWs, 1),
      ];
      webWs.send.mockClear();

      let resolvePut: (() => void) | undefined;
      ctx.storage.put.mockImplementationOnce(
        (key, value) =>
          new Promise<void>(resolve => {
            resolvePut = () => {
              ctx.storage.store.set(key, value);
              resolve();
            };
          })
      );

      mockCtx.removeSocket(cliWs);
      const closing = disconnectCli(doInstance, cliWs);
      await Promise.resolve();

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(firstCorrelationId)).toBe(true);
      expect(markers.has(secondCorrelationId)).toBe(true);

      await sendCliResponse(doInstance, cliWs, {
        id: secondCorrelationId,
        result: { wrong: true },
      });
      expect(
        allSent(webWs).filter(
          message => message.type === 'response' && message.id === 'fence-second'
        )
      ).toHaveLength(0);

      resolvePut?.();
      await closing;
      await flushAsync();

      for (const id of ['fence-first', 'fence-second']) {
        const responses = allSent(webWs).filter(
          message => message.type === 'response' && message.id === id
        );
        expect(responses).toHaveLength(1);
        expect(responses[0].error).toBe('CLI disconnected');
      }
      for (const correlationId of [firstCorrelationId, secondCorrelationId]) {
        await expect(ctx.storage.get(`pendingCommand/${correlationId}`)).resolves.toMatchObject({
          state: 'done',
          error: 'CLI disconnected',
        });
      }
    });

    it('keeps a disconnect terminal outcome after the initial pending write settles', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      let resolveInitialPut: (() => void) | undefined;
      ctx.storage.put.mockImplementationOnce(
        (key, value) =>
          new Promise<void>(resolve => {
            resolveInitialPut = () => {
              ctx.storage.store.set(key, value);
              resolve();
            };
          })
      );

      await doInstance.webSocketMessage(
        webWs as never,
        JSON.stringify({
          type: 'command',
          id: 'initial-write-disconnect',
          command: 'send_message',
          sessionId: 's1',
        })
      );
      const correlationId = [
        ...(Reflect.get(doInstance, 'pendingInitialCommandWrites') as Set<string>),
      ][0];
      expect(correlationId).toBeDefined();
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      const closing = disconnectCli(doInstance, cliWs);
      await Promise.resolve();
      resolveInitialPut?.();
      await Promise.resolve();
      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId!)).toBe(true);
      void doInstance.webSocketMessage(
        cliWs as never,
        JSON.stringify({ type: 'response', id: correlationId, result: { wrong: true } })
      );
      await closing;
      await flushAsync();

      await expect(ctx.storage.get(`pendingCommand/${correlationId!}`)).resolves.toMatchObject({
        state: 'done',
        error: 'CLI disconnected',
      });
      expect(
        allSent(webWs).filter(
          message => message.type === 'response' && message.id === 'initial-write-disconnect'
        )
      ).toEqual([{ type: 'response', id: 'initial-write-disconnect', error: 'CLI disconnected' }]);

      await sendCliResponse(doInstance, cliWs, { id: correlationId!, result: { wrong: true } });
      expect(
        allSent(webWs).filter(
          message => message.type === 'response' && message.id === 'initial-write-disconnect'
        )
      ).toHaveLength(1);
    });

    it('keeps an owner-change terminal outcome after the initial pending write settles', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      let resolveInitialPut: (() => void) | undefined;
      ctx.storage.put.mockImplementationOnce(
        (key, value) =>
          new Promise<void>(resolve => {
            resolveInitialPut = () => {
              ctx.storage.store.set(key, value);
              resolve();
            };
          })
      );

      await doInstance.webSocketMessage(
        webWs as never,
        JSON.stringify({
          type: 'command',
          id: 'initial-write-owner-change',
          command: 'send_message',
          sessionId: 's1',
        })
      );
      const correlationId = [
        ...(Reflect.get(doInstance, 'pendingInitialCommandWrites') as Set<string>),
      ][0];
      expect(correlationId).toBeDefined();
      webWs.send.mockClear();

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);
      await Promise.resolve();
      resolveInitialPut?.();
      await Promise.resolve();
      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId!)).toBe(true);
      void doInstance.webSocketMessage(
        firstOwner as never,
        JSON.stringify({ type: 'response', id: correlationId, result: { wrong: true } })
      );
      await flushAsync();

      const error = {
        source: 'relay',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      };
      await expect(ctx.storage.get(`pendingCommand/${correlationId!}`)).resolves.toMatchObject({
        state: 'done',
        error,
      });
      expect(
        allSent(webWs).filter(
          message => message.type === 'response' && message.id === 'initial-write-owner-change'
        )
      ).toEqual([{ type: 'response', id: 'initial-write-owner-change', error }]);

      await sendCliResponse(doInstance, firstOwner, {
        id: correlationId!,
        result: { wrong: true },
      });
      expect(
        allSent(webWs).filter(
          message => message.type === 'response' && message.id === 'initial-write-owner-change'
        )
      ).toHaveLength(1);
    });

    it('catches a handleCliResponse storage-read failure at the waitUntil boundary', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'rehydrated-read-fail';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-rrf',
        originalId: 'original-rrf',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-rrf',
        expiresAt: now + 35_000,
        webConnectionId: 'web-rrf',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-rrf');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-rrf', 'busy', 'Session RRF')]);
      addWebSocket(mockCtx, 'web-rrf');

      ctx.storage.get.mockRejectedValueOnce(new Error('storage read failure'));

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      // The CLI response enters the rehydration path, getDurablePendingCommand
      // reads durable state and rejects. The waitUntil catch logs the error.
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });

      // The error must have been caught and logged, not a rejected waitUntil.
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to handle CLI response (non-fatal)',
        expect.objectContaining({
          correlationId,
          error: 'storage read failure',
        })
      );

      // The completedCorrelationIds marker must be clean (reservation was
      // set before the read and cleared on failure — the .catch at
      // waitUntil is the outer guard, but the internal marker reservation
      // must still clean up).
      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(false);
    });

    it('clears the rehydration reservation on a post-acquisition throw so a later retry is not blocked', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'mut-throw-retry';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-throw',
        originalId: 'original-throw',
        command: 'send_message',
        expectedOwnerConnectionId: undefined,
        targetConnectionId: 'cli-throw',
        expiresAt: now + 35_000,
        webConnectionId: 'web-throw',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-throw');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-throw', 'busy', 'Session Throw')]);
      const webWs = addWebSocket(mockCtx, 'web-throw');

      // Force boundDurableResult to throw on the first call so the outer
      // finally path exercises the reservation cleanup.
      const doAny = doInstance as unknown as { boundDurableResult: (r: unknown) => unknown };
      const originalBound = doAny.boundDurableResult;
      doAny.boundDurableResult = vi.fn().mockImplementationOnce(() => {
        throw new Error('forced boundDurableResult throw');
      });

      // First CLI response: enters the rehydration path, builds the in-memory
      // entry, then throws inside boundDurableResult. The outer finally must
      // clear the completedCorrelationIds reservation.
      webWs.send.mockClear();
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });

      const markers = Reflect.get(doInstance, 'completedCorrelationIds') as Set<string>;
      expect(markers.has(correlationId)).toBe(false);

      doAny.boundDurableResult = originalBound;

      // Second CLI response with the same correlationId: the rehydration path
      // must not be blocked by a stale marker. The entry is still 'pending'
      // so it must be processed normally.
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { second: true },
      });

      const responses = allSent(webWs).filter(m => m.type === 'response');
      expect(responses).toHaveLength(1);
      expect(responses[0].id).toBe('original-throw');
      expect(responses[0].result).toEqual({ second: true });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toEqual({ second: true });
    });

    it('delivers COMMAND_EXPIRED_ERROR to a live web socket when a durable entry expires', async () => {
      const { mockCtx, ctx } = setup();

      const pastTime = Date.now() - 10_000;
      const correlationId = 'expired-delivery';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-exp',
        originalId: 'expired-original',
        command: 'send_message',
        targetConnectionId: 'cli-exp',
        expiresAt: pastTime,
        webConnectionId: 'web-exp',
        state: 'pending' as const,
      });

      const doInstance2 = new UserConnectionDO(ctx as never, {} as never);

      const cliWs = addCliSocket(mockCtx, 'cli-exp');
      sendHeartbeat(doInstance2, cliWs, [makeSession('ses-exp', 'busy', 'Session Exp')]);
      // Web socket connects after the entry was created (simulates reattach).
      const webWs = addWebSocket(mockCtx, 'web-exp');

      await doInstance2.alarm();
      await flushAsync();

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'expired-original'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toEqual({
        source: 'relay',
        code: 'COMMAND_EXPIRED',
        message: 'Command expired',
      });

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
    });

    it('delivers CLI-disconnect error to a reattached web socket via finishDurablePendingCommands', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'disco-delivery';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-disco',
        originalId: 'disco-original',
        command: 'send_message',
        targetConnectionId: 'cli-disco',
        expiresAt: now + 35_000,
        webConnectionId: 'web-disco',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-disco');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-disco', 'busy', 'Session Disco')]);

      // Web socket connects after the entry was created (simulates reattach).
      const webWs = addWebSocket(mockCtx, 'web-disco');

      // Disconnect the CLI — finishDurablePendingCommands handles the
      // durable-only entries that were never in-memory.
      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);
      await flushAsync();

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'disco-original'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toBe('CLI disconnected');

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toBe('CLI disconnected');
    });

    it('does not deliver terminal response when no live web socket matches webConnectionId', async () => {
      const { mockCtx, ctx } = setup();

      const pastTime = Date.now() - 10_000;
      const correlationId = 'no-web-delivery';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-nwd',
        originalId: 'no-web-original',
        command: 'send_message',
        targetConnectionId: 'cli-nwd',
        expiresAt: pastTime,
        webConnectionId: 'web-missing',
        state: 'pending' as const,
      });

      const doInstance2 = new UserConnectionDO(ctx as never, {} as never);

      const cliWs = addCliSocket(mockCtx, 'cli-nwd');
      sendHeartbeat(doInstance2, cliWs, [makeSession('ses-nwd', 'busy', 'Session NWD')]);

      // Alarm must not throw — storage-only behavior when no socket matches.
      await doInstance2.alarm();
      await flushAsync();

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
    });

    it('returns DURABLE_RESULT_TOO_LARGE on a mutationId retry of an oversized result', async () => {
      const { doInstance, mockCtx } = setup();

      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'oversized-mut',
        command: 'send_message',
        sessionId: 's1',
        mutationId: 'mut-oversized',
        data: { hello: 'world' },
      });
      await flushAsync();

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(1);
      const correlationId = cliCommands[0].id as string;
      webWs.send.mockClear();

      const oversized = createResultWithSerializedBytes(MAX_DURABLE_RESULT_BYTES + 1);
      await sendCliResponse(doInstance, cliWs, { id: correlationId, result: oversized });

      const live = parseSent(webWs) as { id: string; result: unknown };
      expect(live.id).toBe('oversized-mut');
      expect(live.result).toEqual(oversized);

      webWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'retry-mut',
        command: 'send_message',
        sessionId: 's1',
        mutationId: 'mut-oversized',
      });
      await flushAsync();

      const retry = parseSent(webWs) as { id: string; error?: unknown; result?: unknown };
      expect(retry.id).toBe('retry-mut');
      expect(retry.result).toBeUndefined();
      expect(retry.error).toEqual({
        source: 'relay',
        code: 'DURABLE_RESULT_TOO_LARGE',
        message: 'Result is too large to store for retries',
      });
    });

    it('persists durably before forwarding a default (non-mutationId) command to the CLI', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      const callOrder: string[] = [];
      const originalPut = ctx.storage.put;
      ctx.storage.put = vi.fn(async (...args: unknown[]) => {
        callOrder.push('put');
        return (originalPut as any)(...args);
      });
      const originalSend = cliWs.send;
      cliWs.send = vi.fn((...args: unknown[]) => {
        callOrder.push('send');
        return (originalSend as any).apply(cliWs, args);
      });

      await sendCommand(doInstance, webWs, {
        id: 'order-cmd',
        command: 'send_message',
        sessionId: 's1',
      });

      await flushAsync();

      expect(ctx.storage.put).toHaveBeenCalled();

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(1);
      expect(cliCommands[0]).toMatchObject({
        type: 'command',
        command: 'send_message',
        sessionId: 's1',
      });

      const putIdx = callOrder.indexOf('put');
      const sendIdx = callOrder.indexOf('send');
      expect(putIdx).toBeGreaterThanOrEqual(0);
      expect(sendIdx).toBeGreaterThanOrEqual(0);
      expect(putIdx).toBeLessThan(sendIdx);
    });

    it('delivers exactly one CLI-disconnect error when entry exists in both memory and durable storage', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      await sendCommand(doInstance, webWs, {
        id: 'race-disco',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);
      await flushAsync();

      const errors = allSent(webWs).filter(m => m.type === 'response' && m.id === 'race-disco');
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toBe('CLI disconnected');
    });

    it('delivers exactly one SESSION_OWNER_CHANGED error when entry exists in both memory and durable storage', async () => {
      const { doInstance, mockCtx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      firstOwner.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'race-owner',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      webWs.send.mockClear();

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);
      await flushAsync();

      const errors = allSent(webWs).filter(m => m.type === 'response' && m.id === 'race-owner');
      expect(errors).toHaveLength(1);
      expect(errors[0].error).toEqual({
        source: 'relay',
        code: 'SESSION_OWNER_CHANGED',
        message: 'Session owner changed',
      });
    });

    it('persists the durable entry before delivering to a reattached web socket in finishDurablePendingCommands', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      const now = Date.now();
      const correlationId = 'disco-reorder';
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-reorder',
        originalId: 'reorder-original',
        command: 'send_message',
        targetConnectionId: 'cli-reorder',
        expiresAt: now + 35_000,
        webConnectionId: 'web-reorder',
        state: 'pending' as const,
      });

      const cliWs = addCliSocket(mockCtx, 'cli-reorder');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-reorder', 'busy', 'Session Reorder')]);
      const webWs = addWebSocket(mockCtx, 'web-reorder');

      const callOrder: string[] = [];
      const originalPut = ctx.storage.put;
      ctx.storage.put = vi.fn(async (...args: unknown[]) => {
        callOrder.push('put');
        return (originalPut as any)(...args);
      });
      const originalSend = webWs.send;
      webWs.send = vi.fn((...args: unknown[]) => {
        callOrder.push('send');
        return (originalSend as any).apply(webWs, args);
      });

      // Disconnect the CLI — finishDurablePendingCommands handles the
      // durable-only entry.
      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);
      await flushAsync();

      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'reorder-original'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toBe('CLI disconnected');

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');

      const putIdx = callOrder.indexOf('put');
      const sendIdx = callOrder.indexOf('send');
      expect(putIdx).toBeGreaterThanOrEqual(0);
      expect(sendIdx).toBeGreaterThanOrEqual(0);
      expect(putIdx).toBeLessThan(sendIdx);
    });
  });

  describe('concurrent durable sweep fence', () => {
    it('expirePendingCommands sync sweep adds to completedCorrelationIds', async () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      vi.mocked(Date.now).mockReturnValue(now + 35_001);
      (doInstance as unknown as { expirePendingCommands(n: number): void }).expirePendingCommands(
        now + 35_001
      );

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: { source: 'relay', code: 'COMMAND_EXPIRED', message: 'Command expired' },
      });

      // The correlationId must be in completedCorrelationIds so a concurrent
      // finishDurablePendingCommands does not double-deliver.
      const completed = (doInstance as unknown as { completedCorrelationIds: Set<string> })
        .completedCorrelationIds;
      expect(completed.has(correlationId)).toBe(true);
    });

    it('expirePendingCommands async sweep adds to completedCorrelationIds before delivery', async () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      vi.mocked(Date.now).mockReturnValue(now + 35_001);
      (doInstance as unknown as { expirePendingCommands(n: number): void }).expirePendingCommands(
        now + 35_001
      );

      await flushAsync();

      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>)?.state).toBe('done');
    });

    it('finishDurablePendingCommands skips entries already in completedCorrelationIds', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      // Manually add to completedCorrelationIds (simulating an
      // expirePendingCommands sync sweep that ran first).
      (
        doInstance as unknown as { completedCorrelationIds: Set<string> }
      ).completedCorrelationIds.add(correlationId);

      await (
        doInstance as unknown as {
          finishDurablePendingCommands(
            matches: (e: unknown) => boolean,
            error: unknown,
            skipIds?: ReadonlySet<string>
          ): Promise<void>;
        }
      ).finishDurablePendingCommands(
        (e: unknown) => (e as Record<string, unknown>).state === 'pending',
        'CLI disconnected',
        new Set()
      );

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-1');
      expect(responses).toHaveLength(0);
    });

    it('expirePendingCommands sync sweep skips entry already reserved in completedCorrelationIds', async () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      // Manually add to completedCorrelationIds (simulating a concurrent
      // finishDurablePendingCommands that reserved the id first).
      (
        doInstance as unknown as { completedCorrelationIds: Set<string> }
      ).completedCorrelationIds.add(correlationId);

      vi.mocked(Date.now).mockReturnValue(now + 35_001);
      (doInstance as unknown as { expirePendingCommands(n: number): void }).expirePendingCommands(
        now + 35_001
      );

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-1');
      expect(responses).toHaveLength(0);
    });

    it('expirePendingCommands async sweep skips durable entry already reserved in completedCorrelationIds', async () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      // Manually add to completedCorrelationIds (simulating a concurrent
      // finishDurablePendingCommands that reserved the id first).
      (
        doInstance as unknown as { completedCorrelationIds: Set<string> }
      ).completedCorrelationIds.add(correlationId);

      vi.mocked(Date.now).mockReturnValue(now + 35_001);
      (doInstance as unknown as { expirePendingCommands(n: number): void }).expirePendingCommands(
        now + 35_001
      );

      await flushAsync();

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-1');
      expect(responses).toHaveLength(0);
    });
  });

  describe('rejected initial write cleanup', () => {
    it('cleans terminalDuringInitialWrite and completedCorrelationIds when initial write rejects', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      const originalPut = ctx.storage.put;
      let initialWriteRejected = false;
      ctx.storage.put = vi.fn(async (...args: unknown[]) => {
        if (!initialWriteRejected) {
          initialWriteRejected = true;
          throw new Error('simulated write failure');
        }
        return (originalPut as any)(...args);
      });

      // Send a command — dispatchWebCommandSync triggers the initial write
      // inside waitUntil. Do NOT auto-flush yet.
      const msg = JSON.stringify({
        type: 'command',
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      void doInstance.webSocketMessage(webWs as never, msg);

      await flushAsync();

      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(0);

      expect(webWs.send).not.toHaveBeenCalled();
    });

    it('cleans terminalDuringInitialWrite when initial write fails after a terminal stash', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      let _resolveInitialWrite: (() => void) | undefined;
      let rejectInitialWrite: ((err: Error) => void) | undefined;
      const initialWritePromise = new Promise<void>((resolve, reject) => {
        _resolveInitialWrite = resolve;
        rejectInitialWrite = reject;
      });

      let initialWriteCalled = false;
      const originalPut = ctx.storage.put;
      ctx.storage.put = vi.fn(async (...args: unknown[]) => {
        if (!initialWriteCalled) {
          initialWriteCalled = true;
          return initialWritePromise;
        }
        return (originalPut as any)(...args);
      });

      const msg = JSON.stringify({
        type: 'command',
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      void doInstance.webSocketMessage(webWs as never, msg);

      await flushAsync();

      // Now disconnect the CLI. failPendingCommandsForSocket finds the
      // entry in pendingCommands and stashes a terminal in
      // terminalDuringInitialWrite because the initial write is still pending.
      mockCtx.removeSocket(cliWs);
      const disconnectPromise = disconnectCli(doInstance, cliWs);

      await flushAsync();

      const terminalStash = (
        doInstance as unknown as {
          terminalDuringInitialWrite: Map<string, unknown>;
        }
      ).terminalDuringInitialWrite;
      expect(terminalStash.size).toBe(1);

      rejectInitialWrite!(new Error('simulated write failure'));

      await disconnectPromise;
      await flushAsync();

      expect(terminalStash.size).toBe(0);
    });

    it('.finally does not clear completedCorrelationIds when expirePendingCommands already removed the entry', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      let resolveInitialWrite: (() => void) | undefined;
      const initialWritePromise = new Promise<void>(resolve => {
        resolveInitialWrite = resolve;
      });

      let initialWriteCalled = false;
      const originalPut = ctx.storage.put;
      ctx.storage.put = vi.fn(async (...args: unknown[]) => {
        if (!initialWriteCalled) {
          initialWriteCalled = true;
          return initialWritePromise;
        }
        return (originalPut as any)(...args);
      });

      const msg = JSON.stringify({
        type: 'command',
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      void doInstance.webSocketMessage(webWs as never, msg);
      await flushAsync();

      const completed = (doInstance as unknown as { completedCorrelationIds: Set<string> })
        .completedCorrelationIds;
      const pendingCommands = (
        doInstance as unknown as {
          pendingCommands: Map<string, unknown>;
        }
      ).pendingCommands;
      const correlationIds = [...pendingCommands.keys()];
      expect(correlationIds).toHaveLength(1);
      const correlationId = correlationIds[0]!;

      // Simulate expiry: remove from pendingCommands and add to completedCorrelationIds.
      pendingCommands.delete(correlationId);
      completed.add(correlationId);

      // Now resolve the initial write. The .then runs (no terminal stash),
      // then .finally runs. The .finally must NOT clear completedCorrelationIds
      // because the entry is no longer in pendingCommands (was handled by expiry).
      resolveInitialWrite!();
      await flushAsync();

      // completedCorrelationIds must still contain the correlationId because
      // the expiry path owns cleanup (via the async durable sweep).
      expect(completed.has(correlationId)).toBe(true);
    });
  });

  describe('concurrent sweep stale-snapshot claim gate', () => {
    it('a stale list snapshot cannot pass through an awaited put after another sweep delivered', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const correlationId = 'corr-sweep-gate';
      const now = 3_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      // Insert an expired durable-only pending entry (not in-memory).
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 's1',
        originalId: 'cmd-gate',
        command: 'send_message',
        expectedOwnerConnectionId: 'cli-1',
        targetConnectionId: 'cli-1',
        expiresAt: now - 1,
        webConnectionId: 'web-1',
        state: 'pending',
      });

      cliWs.send.mockClear();
      webWs.send.mockClear();

      // Override storage.list: the second call returns a stale snapshot that
      // still shows the entry as 'pending', simulating a snapshot captured
      // before the first sweep's storage.put completed.
      const realList = ctx.storage.list;
      let callCount = 0;
      ctx.storage.list = vi.fn(async (opts?: { prefix?: string }) => {
        callCount++;
        if (callCount === 1) {
          return realList(opts);
        }
        const staleMap = new Map<string, unknown>();
        staleMap.set(`pendingCommand/${correlationId}`, {
          sessionId: 's1',
          originalId: 'cmd-gate',
          command: 'send_message',
          expectedOwnerConnectionId: 'cli-1',
          targetConnectionId: 'cli-1',
          expiresAt: now - 1,
          webConnectionId: 'web-1',
          state: 'pending',
        });
        return staleMap as Awaited<ReturnType<typeof realList>>;
      });

      // First sweep: expirePendingCommands (via alarm) claims and delivers.
      await doInstance.alarm();
      await flushAsync();

      // Second sweep: finishDurablePendingCommands (via owner change) sees
      // the stale snapshot but the claim gate prevents double delivery.
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);
      await flushAsync();

      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-gate');
      expect(responses).toHaveLength(1);
      expect(responses[0]).toEqual({
        type: 'response',
        id: 'cmd-gate',
        error: {
          source: 'relay',
          code: 'COMMAND_EXPIRED',
          message: 'Command expired',
        },
      });
    });
  });

  describe('command and subscribe access recheck', () => {
    it('rejects a command on an inaccessible org session without forwarding', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sessionAccessMocks.resolveAccessibleKiloSession.mockResolvedValueOnce(null);

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });

      expect(sessionAccessMocks.resolveAccessibleKiloSession).toHaveBeenCalledWith(
        expect.anything(),
        { kiloUserId: 'usr_1', kiloSessionId: 's1' }
      );
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: {
          source: 'relay',
          code: 'SESSION_ACCESS_DENIED',
          message: 'You no longer have access to this session',
        },
      });
      expect(cliWs.send).not.toHaveBeenCalled();
    });

    it('forwards a command on an accessible personal session', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sessionAccessMocks.resolveAccessibleKiloSession.mockResolvedValueOnce({
        kiloSessionId: 's1',
        organizationId: null,
        cloudAgentSessionScopeId: null,
      });

      await sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toMatchObject({
        type: 'command',
        command: 'send_message',
        sessionId: 's1',
      });
    });

    it('does not tell the CLI to forward events when a subscribe loses org access', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sessionAccessMocks.resolveAccessibleKiloSession.mockResolvedValueOnce(null);

      await sendSubscribe(doInstance, webWs, 's1');

      expect(cliWs.send).not.toHaveBeenCalled();
    });
  });
});

describe('closeViewerSockets', () => {
  it('closes every web socket and returns the count', () => {
    const { doInstance, mockCtx } = setup();
    const web1 = addWebSocket(mockCtx, 'web-1');
    const web2 = addWebSocket(mockCtx, 'web-2');
    const cli = addCliSocket(mockCtx, 'cli-1');

    const closed = doInstance.closeViewerSockets();

    expect(closed).toBe(2);
    expect(web1.close).toHaveBeenCalledWith(1000, 'session access revoked');
    expect(web2.close).toHaveBeenCalledWith(1000, 'session access revoked');
    expect(cli.close).not.toHaveBeenCalled();
  });

  it('does not close non-web sockets', () => {
    const { doInstance, mockCtx } = setup();
    const cli1 = addCliSocket(mockCtx, 'cli-1');
    const cli2 = addCliSocket(mockCtx, 'cli-2');

    const closed = doInstance.closeViewerSockets();

    expect(closed).toBe(0);
    expect(cli1.close).not.toHaveBeenCalled();
    expect(cli2.close).not.toHaveBeenCalled();
  });
});
