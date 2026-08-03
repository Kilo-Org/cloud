import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock cloudflare:workers before importing UserConnectionDO
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const sessionIngestMocks = vi.hoisted(() => ({
  resetAttentionStatusOnCliDisconnect: vi.fn(async () => undefined),
  claimSessionReadyPush: vi.fn(async () => undefined),
  getSessionIngestDO: vi.fn(),
}));

vi.mock('./SessionIngestDO', () => ({
  getSessionIngestDO: sessionIngestMocks.getSessionIngestDO,
}));

import { MAX_CATALOG_RESULT_BYTES, UserConnectionDO } from './UserConnectionDO';

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Mock DurableObjectState (this.ctx)
// ---------------------------------------------------------------------------

/** In-memory Map-backed KV fake for ctx.storage (put/get/delete/list). */
function makeStorageFake() {
  const store = new Map<string, unknown>();
  return {
    store,
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
    setAlarm: vi.fn(),
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
    // Builds the ctx object passed to the DO constructor
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
function setup() {
  const mockCtx = createMockCtx();
  const ctx = mockCtx.build();
  const doInstance = new UserConnectionDO(ctx as never, {} as never);
  return { doInstance, ctx, mockCtx };
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
    new Request(`http://local/web?connectionId=${connectionId}`, {
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
  instance?: { name: string; projectName: string; version?: string },
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
  subscribedSessions: string[] = []
): MockWS {
  const attachment = { role: 'web' as const, connectionId, subscribedSessions };
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
  }>,
  options: {
    protocolVersion?: string;
    capabilities?: { attachments?: boolean };
    instance?: { name: string; projectName: string; version?: string };
  } = {}
) {
  const msg = JSON.stringify({
    type: 'heartbeat',
    sessions,
    ...(options.protocolVersion ? { protocolVersion: options.protocolVersion } : {}),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.instance ? { instance: options.instance } : {}),
  });
  doInstance.webSocketMessage(cliWs as never, msg);
}

/** Send a subscribe from a web ws */
function sendSubscribe(doInstance: UserConnectionDO, webWs: MockWS, sessionId: string) {
  const msg = JSON.stringify({ type: 'subscribe', sessionId });
  doInstance.webSocketMessage(webWs as never, msg);
}

/** Send an unsubscribe from a web ws */
function sendUnsubscribe(doInstance: UserConnectionDO, webWs: MockWS, sessionId: string) {
  const msg = JSON.stringify({ type: 'unsubscribe', sessionId });
  doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a viewer ping from a web ws */
function sendPing(doInstance: UserConnectionDO, webWs: MockWS, nonce: string) {
  const msg = JSON.stringify({ type: 'ping', nonce });
  doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a command from a web ws */
function sendCommand(
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
) {
  const msg = JSON.stringify({ type: 'command', ...opts });
  return doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a response from a CLI ws */
function sendCliResponse(
  doInstance: UserConnectionDO,
  cliWs: MockWS,
  opts: { id: string; result?: unknown; error?: unknown }
) {
  const msg = JSON.stringify({ type: 'response', ...opts });
  return doInstance.webSocketMessage(cliWs as never, msg);
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

// ===========================================================================
// Tests
// ===========================================================================

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

    it('reconstructs live session ownership from a hibernated CLI attachment', () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1', [makeSession('ses_1')]);

      expect(doInstance.hasActiveCliSession('ses_1')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Heartbeat processing
  // -------------------------------------------------------------------------

  describe('heartbeat processing', () => {
    it('updates session ownership and persists attachment', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      addWebSocket(mockCtx, 'web-1');

      const sessions = [makeSession('s1'), makeSession('s2')];
      sendHeartbeat(doInstance, cliWs, sessions);

      // CLI attachment updated with sessions
      const att = cliWs.deserializeAttachment() as { sessions: unknown[] };
      expect(att.sessions).toEqual(sessions);
    });

    it('removes session ownership when session disappears from heartbeat', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      addWebSocket(mockCtx, 'web-1');

      // First heartbeat: owns s1 and s2
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);

      // Second heartbeat: only s1
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Verify via command routing: command to s2 should fail (no owner)
      const webWs2 = addWebSocket(mockCtx, 'web-2');
      sendCommand(doInstance, webWs2, {
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

    it('fails an in-flight command when the session owner changes', () => {
      const { doInstance, mockCtx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      firstOwner.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(firstOwner);
      webWs.send.mockClear();

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);

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
      sendCliResponse(doInstance, firstOwner, {
        id: correlationId,
        result: 'late',
      });
      // The late sendCliResponse is filtered (the pending entry was already
      // removed by the owner-change path) so webWs sees exactly the two
      // messages produced by the owner-change heartbeat itself: the broadcast
      // sessions.heartbeat and the SESSION_OWNER_CHANGED error response.
      expect(webWs.send).toHaveBeenCalledTimes(2);
    });

    it('replays existing web subscriptions when a session gets a new CLI owner', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      addWebSocket(mockCtx, 'web-1');

      // cli1 owns s1
      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      // web subscribes to s1 — subscribe sent to cli1 (the current owner)
      const webWs = mockCtx.sockets.find(s => s._tags.includes('web'))!;
      sendSubscribe(doInstance, webWs, 's1');

      cli1.send.mockClear();
      cli2.send.mockClear();

      // cli2 now reports s1 — becomes new owner
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      // cli2 should have received the replayed subscribe for s1
      const cli2Msgs = allSent(cli2);
      expect(cli2Msgs).toContainEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('broadcasts heartbeat to every web socket regardless of subscription', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const subWeb = addWebSocket(mockCtx, 'web-sub');
      const otherWeb = addWebSocket(mockCtx, 'web-other');

      // cli1 owns s1, cli2 owns s2
      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);
      sendHeartbeat(doInstance, cli2, [makeSession('s2')]);

      // subWeb subscribes to s1, otherWeb subscribes to s2 (subscriptions are
      // irrelevant to broadcast delivery — both should still receive cli1's heartbeat)
      sendSubscribe(doInstance, subWeb, 's1');
      sendSubscribe(doInstance, otherWeb, 's2');
      subWeb.send.mockClear();
      otherWeb.send.mockClear();

      // cli1 sends heartbeat — both viewers must receive it
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

    it('delivers one heartbeat per web socket (delivery count equals ws count)', () => {
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

      // One heartbeat frame per active web socket.
      expect(web1.send).toHaveBeenCalledTimes(1);
      expect(web2.send).toHaveBeenCalledTimes(1);
      expect(web3.send).toHaveBeenCalledTimes(1);

      // The delivered payload is the same shape (including the connectionId).
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

    it('forwards the CLI-reported protocolVersion to every web socket', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        protocolVersion: '1',
      });
      sendSubscribe(doInstance, webWs, 's1');
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

    it('omits protocolVersion for a legacy CLI that never reports one', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const sent = parseSent(webWs) as { data: Record<string, unknown> };
      expect(sent.data).not.toHaveProperty('protocolVersion');
    });

    it('broadcasts removed-session information to every web socket (no subscriber special-case)', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      // subWeb subscribed to s1, otherWeb is unrelated — both must learn s1 is gone.
      const subWeb = addWebSocket(mockCtx, 'web-sub');
      const otherWeb = addWebSocket(mockCtx, 'web-other');

      // cli1 owns s1
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, subWeb, 's1');
      subWeb.send.mockClear();
      otherWeb.send.mockClear();

      // s1 disappears from heartbeat — every web socket gets a heartbeat with sessions:[].
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

    it('delivers heartbeat to web sockets that are not subscribed to anything', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // webWs has no subscriptions
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
        data: { connectionId: 'cli-1', sessions: [{ id: 's1' }] },
      });
    });

    it('schedules stale alarm on heartbeat', () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
    });

    it('sends heartbeat_ack to CLI socket', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const msgs = allSent(cliWs);
      expect(msgs).toContainEqual({ type: 'heartbeat_ack' });
    });

    // -----------------------------------------------------------------------
    // capabilities transitions (decision 8): exercise true→absent, true→false,
    // and absent/false→true through the actual DO event path and assert the
    // projected value in BOTH aggregateSessions() and the sessions.heartbeat
    // event rows, including omission when the latest heartbeat omits
    // capabilities.
    // -----------------------------------------------------------------------

    it('projects capabilities.attachments=true on every aggregateSessions row when the owning CLI advertises it', () => {
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

    it('projects the latest connection capabilities onto every sessions.heartbeat row', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // Establish ownership and subscription first so the heartbeat broadcast
      // is targeted at this web socket.
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);
      sendSubscribe(doInstance, webWs, 's1');
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

    it('omits capabilities from aggregateSessions rows when the latest heartbeat omits the field (legacy CLI)', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // First heartbeat with capabilities
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });
      // Second heartbeat omits capabilities (CLI rollback / legacy)
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const rows = doInstance.getActiveSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0]).not.toHaveProperty('capabilities');
    });

    it('omits capabilities from sessions.heartbeat event envelope when the latest heartbeat omits the field', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      // Latest heartbeat omits capabilities.
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      const sent = parseSent(webWs) as { data: Record<string, unknown> };
      expect(sent.data).not.toHaveProperty('capabilities');
    });

    it('flips capabilities.attachments from true to false on the next heartbeat (CLI revocation)', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });
      expect(doInstance.getActiveSessions()[0].capabilities).toEqual({
        attachments: true,
      });

      // CLI advertises attachments=false (e.g. feature gated, profile change)
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: false },
      });

      const rows = doInstance.getActiveSessions();
      expect(rows).toHaveLength(1);
      expect(rows[0].capabilities).toEqual({ attachments: false });
    });

    it('flips capabilities.attachments from absent to true when a legacy CLI starts advertising it', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // Legacy heartbeat — no capabilities field
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      const legacy = doInstance.getActiveSessions();
      expect(legacy[0]).not.toHaveProperty('capabilities');

      // Upgraded CLI starts advertising attachments=true
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });

      const upgraded = doInstance.getActiveSessions();
      expect(upgraded[0].capabilities).toEqual({ attachments: true });
    });

    it('flips capabilities.attachments from false to true on the next heartbeat', () => {
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

    it('projects the same owning-connection capabilities on every session row of a multi-session heartbeat', () => {
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

    it('reconstructs capabilities from a hibernated CLI attachment', () => {
      const { doInstance, mockCtx } = setup();
      // Pre-existing attachment with capabilities — simulates a socket that
      // was accepted before the DO was evicted.
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

  // -------------------------------------------------------------------------
  // Stale connection eviction
  // -------------------------------------------------------------------------

  describe('stale connection eviction', () => {
    it('closes stale connection after timeout', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // Send heartbeat to register the connection and set lastHeartbeatAt
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Fast-forward time so the connection appears stale
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

      // Both send heartbeats
      sendHeartbeat(doInstance, staleCli, [makeSession('s1')]);
      sendHeartbeat(doInstance, freshCli, [makeSession('s2')]);

      // Reset setAlarm call count
      ctx.storage.setAlarm.mockClear();

      // Make stale-1 appear stale but fresh-1 stays fresh
      const now = Date.now();
      const staleTime = now + 31_000;
      vi.spyOn(Date, 'now').mockReturnValue(staleTime);

      // Manually set lastHeartbeatAt for fresh-1 to "just now" (staleTime)
      // by sending another heartbeat from fresh-1
      sendHeartbeat(doInstance, freshCli, [makeSession('s2')]);
      ctx.storage.setAlarm.mockClear();

      await doInstance.alarm();

      // Stale one closed
      expect(staleCli.close).toHaveBeenCalledWith(4408, 'heartbeat timeout');
      // Fresh one alive
      expect(freshCli.close).not.toHaveBeenCalled();
      // Alarm rescheduled because fresh-1 remains
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
    });

    it('does not evict connection with recent heartbeat', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Time is within timeout window
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_000);

      await doInstance.alarm();

      expect(cliWs.close).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Subscribe / Unsubscribe
  // -------------------------------------------------------------------------

  describe('subscribe/unsubscribe', () => {
    it('sends subscribe to owning CLI when web subscribes', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // CLI owns s1
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendSubscribe(doInstance, webWs, 's1');

      // CLI should receive subscribe
      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('sends the active session list when web subscribes after the socket is open', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'busy', 'Fix bug')]);
      webWs.send.mockClear();
      sendSubscribe(doInstance, webWs, 's1');

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

    it('broadcasts subscribe to all CLIs when no owner found', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // No heartbeat sent, so no owner for 's1'
      // Trigger ensureState via a harmless message first
      sendSubscribe(doInstance, webWs, 's1');

      // Both CLIs should receive subscribe
      expect(cli1.send).toHaveBeenCalled();
      expect(cli2.send).toHaveBeenCalled();
      expect(parseSent(cli1)).toEqual({ type: 'subscribe', sessionId: 's1' });
      expect(parseSent(cli2)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('duplicate subscribe is idempotent for attachment', () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendSubscribe(doInstance, webWs, 's1');
      sendSubscribe(doInstance, webWs, 's1');

      const att = webWs.deserializeAttachment() as {
        subscribedSessions: string[];
      };
      expect(att.subscribedSessions).toEqual(['s1']);
    });

    it('unsubscribe sends to CLI when last subscriber leaves', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendSubscribe(doInstance, webWs, 's1');
      cliWs.send.mockClear();

      sendUnsubscribe(doInstance, webWs, 's1');

      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({
        type: 'unsubscribe',
        sessionId: 's1',
      });
    });

    it('unsubscribe does not send to CLI when other subscribers remain', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const web1 = addWebSocket(mockCtx, 'web-1');
      const web2 = addWebSocket(mockCtx, 'web-2');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendSubscribe(doInstance, web1, 's1');
      sendSubscribe(doInstance, web2, 's1');
      cliWs.send.mockClear();

      // Unsubscribe first — CLI should NOT get unsubscribe
      sendUnsubscribe(doInstance, web1, 's1');
      expect(cliWs.send).not.toHaveBeenCalled();

      // Unsubscribe second — CLI SHOULD get unsubscribe
      sendUnsubscribe(doInstance, web2, 's1');
      expect(cliWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(cliWs)).toEqual({
        type: 'unsubscribe',
        sessionId: 's1',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Viewer liveness
  // -------------------------------------------------------------------------

  describe('viewer liveness', () => {
    it('replies to a viewer ping with the matching nonce only', () => {
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

    it('does not migrate old subscriptions when replacing a viewer', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      const oldWeb = connectWebSocket(doInstance, 'viewer-1');
      sendSubscribe(doInstance, oldWeb, 's1');
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
      });
    });

    it('ignores messages from a viewer that has been replaced', () => {
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

    it('does not replace a CLI socket when a viewer connectionId collides', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'shared-id');

      connectWebSocket(doInstance, 'shared-id');

      expect(cliWs.close).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // CLI disconnect
  // -------------------------------------------------------------------------

  describe('CLI disconnect', () => {
    it('cleans up session ownership and broadcasts cli.disconnected', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();

      // Remove from sockets before disconnect (simulates runtime closing)
      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      // Web receives cli.disconnected
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

      // Session no longer routable
      const web2 = addWebSocket(mockCtx, 'web-2');
      sendCommand(doInstance, web2, {
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

      // Send command from web
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();

      // CLI disconnects
      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      // Web receives error response with original id
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
      sendCommand(doInstance, webWs, {
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

    it('fails pending commands as soon as their target socket is replaced', () => {
      const { doInstance, mockCtx } = setup();
      const firstCli = connectCliSocket(doInstance, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstCli, [makeSession('s1')]);
      firstCli.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      webWs.send.mockClear();

      connectCliSocket(doInstance, 'cli-1');

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

      // Send command routed by connectionId (no sessionId)
      sendCommand(doInstance, webWs, {
        id: 'cmd-conn',
        command: 'send_message',
        connectionId: 'cli-1',
      });
      webWs.send.mockClear();

      // CLI disconnects before responding
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

      // Send command with no sessionId or connectionId (fallback routing)
      sendCommand(doInstance, webWs, {
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

      // CLI2 connects with same connectionId (simulates reconnect)
      const cli2 = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      // CLI1's close event fires (stale socket), but cli2 still holds the connectionId
      // DON'T remove cli2 from sockets — cli2 is the replacement
      // Just remove cli1 to simulate it being closed
      mockCtx.removeSocket(cli1);
      await disconnectCli(doInstance, cli1);

      // State should NOT be cleaned up — cli2 is live
      // Verify by routing a command to s1 — should reach cli2
      cli2.send.mockClear();
      sendSubscribe(doInstance, webWs, 's1');
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

      // Web sends a command targeting s1 — should route to cli2 (the replacement)
      sendCommand(doInstance, webWs, {
        id: 'cmd-new',
        command: 'send_message',
        sessionId: 's1',
      });
      expect(cli2.send).toHaveBeenCalled();
      const correlationId = getCorrelationId(cli2);

      webWs.send.mockClear();

      // Now cli1's close event fires (stale socket teardown)
      await disconnectCli(doInstance, cli1);

      // Web should NOT have received an error for cmd-new — it was sent to cli2, not cli1
      const errorMsgs = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'cmd-new' && m.error
      );
      expect(errorMsgs).toHaveLength(0);

      // cli2 responds successfully
      webWs.send.mockClear();
      sendCliResponse(doInstance, cli2, { id: correlationId, result: 'ok' });

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

      // Web sends a command that gets forwarded to cli1
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      webWs.send.mockClear();

      // CLI2 connects with the same connectionId (reconnect)
      const cli2 = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      // cli1's close event fires — cmd-1 was sent on cli1's wire, cli2 never saw it
      mockCtx.removeSocket(cli1);
      await disconnectCli(doInstance, cli1);

      // Web should receive an error for the stranded command
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

    it('resets attention status for owned sessions before broadcasting cli.disconnected', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('s-question', 'question'),
        makeSession('s-busy', 'busy'),
      ]);
      webWs.send.mockClear();

      const callOrder: string[] = [];
      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockImplementation(async () => {
        callOrder.push('reset');
        // Disconnect must not have been broadcast yet (ordering guarantee).
        expect(
          allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')
        ).toBe(false);
      });

      // Leave the socket in getWebSockets() — matches workerd during webSocketClose.
      await disconnectCli(doInstance, cliWs);

      callOrder.push('disconnect');

      expect(sessionIngestMocks.getSessionIngestDO).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: 'usr_1',
        sessionId: 's-question',
      });
      expect(sessionIngestMocks.getSessionIngestDO).toHaveBeenCalledWith(expect.anything(), {
        kiloUserId: 'usr_1',
        sessionId: 's-busy',
      });
      // Both owned sessions are delegated; attention-only filtering is on the metadata side.
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).toHaveBeenCalledTimes(2);
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).toHaveBeenCalledWith(
        'usr_1',
        's-question'
      );
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).toHaveBeenCalledWith(
        'usr_1',
        's-busy'
      );
      expect(callOrder.filter(step => step === 'reset')).toHaveLength(2);
      expect(callOrder.at(-1)).toBe('disconnect');
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('resets attention when the closing socket is still listed in getWebSockets (workerd)', async () => {
      // Production wrangler/workerd keeps the closing WebSocket in getWebSockets()
      // during webSocketClose. Matching connectionId without excluding self would
      // treat every disconnect as a stale reconnect and skip the attention reset.
      // Prior unit tests always called removeSocket first, so they never caught this.
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s-question', 'question')]);
      webWs.send.mockClear();
      sessionIngestMocks.getSessionIngestDO.mockClear();
      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockClear();

      // Do NOT removeSocket — mirrors workerd during webSocketClose.
      expect(mockCtx.sockets).toContain(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).toHaveBeenCalledTimes(1);
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).toHaveBeenCalledWith(
        'usr_1',
        's-question'
      );
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('does not reset attention when kiloUserId is missing on the attachment', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);

      expect(sessionIngestMocks.getSessionIngestDO).not.toHaveBeenCalled();
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Skipping attention status reset on CLI disconnect: missing kiloUserId on attachment',
        { ownedSessionCount: 1 }
      );
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('does not reset attention for sessions owned by another live connection', async () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const cli2 = addCliSocket(mockCtx, 'cli-2', [], undefined, 'usr_1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1', 'question')]);
      // cli2 takes ownership of s1
      sendHeartbeat(doInstance, cli2, [makeSession('s1', 'question')]);
      webWs.send.mockClear();
      sessionIngestMocks.getSessionIngestDO.mockClear();
      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockClear();

      mockCtx.removeSocket(cli1);
      await disconnectCli(doInstance, cli1);

      // cli1 no longer owns s1, so no reset for that session
      expect(sessionIngestMocks.resetAttentionStatusOnCliDisconnect).not.toHaveBeenCalled();
      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
    });

    it('stale reconnect close does not reset attention status', async () => {
      const { doInstance, mockCtx } = setup();
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
    });

    it('still broadcasts cli.disconnected when attention reset fails', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [], undefined, 'usr_1');
      const webWs = addWebSocket(mockCtx, 'web-1');
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'question')]);
      webWs.send.mockClear();
      sessionIngestMocks.resetAttentionStatusOnCliDisconnect.mockRejectedValueOnce(
        new Error('db down')
      );

      // Leave socket listed (workerd close semantics).
      await disconnectCli(doInstance, cliWs);

      expect(allSent(webWs).some(m => m.type === 'system' && m.event === 'cli.disconnected')).toBe(
        true
      );
      expect(error).toHaveBeenCalledWith(
        'Failed to reset attention status on CLI disconnect',
        expect.objectContaining({ error: 'db down' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Web disconnect
  // -------------------------------------------------------------------------

  describe('web disconnect', () => {
    it('removes from all subscription sets', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);
      sendSubscribe(doInstance, webWs, 's1');
      sendSubscribe(doInstance, webWs, 's2');

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      // Verify: CLI events for s1 and s2 go nowhere (no crash)
      const cliEventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: {},
      });
      doInstance.webSocketMessage(cliWs as never, cliEventMsg);
      // No web sockets to receive the event — no crash = success
    });

    it('sends unsubscribe to CLI when last subscriber leaves', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, webWs, 's1');
      cliWs.send.mockClear();

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      // CLI should get unsubscribe for s1
      const msgs = allSent(cliWs);
      const unsub = msgs.find((m: Record<string, unknown>) => m.type === 'unsubscribe');
      expect(unsub).toEqual({ type: 'unsubscribe', sessionId: 's1' });
    });

    it('cleans up pending commands from disconnecting web socket', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);

      mockCtx.removeSocket(webWs);
      disconnectWeb(doInstance, webWs);

      // CLI sends response with correlationId, but the pending command is gone — no crash
      sendCliResponse(doInstance, cliWs, { id: correlationId, result: 'ok' });
    });
  });

  // -------------------------------------------------------------------------
  // Command routing
  // -------------------------------------------------------------------------

  describe('command routing', () => {
    it('routes web command to correct CLI by sessionId', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      sendCommand(doInstance, webWs, {
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

    it('routes CLI response to correct web socket with original id', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });

      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('sanitizes a relay-shaped CLI error before forwarding it to web', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('preserves CLI string errors for old-CLI compatibility', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_models',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'unknown command: list_models',
      });
    });

    it('accepts a pending response only from the targeted CLI socket', () => {
      const { doInstance, mockCtx } = setup();
      const targetCli = addCliSocket(mockCtx, 'cli-1');
      const otherCli = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, targetCli, [makeSession('s1')]);
      sendHeartbeat(doInstance, otherCli, []);
      targetCli.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(targetCli);
      webWs.send.mockClear();

      sendCliResponse(doInstance, otherCli, {
        id: correlationId,
        result: 'wrong-owner',
      });
      expect(webWs.send).not.toHaveBeenCalled();

      sendCliResponse(doInstance, targetCli, {
        id: correlationId,
        result: 'ok',
      });
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result: 'ok',
      });
    });

    it('rejects a duplicate in-flight list_models request for the same viewer session and owner', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      sendCommand(doInstance, webWs, {
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

    it('expires pending commands before handling another command', () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      vi.mocked(Date.now).mockReturnValue(now + 35_001);
      sendCommand(doInstance, webWs, {
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

    it('does not postpone pending-command expiry when heartbeats reschedule the alarm', () => {
      const now = 1_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, {
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
      sendCommand(doInstance, webWs, {
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
      sendCliResponse(doInstance, cliWs, { id: correlationId, result: 'late' });
      expect(webWs.send).toHaveBeenCalledTimes(1);
    });

    it('rejects commands after reaching the global pending-command cap', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      for (let index = 0; index < 128; index++) {
        sendCommand(doInstance, webWs, {
          id: `cmd-${index}`,
          command: 'send_message',
          sessionId: 's1',
        });
      }

      sendCommand(doInstance, webWs, {
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

    it('accepts a list_models result at exactly 512 KiB', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();
      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES);

      sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('rejects a list_models result one byte over 512 KiB', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('rejects a multibyte list_models result over 512 KiB', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('returns error when CLI not found for session', () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendCommand(doInstance, webWs, {
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

    it('rejects a stale expected session owner without forwarding', () => {
      const { doInstance, mockCtx } = setup();
      const currentOwner = addCliSocket(mockCtx, 'cli-1');
      const staleOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, currentOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, staleOwner, []);
      currentOwner.send.mockClear();
      staleOwner.send.mockClear();
      webWs.send.mockClear();

      sendCommand(doInstance, webWs, {
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

    it('routes command by connectionId to specific CLI', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const cli2 = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // Trigger ensureState
      sendHeartbeat(doInstance, cli1, []);
      sendHeartbeat(doInstance, cli2, []);
      cli1.send.mockClear();
      cli2.send.mockClear();

      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_message',
        connectionId: 'cli-2',
      });

      expect(cli1.send).not.toHaveBeenCalled();
      expect(cli2.send).toHaveBeenCalledTimes(1);
    });

    it('two web sockets with the same command id each get the correct response', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const web1 = addWebSocket(mockCtx, 'web-1');
      const web2 = addWebSocket(mockCtx, 'web-2');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();

      // Both web sockets send commands with the same id
      sendCommand(doInstance, web1, {
        id: 'dup-id',
        command: 'send_message',
        sessionId: 's1',
      });
      const corr1 = getCorrelationId(cliWs, 0);

      sendCommand(doInstance, web2, {
        id: 'dup-id',
        command: 'send_message',
        sessionId: 's1',
      });
      const corr2 = getCorrelationId(cliWs, 1);

      expect(corr1).not.toBe(corr2);

      web1.send.mockClear();
      web2.send.mockClear();

      sendCliResponse(doInstance, cliWs, { id: corr1, result: 'result-1' });
      sendCliResponse(doInstance, cliWs, { id: corr2, result: 'result-2' });

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

    it('routes to first CLI when no sessionId or connectionId given', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();

      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message' });
      expect(cliWs.send).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Command allowlist
  // -------------------------------------------------------------------------

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
      'send_command',
      'create_session',
      'exit_cli',
    ];

    it('forwards every allowed viewer command to the owning CLI', () => {
      for (const command of ALLOWED) {
        const { doInstance, mockCtx } = setup();
        const cliWs = addCliSocket(mockCtx, 'cli-1');
        const webWs = addWebSocket(mockCtx, 'web-1');

        sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
        cliWs.send.mockClear();

        sendCommand(doInstance, webWs, {
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

    it('rejects a non-allowlisted command with structured COMMAND_NOT_ALLOWED', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      sendCommand(doInstance, webWs, {
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

    it('rejects a non-allowlisted command even when targeting a known session owner via connectionId', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'shell',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      // No owner-fencing error — allowlist runs first.
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

    it('rejects a non-allowlisted command with an unknown session before owner resolution', () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendCommand(doInstance, webWs, {
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

    it('does not allocate a pending entry or forward a disallowed command', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();

      sendCommand(doInstance, webWs, {
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
      sendCliResponse(doInstance, cliWs, { id: 'fabricated', result: 'noop' });
      expect(webWs.send).toHaveBeenCalledTimes(1);
    });

    it('still rejects an owner-fenced allowed command with SESSION_OWNER_CHANGED', () => {
      const { doInstance, mockCtx } = setup();
      const currentOwner = addCliSocket(mockCtx, 'cli-1');
      const staleOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, currentOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, staleOwner, []);
      currentOwner.send.mockClear();
      staleOwner.send.mockClear();
      webWs.send.mockClear();

      sendCommand(doInstance, webWs, {
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

  // -------------------------------------------------------------------------
  // list_commands dedupe and size cap
  // -------------------------------------------------------------------------

  describe('list_commands dedupe and size cap', () => {
    it('rejects a duplicate in-flight list_commands request for the same viewer session and owner', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      sendCommand(doInstance, webWs, {
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

    it('treats list_models and list_commands as distinct for dedupe purposes', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      sendCommand(doInstance, webWs, {
        id: 'cmd-2',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });

      expect(allSent(cliWs).filter(message => message.type === 'command')).toHaveLength(2);
    });

    it('accepts a list_commands result at exactly 512 KiB', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();
      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES);

      sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('rejects a list_commands result one byte over 512 KiB', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('rejects a multibyte list_commands result over 512 KiB', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

  // -------------------------------------------------------------------------
  // Old CLI upgrade-required mapping
  // -------------------------------------------------------------------------

  describe('old CLI upgrade-required mapping', () => {
    it('maps "unknown command: list_commands" to CLI_UPGRADE_REQUIRED with slash message', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('maps "unknown command: send_command" to CLI_UPGRADE_REQUIRED with slash message', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { command: 'init' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('maps "unknown command: exit_cli" to CLI_UPGRADE_REQUIRED with slash message', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('maps "unknown command: create_session" to CLI_UPGRADE_REQUIRED with create_session message', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'create_session',
        connectionId: 'cli-1',
        data: { title: 'New session' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

    it('preserves "unknown command: list_models" because list_models is not in the upgrade-required set', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_models',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_models',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'unknown command: list_models',
      });
    });

    it('preserves an unrelated CLI string error for send_command', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        data: { command: 'init' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'session not ready',
      });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'session not ready',
      });
    });

    it('does not match a longer error that merely starts with "unknown command: list_commands"', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'list_commands',
        sessionId: 's1',
        connectionId: 'cli-1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        error: 'unknown command: list_commands: try again',
      });

      // Exact-match only — do not misclassify longer error strings.
      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        error: 'unknown command: list_commands: try again',
      });
    });

    it('preserves a longer exit_cli unknown-command error', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, {
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

  // -------------------------------------------------------------------------
  // send_command / create_session negative coverage
  // (These operations are not catalog reads, so they must NOT be deduped
  // and must NOT be subject to the 512 KiB catalog response cap.)
  // -------------------------------------------------------------------------

  describe('send_command / create_session negative coverage', () => {
    it('forwards two in-flight same-owner/same-session send_command requests without deduping', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { command: 'init' },
      });
      sendCommand(doInstance, webWs, {
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

    it('forwards two in-flight create_session requests without deduping', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'create_session',
        connectionId: 'cli-1',
        data: { title: 'First session' },
      });
      sendCommand(doInstance, webWs, {
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

    it('relays a send_command result over 512 KiB unchanged', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'send_command',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { command: 'init' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('relays a create_session result over 512 KiB unchanged', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);
      cliWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'create_session',
        connectionId: 'cli-1',
        data: { title: 'Big session' },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);
      sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });
  });

  // -------------------------------------------------------------------------
  // exit_cli routing and relay policy
  // -------------------------------------------------------------------------

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
    ])('rejects $label before routing or pending allocation', ({ input }) => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
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

    it('routes exit_cli to the selected session owner with its data unchanged', () => {
      const { doInstance, mockCtx } = setup();
      const selectedOwner = addCliSocket(mockCtx, 'cli-1');
      const otherCli = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, selectedOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, otherCli, [makeSession('s2')]);
      selectedOwner.send.mockClear();
      otherCli.send.mockClear();

      sendCommand(doInstance, webWs, {
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

    it('rejects exit_cli when the selected owner snapshot is stale', () => {
      const { doInstance, mockCtx } = setup();
      const currentOwner = addCliSocket(mockCtx, 'cli-1');
      const staleOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, currentOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, staleOwner, []);
      currentOwner.send.mockClear();
      staleOwner.send.mockClear();
      webWs.send.mockClear();

      sendCommand(doInstance, webWs, {
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

    it('rejects exit_cli when the session has no owner', () => {
      const { doInstance, mockCtx } = setup();
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendCommand(doInstance, webWs, {
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

    it('does not dedupe concurrent exit_cli requests', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      sendCommand(doInstance, webWs, {
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

    it('relays an exit_cli result over 512 KiB unchanged', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      const result = createResultWithSerializedBytes(MAX_CATALOG_RESULT_BYTES + 1);

      sendCliResponse(doInstance, cliWs, { id: correlationId, result });

      expect(parseSent(webWs)).toEqual({
        type: 'response',
        id: 'cmd-1',
        result,
      });
    });

    it('resolves exit_cli successfully when heartbeat drops the session', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      cliWs.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      // Exit's own effect: CLI heartbeat no longer lists the session.
      sendHeartbeat(doInstance, cliWs, []);

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

      // CLI's late ACK must not produce a second cmd-1 response.
      const responsesBeforeLateAck = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'cmd-1'
      ).length;
      sendCliResponse(doInstance, cliWs, { id: correlationId, result: {} });
      expect(allSent(webWs).filter(m => m.type === 'response' && m.id === 'cmd-1')).toHaveLength(
        responsesBeforeLateAck
      );
    });

    it('resolves exit_cli successfully when the owning socket closes', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, {
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
      command => {
        const { doInstance, mockCtx } = setup();
        const cliWs = addCliSocket(mockCtx, 'cli-1');
        const webWs = addWebSocket(mockCtx, 'web-1');

        sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
        cliWs.send.mockClear();
        webWs.send.mockClear();
        sendCommand(doInstance, webWs, {
          id: 'cmd-1',
          command,
          sessionId: 's1',
          connectionId: 'cli-1',
        });
        webWs.send.mockClear();

        sendHeartbeat(doInstance, cliWs, []);

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

    it('still fails exit_cli with SESSION_OWNER_CHANGED on genuine takeover', () => {
      const { doInstance, mockCtx } = setup();
      const firstOwner = addCliSocket(mockCtx, 'cli-1');
      const nextOwner = addCliSocket(mockCtx, 'cli-2');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstOwner, [makeSession('s1')]);
      sendHeartbeat(doInstance, nextOwner, []);
      firstOwner.send.mockClear();
      webWs.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      webWs.send.mockClear();

      sendHeartbeat(doInstance, nextOwner, [makeSession('s1')]);

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

    it('still fails exit_cli with SESSION_OWNER_CHANGED when socket is replaced by reconnect', () => {
      const { doInstance, mockCtx } = setup();
      const firstCli = connectCliSocket(doInstance, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, firstCli, [makeSession('s1')]);
      firstCli.send.mockClear();
      sendCommand(doInstance, webWs, {
        id: 'cmd-1',
        command: 'exit_cli',
        sessionId: 's1',
        connectionId: 'cli-1',
        data: { protocolVersion: 1 },
      });
      webWs.send.mockClear();

      connectCliSocket(doInstance, 'cli-1');

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

  // -------------------------------------------------------------------------
  // CLI event forwarding
  // -------------------------------------------------------------------------

  describe('CLI event forwarding', () => {
    it('forwards events to subscribed web sockets only', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const subWeb = addWebSocket(mockCtx, 'web-sub');
      const otherWeb = addWebSocket(mockCtx, 'web-other');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, subWeb, 's1');
      subWeb.send.mockClear();
      otherWeb.send.mockClear();

      // CLI sends event for s1
      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(subWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(subWeb)).toEqual({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      expect(otherWeb.send).not.toHaveBeenCalled();
    });

    it('sends child events to both direct child subscribers and parent subscribers', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const parentWeb = addWebSocket(mockCtx, 'web-parent');
      const childWeb = addWebSocket(mockCtx, 'web-child');

      sendHeartbeat(doInstance, cliWs, [makeSession('parent-session')]);
      sendSubscribe(doInstance, parentWeb, 'parent-session');
      sendSubscribe(doInstance, childWeb, 'child-session-1');
      parentWeb.send.mockClear();
      childWeb.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

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

    it('deduplicates when same socket subscribes to both child and parent', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('parent-session')]);
      sendSubscribe(doInstance, webWs, 'parent-session');
      sendSubscribe(doInstance, webWs, 'child-session-1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      // Should only receive once despite subscribing to both
      expect(webWs.send).toHaveBeenCalledTimes(1);
    });

    it('routes child event to parent session subscribers via parentSessionId', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('parent-session')]);
      sendSubscribe(doInstance, webWs, 'parent-session');
      webWs.send.mockClear();

      // CLI sends event for a child session with parentSessionId
      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'parent-session',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
    });

    it('drops child event when neither sessionId nor parentSessionId has subscribers', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('other-session')]);
      sendSubscribe(doInstance, webWs, 'other-session');
      webWs.send.mockClear();

      // Child event with parent that nobody subscribes to
      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 'child-session-1',
        parentSessionId: 'unknown-parent',
        event: 'message.updated',
        data: { id: 'msg-child-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).not.toHaveBeenCalled();
    });

    it('events without parentSessionId still route normally (backward compat)', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toEqual({
        type: 'event',
        sessionId: 's1',
        event: 'message.updated',
        data: { id: 'msg-1' },
      });
    });

    it('child event does not include parentSessionId when not set', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      const eventMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'session.status',
        data: {},
      });
      doInstance.webSocketMessage(cliWs as never, eventMsg);

      const sent = parseSent(webWs);
      expect(sent).not.toHaveProperty('parentSessionId');
    });
  });

  // -------------------------------------------------------------------------
  // Broadcast resilience
  // -------------------------------------------------------------------------

  describe('broadcast resilience', () => {
    it('one closed socket does not abort send to other web sockets', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const failWeb = addWebSocket(mockCtx, 'web-fail');
      const okWeb = addWebSocket(mockCtx, 'web-ok');

      // Both web sockets receive heartbeats via broadcast (no subscription needed).
      failWeb.send.mockClear();
      okWeb.send.mockClear();

      // Make failWeb throw on send
      failWeb.send.mockImplementation(() => {
        throw new Error('socket closed');
      });

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // okWeb should still receive the message
      expect(okWeb.send).toHaveBeenCalledTimes(1);
      expect(parseSent(okWeb)).toMatchObject({
        type: 'system',
        event: 'sessions.heartbeat',
      });
    });
  });

  // -------------------------------------------------------------------------
  // Hibernation recovery (ensureState)
  // -------------------------------------------------------------------------

  describe('ensureState (hibernation recovery)', () => {
    it('reconstructs sessionOwners and connectionSessions from CLI attachments', () => {
      const { doInstance, mockCtx } = setup();

      // Simulate hibernation: sockets exist with pre-set attachments
      const sessions = [makeSession('s1'), makeSession('s2')];
      addCliSocket(mockCtx, 'cli-1', sessions);
      const webWs = addWebSocket(mockCtx, 'web-1');

      // Trigger ensureState by calling any method (e.g., webSocketMessage with subscribe)
      sendSubscribe(doInstance, webWs, 's1');

      // Verify state was reconstructed by routing a command
      const web2 = addWebSocket(mockCtx, 'web-2');
      sendCommand(doInstance, web2, {
        id: 'cmd-1',
        command: 'send_message',
        sessionId: 's1',
      });

      // Should route to cli-1 (not "Session owner not found")
      const cliWs = mockCtx.sockets.find(s => s._tags.includes('cli'));
      expect(cliWs?.send).toHaveBeenCalled();
      const cliMsgs = allSent(cliWs!);
      const cmdMsg = cliMsgs.find((m: Record<string, unknown>) => m.type === 'command');
      expect(cmdMsg).toMatchObject({
        type: 'command',
        command: 'send_message',
      });
    });

    it('reconstructs webSubscriptions from web attachments', () => {
      const { doInstance, mockCtx } = setup();

      const cliWs = addCliSocket(mockCtx, 'cli-1', [makeSession('s1')]);
      // Web socket with pre-existing subscription (from hibernation)
      const webWs = addWebSocket(mockCtx, 'web-1', ['s1']);

      // Trigger ensureState by calling any method
      const triggerMsg = JSON.stringify({
        type: 'event',
        sessionId: 's1',
        event: 'test',
        data: {},
      });
      doInstance.webSocketMessage(cliWs as never, triggerMsg);

      // webWs should have received the event because it was subscribed via attachment
      expect(webWs.send).toHaveBeenCalledTimes(1);
      expect(parseSent(webWs)).toMatchObject({
        type: 'event',
        sessionId: 's1',
      });
    });

    it('does not restore subscriptions from a viewer already replaced before hibernation', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [makeSession('s1')]);
      const replacedWeb = addWebSocket(mockCtx, 'web-old', ['s1']);
      replacedWeb.serializeAttachment({
        role: 'web',
        connectionId: 'web-old',
        subscribedSessions: ['s1'],
        replaced: true,
      });

      doInstance.webSocketMessage(
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

  // -------------------------------------------------------------------------
  // getActiveSessions RPC
  // -------------------------------------------------------------------------

  describe('getActiveSessions', () => {
    it('returns sessions from live CLI connections', () => {
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

    it('includes the CLI-reported protocolVersion on each session row', () => {
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

    it('excludes sessions from stale connections without live sockets', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Remove from sockets (simulates close)
      mockCtx.removeSocket(cliWs);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([]);
    });

    it('excludes child sessions reported with parentSessionId in heartbeat', () => {
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

    it('cleans up child tracking when session disappears from heartbeat', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // First heartbeat: root + child
      sendHeartbeat(doInstance, cliWs, [
        makeSession('root-1', 'busy', 'Root session'),
        makeSession('child-1', 'busy', 'Child session', 'root-1'),
      ]);

      // Second heartbeat: only root (child finished)
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

    it('forwards the per-session platform when the CLI reports it (newer CLIs)', () => {
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

    it('omits the platform key entirely for legacy CLIs (byte-identical response)', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // Legacy CLI heartbeat without platform.
      sendHeartbeat(doInstance, cliWs, [makeSession('s1', 'busy', 'Legacy')]);

      const result = doInstance.getActiveSessions();
      expect(result).toEqual([
        { id: 's1', status: 'busy', title: 'Legacy', connectionId: 'cli-1' },
      ]);
      expect(result[0]).not.toHaveProperty('platform');
    });
  });

  // -------------------------------------------------------------------------
  // getConnectedInstances RPC (W3)
  // -------------------------------------------------------------------------

  describe('getConnectedInstances', () => {
    it('returns one row per CLI socket that has an `instance` attachment', () => {
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

    it('omits the `version` key when the CLI did not report one', () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1', [], {
        name: 'laptop-1',
        projectName: 'kilo',
      });

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([{ connectionId: 'cli-1', name: 'laptop-1', projectName: 'kilo' }]);
      expect(instances[0]).not.toHaveProperty('version');
    });

    it('excludes legacy CLIs that never reported an `instance`', () => {
      const { doInstance, mockCtx } = setup();
      // Legacy CLI: pre-spawner heartbeat has no `instance`.
      const cliWs = addCliSocket(mockCtx, 'legacy-1');
      sendHeartbeat(doInstance, cliWs, []);

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([]);
    });

    it('excludes web sockets', () => {
      const { doInstance, mockCtx } = setup();
      addWebSocket(mockCtx);
      // A web socket with an `instance`-shaped attachment must still be skipped.
      const webWithInstance = createMockWs(['web'], {
        role: 'web',
        connectionId: 'web-1',
        subscribedSessions: [],
      } as never);
      mockCtx.addSocket(webWithInstance);

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([]);
    });

    it('reads `instance` directly from the live socket (no in-memory map)', () => {
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

    it('includes capabilities when the CLI attachment advertises them', () => {
      const { doInstance, mockCtx } = setup();
      // Hibernated attachment carries capabilities — same source
      // getConnectedInstances already uses for instance/version.
      const cliWs = createMockWs(['cli'], {
        role: 'cli',
        connectionId: 'cli-cap',
        sessions: [],
        instance: { name: 'laptop-cap', projectName: 'kilo' },
        capabilities: { attachments: true },
      });
      mockCtx.addSocket(cliWs);

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toEqual([
        {
          connectionId: 'cli-cap',
          name: 'laptop-cap',
          projectName: 'kilo',
          capabilities: { attachments: true },
        },
      ]);
    });

    it('omits capabilities when the CLI attachment has none (legacy CLI)', () => {
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

    it('persists `instance` in the WS attachment across heartbeats', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [], {
        protocolVersion: '1',
        instance: { name: 'laptop-1', projectName: 'kilo', version: '0.1.0' },
      });

      const att = cliWs.deserializeAttachment() as {
        instance?: { name: string };
      };
      expect(att.instance).toEqual({
        name: 'laptop-1',
        projectName: 'kilo',
        version: '0.1.0',
      });
    });

    it('drops `instance` from the attachment on a subsequent heartbeat that omits it', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      // First heartbeat: with instance.
      sendHeartbeat(doInstance, cliWs, [], {
        instance: { name: 'laptop-1', projectName: 'kilo' },
      });
      // Second heartbeat: instance removed (legacy fallback). The DO must not
      // keep a stale `instance` value in the attachment.
      sendHeartbeat(doInstance, cliWs, []);

      const att = cliWs.deserializeAttachment() as { instance?: unknown };
      expect(att.instance).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // WS attachment size guardrail (W3)
  // -------------------------------------------------------------------------

  describe('WS attachment size', () => {
    // The Cloudflare `serializeAttachment` budget is ~2 KiB. A bounded
    // instance object (name+projectName+version, all max length) adds well
    // under 200 bytes; this test pins that contract so a future schema
    // change cannot silently push us over the budget.
    const SERIALIZE_ATTACHMENT_BUDGET = 2048;
    // Bounded `instance` = 64 + 64 + 32 chars content + JSON framing ≈ 200
    // bytes; we allow a 25% safety margin so a future protocol bump to the
    // instance shape (e.g. adding `pid`) cannot silently blow the 2 KiB
    // attachment budget.
    const INSTANCE_HEADROOM = 250;

    it('keeps the combined CLI attachment comfortably under 2 KiB with a worst-case instance', () => {
      const worstCaseInstance = {
        name: 'x'.repeat(64),
        projectName: 'x'.repeat(64),
        version: 'x'.repeat(32),
      };
      // 4 sessions with realistic-but-large titles, git URLs, and branches.
      // (4 is a generous upper bound for a single CLI owning a live session
      // fleet; the actual HeartbeatSession shape imposes tighter per-field
      // limits at the protocol layer.)
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
        protocolVersion: '255.255.65535',
        kiloUserId: 'usr_' + 'x'.repeat(28),
        instance: worstCaseInstance,
      };

      const serialized = new TextEncoder().encode(JSON.stringify(attachment)).byteLength;

      expect(serialized).toBeLessThan(SERIALIZE_ATTACHMENT_BUDGET);
      // Sanity: the bounded instance alone is far below the headroom.
      const instanceBytes = new TextEncoder().encode(JSON.stringify(worstCaseInstance)).byteLength;
      expect(instanceBytes).toBeLessThan(INSTANCE_HEADROOM);
    });
  });

  // -------------------------------------------------------------------------
  // Owner-unique active sessions (W-followup)
  // -------------------------------------------------------------------------

  describe('owner-unique active sessions', () => {
    it('emits owner-unique rows: ownership transfer with both CLIs live yields exactly one row under the new owner', () => {
      const { doInstance, ctx, mockCtx } = setup();
      const oldOwner = addCliSocket(mockCtx, 'cli-old');
      const newOwner = addCliSocket(mockCtx, 'cli-new');

      // cli-old claims the session
      sendHeartbeat(doInstance, oldOwner, [makeSession('ses_transfer', 'busy', 'Transfer me')]);

      // cli-new also claims the same session id while cli-old is still connected.
      // The DO routes the session to the new owner (sessionOwners.get === 'cli-new').
      sendHeartbeat(doInstance, newOwner, [makeSession('ses_transfer', 'busy', 'Transfer me')]);

      // Both CLIs are still live sockets — the snapshot should see them both.
      expect(ctx.getWebSockets('cli').map(ws => ws.deserializeAttachment())).toEqual([
        expect.objectContaining({ role: 'cli', connectionId: 'cli-old' }),
        expect.objectContaining({ role: 'cli', connectionId: 'cli-new' }),
      ]);

      const result = doInstance.getActiveSessions();

      // Exactly one row for the transferred session id, under the new owner.
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

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('ignores non-JSON messages', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      // Should not throw
      doInstance.webSocketMessage(cliWs as never, 'not-json');
    });

    it('logs invalid CLI JSON metadata without raw payload content', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const malformed = '{"secret":"raw-secret-must-not-be-logged"';

      doInstance.webSocketMessage(cliWs as never, malformed);

      expect(warn).toHaveBeenCalledWith('Failed to parse WebSocket message as JSON', {
        role: 'cli',
        connectionId: 'cli-1',
        byteCount: new TextEncoder().encode(malformed).byteLength,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain('raw-secret-must-not-be-logged');
    });

    it('ignores messages from socket with no attachment', () => {
      const { doInstance, mockCtx } = setup();
      const ws = createMockWs(['cli'], null);
      mockCtx.addSocket(ws);

      // Trigger ensureState first
      doInstance.webSocketMessage(ws as never, JSON.stringify({ type: 'heartbeat', sessions: [] }));
      // Should not throw
    });

    it('ignores messages that fail Zod validation', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, []); // trigger ensureState

      // Invalid CLI message
      const badMsg = JSON.stringify({ type: 'invalid_type' });
      doInstance.webSocketMessage(cliWs as never, badMsg);
      // Should not throw

      // Invalid web message
      const webWs = addWebSocket(mockCtx, 'web-1');
      doInstance.webSocketMessage(webWs as never, badMsg);
      // Should not throw
    });

    it('logs malformed CLI message metadata without raw payload content', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const secret = 'raw-secret-must-not-be-logged';
      const malformed = JSON.stringify({
        type: 'response',
        id: 123,
        result: { secret },
      });

      doInstance.webSocketMessage(cliWs as never, malformed);

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

      // Remove CLI so disconnect can clean up
      mockCtx.removeSocket(cliWs);
      await doInstance.webSocketError(cliWs as never);

      // Should broadcast cli.disconnected
      const msgs = allSent(webWs);
      expect(msgs.some((m: Record<string, unknown>) => m.event === 'cli.disconnected')).toBe(true);
    });

    it('CLI response for unknown correlation ID is a no-op', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, []);

      // Should not throw
      sendCliResponse(doInstance, cliWs, { id: 'nonexistent', result: 'ok' });
    });
  });

  // -------------------------------------------------------------------------
  // Session-ready push (delayed, Decision 9)
  // -------------------------------------------------------------------------

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

      // Subsequent heartbeats for the same session must not re-schedule.
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
      // Simulate a prior retry so attempts is non-zero.
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
      // Must not replace the pending entry with a fresh fireAt/attempts:0 put.
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
      // No CLI sockets — only a pending readyPush in KV, rebuilt via one-shot.
      const fireAt = Date.now() + 5_000;
      await ctx.storage.put('readyPush:ses_orphan', {
        kiloUserId: 'usr_1',
        title: 'Orphan',
        fireAt,
        attempts: 0,
      });

      // Trigger scheduleNextAlarm via a zero-session heartbeat on a fresh CLI,
      // then disconnect so lastHeartbeatAt is cleared… simpler: call schedule
      // through a heartbeat that does not add readyPush (legacy, no kiloUserId),
      // with empty lastHeartbeat — actually ensureState + getActiveSessions
      // doesn't schedule. Use notifySessionRenamed path which calls ensureState
      // only. Direct approach: seed mirror by listing via a first schedule kick.
      // Connecting a CLI and immediately closing leaves empty lastHeartbeat after
      // disconnect; instead invoke alarm() which calls scheduleNextAlarm at end.
      ctx.storage.setAlarm.mockClear();
      // Force a schedule by going through a heartbeat that schedules readyPush
      // then clear lastHeartbeat by disconnecting — still has readyPush mirror.
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_arm')]);
      await flushAsync();
      // Disconnect removes lastHeartbeatAt for this connection
      await disconnectCli(doInstance, cliWs);
      ctx.storage.setAlarm.mockClear();

      // Re-arm: scheduleNextAlarm is private; kick via alarm() which ends with it.
      // After disconnect, lastHeartbeatAt is empty and pendingCommands empty;
      // readyPush mirror still holds ses_arm.
      await doInstance.alarm();
      expect(ctx.storage.setAlarm).toHaveBeenCalled();
      const armedAt = ctx.storage.setAlarm.mock.calls.at(-1)?.[0] as number;
      // fireAt is now+5s; after alarm() now is still the mocked now, so arms at fireAt
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
      // Seed mirror via first-sight path, then replace with overdue
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_overdue', 'idle', 'Old')]);
      await flushAsync();
      // Overwrite with overdue fireAt and mirror
      await ctx.storage.put('readyPush:ses_overdue', {
        kiloUserId: 'usr_1',
        title: 'Old',
        fireAt: now - 1_000,
        attempts: 0,
      });
      // Access private mirror to set overdue fireAt for scheduling
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

      // Kick schedule with empty mirror → async rebuild
      const cliWs = addCliSocket(mockCtx, 'cli-legacy'); // no kiloUserId → no new readyPush
      sendHeartbeat(doInstance, cliWs, []);
      await flushAsync();

      expect(internal.readyPushRebuilt).toBe(true);
      expect(internal.readyPushFireAt.get('ses_rebuild')).toBe(now + 2_000);
      expect(ctx.storage.setAlarm).toHaveBeenCalled();

      // Failed list leaves flag false
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

      // Establish ownership for both sessions first (first-sight schedules entries).
      sendHeartbeat(doInstance, cliWs, [
        makeSession('ses_t', 'idle', 'Stored'),
        makeSession('ses_same', 'idle', 'Same'),
      ]);
      await flushAsync();

      // Diverged title for ses_t; matching title for ses_same. Force both overdue.
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

      // Advance past backoff so attempt 2 is due.
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
      // Ensure ensureState runs so DO is live
      addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');
      await ctx.storage.put('readyPush:ses_kv_only', {
        kiloUserId: 'usr_1',
        title: 'KV',
        fireAt: now - 1,
        attempts: 0,
      });
      // Mirror intentionally empty
      const internal = doInstance as unknown as {
        readyPushFireAt: Map<string, number>;
      };
      internal.readyPushFireAt.clear();

      await doInstance.alarm();
      expect(claimSessionReadyPush).toHaveBeenCalledWith('usr_1', 'ses_kv_only', undefined);
      expect(ctx.storage.store.has('readyPush:ses_kv_only')).toBe(false);
    });

    it('stores the kiloUserId from the connection URL on the attachment', () => {
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

  // -------------------------------------------------------------------------
  // notifySessionRenamed + rename catch-up (lazy KV per heartbeat)
  // -------------------------------------------------------------------------

  describe('notifySessionRenamed', () => {
    it('delivers session.renamed to the owning CLI and always persists KV', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1', [makeSession('ses_r')]);
      // Establish ownership via heartbeat
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

      // Mismatch → re-emit
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

      // Match → delete entry
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

  // ---------------------------------------------------------------------------
  // D8: durable remote CLI correlations
  //
  // Force-hibernate mechanism: these tests simulate hibernation by
  // pre-populating the storage fake (ctx.storage.put) with durable entries,
  // then re-instantiating the DO and calling ensureState().  Cloudflare
  // Durable Object hibernation is not directly triggerable from the Vitest
  // harness; the test covers the reconstruction path instead.
  // ---------------------------------------------------------------------------

  describe('durable pending commands', () => {
    it('rehydrates a CLI reply on wake and routes it to the live web socket (D8 case 1)', async () => {
      const { doInstance, mockCtx, ctx } = setup();

      // Pre-populate a durable pending entry.
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

      // Set up a live CLI socket with the matching connectionId.
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-a', 'busy', 'Session A')]);

      // Set up a live web socket with the matching connectionId.
      const webWs = addWebSocket(mockCtx, 'web-1');

      // Send the CLI response with the correlation id.
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });
      await flushAsync();

      // The response must be routed to the web socket.
      const responses = allSent(webWs).filter(m => m.type === 'response');
      expect(responses).toHaveLength(1);
      expect(responses[0].id).toBe('original-req-1');
      expect(responses[0].result).toEqual({ ok: true });

      // The durable entry must be marked 'done' with the result.
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

      // Set up a live CLI but NO web socket.
      const cliWs = addCliSocket(mockCtx, 'cli-2');
      sendHeartbeat(doInstance, cliWs, [makeSession('ses-b', 'busy', 'Session B')]);

      // Send the CLI response.
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { ok: true },
      });
      await flushAsync();

      // The durable entry must be marked 'done'.
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

      // Clear CLI sends after heartbeat setup.
      cliWs.send.mockClear();

      // Send a second command with the same mutationId.
      await sendCommand(doInstance, webWs, {
        id: 'second-req',
        command: 'send_message',
        sessionId: 'ses-c',
        connectionId: 'cli-3',
        data: { ok: true },
        mutationId,
      });
      await flushAsync();

      // The web socket must receive a dedupe error, not forward to CLI.
      const responses = allSent(webWs).filter(m => m.type === 'response' && m.id === 'second-req');
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toBeDefined();
      expect((responses[0].error as Record<string, unknown>).code).toBe('COMMAND_ALREADY_PENDING');

      // No new command must be sent to the CLI.
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

      // Send a retry with the same mutationId but new wire id.
      await sendCommand(doInstance, webWs, {
        id: 'retry-req-id',
        command: 'send_message',
        sessionId: 'ses-d',
        connectionId: 'cli-4',
        mutationId,
      });
      await flushAsync();

      // The response must come under the new request's id.
      const responses = allSent(webWs).filter(
        m => m.type === 'response' && m.id === 'retry-req-id'
      );
      expect(responses).toHaveLength(1);
      expect(responses[0].result).toEqual({ stored: true });

      // The durable entry's originalId must be updated for future retries.
      const entry = await ctx.storage.get(`pendingCommand/${mutationId}`);
      expect((entry as Record<string, unknown>).originalId).toBe('retry-req-id');

      // No command must reach the CLI.
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
        // No mutationId.
      });
      await flushAsync();

      // The command must be forwarded to the CLI with a random correlationId.
      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(1);
      expect(cliCommands[0].id).toBeTruthy();
      expect(cliCommands[0].mutationId).toBeUndefined();

      // A durable entry must exist (persisted at creation time).
      const correlationId = cliCommands[0].id as string;
      await flushAsync();
      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();

      // Send CLI response to verify normal resolution.
      await sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { normal: true },
      });
      await flushAsync();

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

      // Verify durable entry exists.
      await flushAsync();
      let entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();

      // Disconnect the web socket.
      doInstance.webSocketClose(webWs as never, 1000, '', true);
      await flushAsync();

      // The durable entry must still exist.
      entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
    });

    it('expires a durable pending entry and marks it done with COMMAND_EXPIRED_ERROR', async () => {
      const { mockCtx, ctx } = setup();

      const pastTime = Date.now() - 10_000;
      const correlationId = 'mut-expired';

      // Set expiredAt in the past.
      await ctx.storage.put(`pendingCommand/${correlationId}`, {
        sessionId: 'ses-g',
        originalId: 'expired-req',
        command: 'send_message',
        targetConnectionId: 'cli-7',
        expiresAt: pastTime,
        webConnectionId: 'web-7',
        state: 'pending' as const,
      });

      // Create a fresh DO to simulate a wake with the durable entry.
      const doInstance2 = new UserConnectionDO(ctx as never, {} as never);

      // Set up sockets so the DO has something to work with.
      const cliWs = addCliSocket(mockCtx, 'cli-7');
      sendHeartbeat(doInstance2, cliWs, [makeSession('ses-g', 'busy', 'Session G')]);

      // Trigger alarm which calls expirePendingCommands.
      await doInstance2.alarm();
      await flushAsync();

      // The entry must be marked done with COMMAND_EXPIRED_ERROR.
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

      // Pre-fill storage with many durable entries to approach the cap.
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

      // The first command (no mutationId) is just within the cap: 0 in-memory + 1 new = 1.
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

      // No second command to CLI.
      const cliCommands = allSent(cliWs).filter(m => m.type === 'command');
      expect(cliCommands).toHaveLength(0);
    });

    // -------------------------------------------------------------------------
    // Fix 2: durable entry persists the exact terminal error sent live
    // -------------------------------------------------------------------------
    it('persists the exact CLI string error in the durable entry, not CLI_COMMAND_ERROR', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, {
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
      await flushAsync();

      // Live response carries the original string.
      const live = parseSent(webWs) as { error: unknown };
      expect(live.error).toBe('unknown command: list_models');

      // Durable entry carries the same string.
      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toBe('unknown command: list_models');
    });

    it('persists the exact structured CLI_UPGRADE_REQUIRED error in the durable entry', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, {
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
      await flushAsync();

      // Live response carries the structured error.
      const live = parseSent(webWs) as { error: unknown };
      expect(live.error).toEqual({
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
      });

      // Durable entry carries the same structured error.
      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'CLI_UPGRADE_REQUIRED',
        message: 'Remote slash commands require a newer Kilo CLI. Update Kilo CLI and reconnect.',
      });
    });

    // -------------------------------------------------------------------------
    // Fix 3: reply durability — durable write is extended via ctx.waitUntil
    // -------------------------------------------------------------------------
    it('completes the durable write for a CLI response via ctx.waitUntil', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, {
        id: 'dur-1',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);

      // Send CLI response — the fix uses ctx.waitUntil so the durable
      // write is extended past the handler's return. flushAsync settles
      // the waitUntil promise in the test harness.
      sendCliResponse(doInstance, cliWs, {
        id: correlationId,
        result: { durable: true },
      });
      await flushAsync();

      // The durable entry must now be written.
      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect(entry).toBeDefined();
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).result).toEqual({
        durable: true,
      });
    });

    // -------------------------------------------------------------------------
    // Fix 5: rehydrated oversized catalog sends to live web socket
    // -------------------------------------------------------------------------
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
      await flushAsync();

      // The live web socket must receive the oversized error.
      const responses = allSent(webWs).filter(m => m.type === 'response');
      expect(responses).toHaveLength(1);
      expect(responses[0].error).toEqual({
        source: 'relay',
        code: 'CATALOG_TOO_LARGE',
        message: 'Model catalog response is too large',
      });

      // The durable entry must be marked done.
      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toEqual({
        source: 'relay',
        code: 'CATALOG_TOO_LARGE',
        message: 'Model catalog response is too large',
      });
    });

    // -------------------------------------------------------------------------
    // Fix 6: bare 'CLI disconnected' string for live sends
    // -------------------------------------------------------------------------
    it('sends a bare string "CLI disconnected" to the live web socket on disconnect', async () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, {
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
      // Live wire must carry the bare string, not a structured object.
      expect(errorResp!.error).toBe('CLI disconnected');
    });

    it('stores the live CLI-disconnected error in the durable entry for retries', async () => {
      const { doInstance, mockCtx, ctx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      sendCommand(doInstance, webWs, {
        id: 'cmd-dur-disco',
        command: 'send_message',
        sessionId: 's1',
      });
      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      await disconnectCli(doInstance, cliWs);
      await flushAsync();

      // Durable entry must carry structured error for typed retries.
      const entry = await ctx.storage.get(`pendingCommand/${correlationId}`);
      expect((entry as Record<string, unknown>).state).toBe('done');
      expect((entry as Record<string, unknown>).error).toBe('CLI disconnected');
    });
  });
});
