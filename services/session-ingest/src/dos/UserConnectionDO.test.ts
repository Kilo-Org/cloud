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

function createMockCtx() {
  const sockets: MockWS[] = [];
  return {
    sockets,
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
        storage: {
          setAlarm: vi.fn(),
        },
        waitUntil: vi.fn(),
      };
    },
  };
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
  instance?: { name: string; projectName: string; version?: string }
): MockWS {
  const attachment: {
    role: 'cli';
    connectionId: string;
    sessions: typeof sessions;
    instance?: typeof instance;
  } = { role: 'cli', connectionId, sessions };
  if (instance) attachment.instance = instance;
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
  opts: { id: string; command: string; sessionId?: string; connectionId?: string; data?: unknown }
) {
  const msg = JSON.stringify({ type: 'command', ...opts });
  doInstance.webSocketMessage(webWs as never, msg);
}

/** Send a response from a CLI ws */
function sendCliResponse(
  doInstance: UserConnectionDO,
  cliWs: MockWS,
  opts: { id: string; result?: unknown; error?: unknown }
) {
  const msg = JSON.stringify({ type: 'response', ...opts });
  doInstance.webSocketMessage(cliWs as never, msg);
}

function createResultWithSerializedBytes(targetBytes: number): { padding: string } {
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

/** Trigger CLI disconnect */
function disconnectCli(doInstance: UserConnectionDO, cliWs: MockWS) {
  doInstance.webSocketClose(cliWs as never, 0, '', false);
}

/** Trigger web disconnect */
function disconnectWeb(doInstance: UserConnectionDO, webWs: MockWS) {
  doInstance.webSocketClose(webWs as never, 0, '', false);
}

// ===========================================================================
// Tests
// ===========================================================================

describe('UserConnectionDO', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
        doInstance.notifySessionEvent({ type: 'session.created', data: { source: 'v1' } } as never)
      ).rejects.toThrow();
      expect(webWs.send).not.toHaveBeenCalled();
    });
  });

  describe('hasActiveCliSession', () => {
    it('tracks whether a connected CLI heartbeat currently owns the session', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      expect(doInstance.hasActiveCliSession('ses_1')).toBe(false);

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_1')]);

      expect(doInstance.hasActiveCliSession('ses_1')).toBe(true);

      mockCtx.removeSocket(cliWs);
      disconnectCli(doInstance, cliWs);

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
      sendCommand(doInstance, webWs2, { id: 'cmd-1', command: 'send_message', sessionId: 's2' });
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
      sendCliResponse(doInstance, firstOwner, { id: correlationId, result: 'late' });
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
        const sent = parseSent(ws) as { data: { connectionId: string; sessions: unknown[] } };
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

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], { protocolVersion: '1' });
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], { protocolVersion: '1' });

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

    it('projects capabilities.attachments=true on every session row of the sessions.heartbeat event', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      // Establish ownership and subscription first so the heartbeat broadcast
      // is targeted at this web socket.
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')]);
      sendSubscribe(doInstance, webWs, 's1');
      webWs.send.mockClear();

      // Now advertise capabilities: the broadcast heartbeat must carry the
      // capabilities on the message envelope, but each session row only
      // carries its own owning-connection identity (capabilities is read from
      // the connection, not the per-session row of the broadcast). The S3b
      // SDK consumer re-attaches capabilities per-row in the consumer layer.
      sendHeartbeat(doInstance, cliWs, [makeSession('s1'), makeSession('s2')], {
        capabilities: { attachments: true },
      });

      const sent = parseSent(webWs) as { data: { capabilities?: unknown; sessions: unknown[] } };
      expect(sent.data.capabilities).toEqual({ attachments: true });
      expect(sent.data.sessions).toHaveLength(2);

      // aggregateSessions() must still surface the latest capabilities, which
      // is the S3b consumer's source of truth for the per-row projection.
      const rows = doInstance.getActiveSessions();
      for (const row of rows) {
        expect(row.capabilities).toEqual({ attachments: true });
      }
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
      expect(doInstance.getActiveSessions()[0].capabilities).toEqual({ attachments: true });

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
      expect(doInstance.getActiveSessions()[0].capabilities).toEqual({ attachments: false });

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')], {
        capabilities: { attachments: true },
      });

      expect(doInstance.getActiveSessions()[0].capabilities).toEqual({ attachments: true });
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
        data: { sessions: [{ id: 's1', status: 'busy', title: 'Fix bug', connectionId: 'cli-1' }] },
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

      const att = webWs.deserializeAttachment() as { subscribedSessions: string[] };
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
      expect(parseSent(cliWs)).toEqual({ type: 'unsubscribe', sessionId: 's1' });
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
      expect(parseSent(cliWs)).toEqual({ type: 'unsubscribe', sessionId: 's1' });
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
      expect(parseSent(cliWs)).toEqual({ type: 'unsubscribe', sessionId: 's1' });
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
    it('cleans up session ownership and broadcasts cli.disconnected', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();

      // Remove from sockets before disconnect (simulates runtime closing)
      mockCtx.removeSocket(cliWs);
      disconnectCli(doInstance, cliWs);

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
      sendCommand(doInstance, web2, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });
      expect(parseSent(web2)).toMatchObject({ type: 'response', error: 'Session owner not found' });
    });

    it('sends error responses for pending commands on disconnect', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);

      // Send command from web
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });
      webWs.send.mockClear();

      // CLI disconnects
      mockCtx.removeSocket(cliWs);
      disconnectCli(doInstance, cliWs);

      // Web receives error response with original id
      const msgs = allSent(webWs);
      const errorResp = msgs.find(
        (m: Record<string, unknown>) => m.type === 'response' && m.id === 'cmd-1'
      );
      expect(errorResp).toMatchObject({ type: 'response', id: 'cmd-1', error: 'CLI disconnected' });
    });

    it('reports owner change when an owner-fenced command target disconnects', () => {
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
      disconnectCli(doInstance, cliWs);

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

    it('sends error for connection-routed pending commands on CLI disconnect', () => {
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
      disconnectCli(doInstance, cliWs);

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

    it('sends error for fallback-routed pending commands on CLI disconnect', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, []);

      // Send command with no sessionId or connectionId (fallback routing)
      sendCommand(doInstance, webWs, { id: 'cmd-fallback', command: 'send_message' });
      webWs.send.mockClear();

      mockCtx.removeSocket(cliWs);
      disconnectCli(doInstance, cliWs);

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

    it('reconnecting CLI — old socket close does not destroy state', () => {
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
      disconnectCli(doInstance, cli1);

      // State should NOT be cleaned up — cli2 is live
      // Verify by routing a command to s1 — should reach cli2
      cli2.send.mockClear();
      sendSubscribe(doInstance, webWs, 's1');
      expect(cli2.send).toHaveBeenCalled();
      expect(parseSent(cli2)).toEqual({ type: 'subscribe', sessionId: 's1' });
    });

    it('reconnecting CLI — commands sent to replacement socket are not spuriously failed', () => {
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
      sendCommand(doInstance, webWs, { id: 'cmd-new', command: 'send_message', sessionId: 's1' });
      expect(cli2.send).toHaveBeenCalled();
      const correlationId = getCorrelationId(cli2);

      webWs.send.mockClear();

      // Now cli1's close event fires (stale socket teardown)
      disconnectCli(doInstance, cli1);

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

    it('reconnecting CLI — pending commands from old socket get error responses', () => {
      const { doInstance, mockCtx } = setup();
      const cli1 = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cli1, [makeSession('s1')]);

      // Web sends a command that gets forwarded to cli1
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });
      webWs.send.mockClear();

      // CLI2 connects with the same connectionId (reconnect)
      const cli2 = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cli2, [makeSession('s1')]);

      // cli1's close event fires — cmd-1 was sent on cli1's wire, cli2 never saw it
      mockCtx.removeSocket(cli1);
      disconnectCli(doInstance, cli1);

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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });
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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });

      const correlationId = getCorrelationId(cliWs);
      webWs.send.mockClear();

      sendCliResponse(doInstance, cliWs, { id: correlationId, result: { success: true } });

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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });
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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'list_models', sessionId: 's1' });
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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });
      const correlationId = getCorrelationId(targetCli);
      webWs.send.mockClear();

      sendCliResponse(doInstance, otherCli, { id: correlationId, result: 'wrong-owner' });
      expect(webWs.send).not.toHaveBeenCalled();

      sendCliResponse(doInstance, targetCli, { id: correlationId, result: 'ok' });
      expect(parseSent(webWs)).toEqual({ type: 'response', id: 'cmd-1', result: 'ok' });
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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });

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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });
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

      expect(parseSent(webWs)).toEqual({ type: 'response', id: 'cmd-1', result });
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
      sendCommand(doInstance, web1, { id: 'dup-id', command: 'send_message', sessionId: 's1' });
      const corr1 = getCorrelationId(cliWs, 0);

      sendCommand(doInstance, web2, { id: 'dup-id', command: 'send_message', sessionId: 's1' });
      const corr2 = getCorrelationId(cliWs, 1);

      expect(corr1).not.toBe(corr2);

      web1.send.mockClear();
      web2.send.mockClear();

      sendCliResponse(doInstance, cliWs, { id: corr1, result: 'result-1' });
      sendCliResponse(doInstance, cliWs, { id: corr2, result: 'result-2' });

      expect(parseSent(web1)).toEqual({ type: 'response', id: 'dup-id', result: 'result-1' });
      expect(parseSent(web2)).toEqual({ type: 'response', id: 'dup-id', result: 'result-2' });
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
        expect(sent).toMatchObject({ type: 'command', command, sessionId: 's1' });
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

      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'eval', sessionId: 's1' });

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

      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'eval', sessionId: 's1' });
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

      expect(parseSent(webWs)).toEqual({ type: 'response', id: 'cmd-1', result });
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
      sendCommand(doInstance, webWs, { id: 'cmd-1', command: 'list_models', sessionId: 's1' });
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
      { label: 'wrong protocol version', input: { sessionId: 's1', data: { protocolVersion: 2 } } },
      {
        label: 'extra data field',
        input: { sessionId: 's1', data: { protocolVersion: 1, extra: true } },
      },
      { label: 'null data', input: { sessionId: 's1', data: null } },
      { label: 'array data', input: { sessionId: 's1', data: [{ protocolVersion: 1 }] } },
      { label: 'primitive data', input: { sessionId: 's1', data: 'protocolVersion=1' } },
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

      expect(parseSent(webWs)).toEqual({ type: 'response', id: 'cmd-1', result });
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
      sendCommand(doInstance, web2, { id: 'cmd-1', command: 'send_message', sessionId: 's1' });

      // Should route to cli-1 (not "Session owner not found")
      const cliWs = mockCtx.sockets.find(s => s._tags.includes('cli'));
      expect(cliWs?.send).toHaveBeenCalled();
      const cliMsgs = allSent(cliWs!);
      const cmdMsg = cliMsgs.find((m: Record<string, unknown>) => m.type === 'command');
      expect(cmdMsg).toMatchObject({ type: 'command', command: 'send_message' });
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
        JSON.stringify({ type: 'event', sessionId: 's1', event: 'test', data: {} })
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
        { id: 's1', status: 'busy', title: 'Fix bug', connectionId: 'cli-1', protocolVersion: '1' },
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
        { id: 'root-1', status: 'busy', title: 'Root session', connectionId: 'cli-1' },
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
        { id: 'root-1', status: 'idle', title: 'Root session', connectionId: 'cli-1' },
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
        { id: 's1', status: 'busy', title: 'On a Mac', connectionId: 'cli-1', platform: 'darwin' },
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
      addCliSocket(mockCtx, 'cli-B', [], { name: 'laptop-B', projectName: 'kilo' });
      addWebSocket(mockCtx);

      const { instances } = doInstance.getConnectedInstances();
      expect(instances).toHaveLength(2);
      expect(instances).toEqual(
        expect.arrayContaining([
          { connectionId: 'cli-A', name: 'laptop-A', projectName: 'kilo', version: '0.1.2' },
          { connectionId: 'cli-B', name: 'laptop-B', projectName: 'kilo' },
        ])
      );
    });

    it('omits the `version` key when the CLI did not report one', () => {
      const { doInstance, mockCtx } = setup();
      addCliSocket(mockCtx, 'cli-1', [], { name: 'laptop-1', projectName: 'kilo' });

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
        { connectionId: 'cli-h', name: 'laptop-h', projectName: 'kilo', version: '1.0.0' },
      ]);
    });

    it('persists `instance` in the WS attachment across heartbeats', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      sendHeartbeat(doInstance, cliWs, [], {
        protocolVersion: '1',
        instance: { name: 'laptop-1', projectName: 'kilo', version: '0.1.0' },
      });

      const att = cliWs.deserializeAttachment() as { instance?: { name: string } };
      expect(att.instance).toEqual({ name: 'laptop-1', projectName: 'kilo', version: '0.1.0' });
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

    it('webSocketError triggers webSocketClose', () => {
      const { doInstance, mockCtx } = setup();
      const cliWs = addCliSocket(mockCtx, 'cli-1');
      const webWs = addWebSocket(mockCtx, 'web-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('s1')]);
      webWs.send.mockClear();

      // Remove CLI so disconnect can clean up
      mockCtx.removeSocket(cliWs);
      doInstance.webSocketError(cliWs as never);

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
  // Session-ready push claim
  // -------------------------------------------------------------------------

  describe('session-ready push claim', () => {
    function setupWithIngestDO() {
      const mockCtx = createMockCtx();
      const ctx = mockCtx.build();
      const claimSessionReadyPush = vi.fn(async () => {});
      const env = {
        SESSION_INGEST_DO: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ claimSessionReadyPush })),
        },
      };
      const doInstance = new UserConnectionDO(ctx as never, env as never);
      return { doInstance, mockCtx, claimSessionReadyPush };
    }

    function addCliSocketForUser(
      mockCtx: ReturnType<typeof createMockCtx>,
      connectionId: string,
      kiloUserId: string
    ): MockWS {
      const attachment = { role: 'cli' as const, connectionId, sessions: [], kiloUserId };
      const ws = createMockWs(['cli'], attachment);
      mockCtx.addSocket(ws);
      return ws;
    }

    it('claims the push the first time a parentless session appears in a heartbeat', () => {
      const { doInstance, mockCtx, claimSessionReadyPush } = setupWithIngestDO();
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_main')]);

      expect(claimSessionReadyPush).toHaveBeenCalledTimes(1);
      expect(claimSessionReadyPush).toHaveBeenCalledWith('usr_1', 'ses_main', 'Test');

      // Subsequent heartbeats for the same session must not re-claim.
      sendHeartbeat(doInstance, cliWs, [makeSession('ses_main')]);
      expect(claimSessionReadyPush).toHaveBeenCalledTimes(1);
    });

    it('never claims for subagent sessions', () => {
      const { doInstance, mockCtx, claimSessionReadyPush } = setupWithIngestDO();
      const cliWs = addCliSocketForUser(mockCtx, 'cli-1', 'usr_1');

      sendHeartbeat(doInstance, cliWs, [
        makeSession('ses_main'),
        makeSession('ses_sub', 'busy', 'Sub', 'ses_main'),
      ]);

      expect(claimSessionReadyPush).toHaveBeenCalledTimes(1);
      expect(claimSessionReadyPush).toHaveBeenCalledWith('usr_1', 'ses_main', 'Test');
    });

    it('does not claim on sockets without a kiloUserId (legacy attachment)', () => {
      const { doInstance, mockCtx, claimSessionReadyPush } = setupWithIngestDO();
      const cliWs = addCliSocket(mockCtx, 'cli-1');

      sendHeartbeat(doInstance, cliWs, [makeSession('ses_main')]);

      expect(claimSessionReadyPush).not.toHaveBeenCalled();
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

      expect(server.deserializeAttachment()).toMatchObject({ role: 'cli', kiloUserId: 'usr_1' });
    });
  });
});
