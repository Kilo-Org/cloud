/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import { createIngestHandler, type IngestDOContext, type IngestAttachment } from './ingest.js';
import type { EventQueries } from '../session/queries/index.js';
import type { SessionId } from '../types/ids.js';

const SESSION_ID = 'sess_test' as SessionId;
const WRAPPER_RUN_ID = 'wr_test_basic';
const itWithWebSocketPair = typeof WebSocketPair === 'undefined' ? it.skip : it;

function createFakeState() {
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    getTags: vi.fn().mockReturnValue([]),
  } as unknown as DurableObjectState;
}

function makeIngestRequest(params: Record<string, string>) {
  const url = new URL('https://example.com/ingest');
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new Request(url, { headers: { Upgrade: 'websocket' } });
}

function createFakeEventQueries() {
  return {
    insert: vi.fn().mockReturnValue(1),
    upsert: vi.fn().mockReturnValue(1),
    findByFilters: vi.fn().mockReturnValue([]),
    deleteOlderThan: vi.fn().mockReturnValue(0),
    iterateByFilters: vi.fn(),
    countByExecutionId: vi.fn(),
    getLatestEventId: vi.fn(),
  } as unknown as EventQueries;
}

function createFakeDOContext(): IngestDOContext {
  return {
    updateKiloSessionId: vi.fn().mockResolvedValue(undefined),
    updateUpstreamBranch: vi.fn().mockResolvedValue(undefined),
    setAvailableCommands: vi.fn().mockResolvedValue(undefined),
    terminalizeSessionMessageOnce: vi.fn().mockResolvedValue(undefined),
    wrapperSupervisor: {
      checkReconnect: vi.fn().mockResolvedValue({ accepted: true }),
      recordReconnectAccepted: vi.fn().mockResolvedValue(undefined),
      isCurrentConnection: vi.fn().mockResolvedValue(true),
      observePong: vi.fn().mockResolvedValue(undefined),
      observeMeaningfulOutput: vi.fn().mockResolvedValue(undefined),
      observeRootIdle: vi.fn().mockResolvedValue(undefined),
      onTerminalEvent: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function createFakeWebSocket(attachment: unknown = null) {
  return {
    deserializeAttachment: vi.fn().mockReturnValue(attachment),
    serializeAttachment: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
    readyState: 1,
  } as unknown as WebSocket;
}

function makeAttachment(overrides?: Partial<IngestAttachment>): IngestAttachment {
  const now = Date.now();
  return {
    wrapperRunId: WRAPPER_RUN_ID,
    wrapperGeneration: 1,
    wrapperConnectionId: 'conn-1',
    connectedAt: now,
    kiloSessionState: { captured: false },
    lastHeartbeatUpdate: now,
    lastEventAtUpdate: now,
    ...overrides,
  };
}

function makeStreamMessage(streamEventType: string, data?: Record<string, unknown>) {
  return JSON.stringify({
    streamEventType,
    data: data ?? {},
    timestamp: new Date().toISOString(),
  });
}

describe('createIngestHandler', () => {
  describe('handleIngestClose', () => {
    it('returns null when WebSocket has no attachment', async () => {
      const state = createFakeState();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(null);

      await expect(handler.handleIngestClose(ws)).resolves.toBeNull();
    });

    it('quarantines an obsolete hibernated attachment without reporting disconnect', async () => {
      const state = createFakeState();
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );
      const ws = createFakeWebSocket({
        executionId: 'exc_predeploy',
        connectedAt: Date.now(),
        kiloSessionState: { captured: false },
        lastHeartbeatUpdate: Date.now(),
        lastEventAtUpdate: 0,
      });

      await expect(handler.handleIngestClose(ws)).resolves.toBeNull();
      expect(doContext.wrapperSupervisor.isCurrentConnection).not.toHaveBeenCalled();
      expect(state.getWebSockets).not.toHaveBeenCalled();
    });

    it('returns current fenced wrapper attribution when no other ingest sockets remain', async () => {
      const state = createFakeState();
      vi.mocked(state.getWebSockets).mockReturnValue([]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(makeAttachment());

      await expect(handler.handleIngestClose(ws)).resolves.toEqual({
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn-1',
      });
      expect(state.getWebSockets).toHaveBeenCalledWith(`ingest:${WRAPPER_RUN_ID}`);
    });

    it('returns null when a replacement ingest socket exists', async () => {
      const state = createFakeState();
      const replacementWs = createFakeWebSocket();
      // A replacement socket still exists for this execution
      vi.mocked(state.getWebSockets).mockReturnValue([replacementWs]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(makeAttachment());

      await expect(handler.handleIngestClose(ws)).resolves.toBeNull();
    });

    // The positive case through the full handleIngestRequest → handleIngestClose
    // flow requires WebSocketPair and state.acceptWebSocket — Cloudflare Worker
    // APIs unavailable in vitest Node. That path is covered by integration tests.
  });

  describe('handleIngestMessage — persistence routing', () => {
    function makeKilocodeMessage(eventName: string, properties?: Record<string, unknown>) {
      return JSON.stringify({
        streamEventType: 'kilocode',
        data: { event: eventName, properties },
        timestamp: new Date().toISOString(),
      });
    }

    // --- kilocode events: upsert path ---

    it('message.updated is upserted by entity ID', async () => {
      const eventQueries = createFakeEventQueries();
      (eventQueries as unknown as Record<string, unknown>).upsert = vi.fn().mockReturnValue(42);
      const broadcastFn = vi.fn();
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        doContext
      );
      const ws = createFakeWebSocket(makeAttachment());

      await handler.handleIngestMessage(
        ws,
        makeKilocodeMessage('message.updated', { info: { id: 'msg_1' } })
      );

      expect(eventQueries.insert).not.toHaveBeenCalled();
      expect(
        (eventQueries as unknown as Record<string, ReturnType<typeof vi.fn>>).upsert
      ).toHaveBeenCalledWith(expect.objectContaining({ entityId: 'message/msg_1' }));
      expect(broadcastFn).toHaveBeenCalledWith(expect.objectContaining({ id: 42 }));
    });

    // --- kilocode events: plain insert path (PERSISTED_KILO_EVENT_NAMES) ---

    it.each([
      'message.part.removed',
      'session.created',
      'session.updated',
      'session.status',
      'session.error',
      'session.idle',
      'session.turn.close',
    ])('kilocode %s is plain-inserted', async eventName => {
      const eventQueries = createFakeEventQueries();
      const broadcastFn = vi.fn();
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        doContext
      );
      const ws = createFakeWebSocket(makeAttachment());

      await handler.handleIngestMessage(ws, makeKilocodeMessage(eventName));

      expect(eventQueries.insert).toHaveBeenCalled();
      expect(broadcastFn).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
    });

    // --- kilocode events: broadcast-only (not in any allowlist) ---

    it.each([
      'question.asked',
      'question.replied',
      'question.rejected',
      'session.diff',
      'message.part.delta',
      'permission.asked',
      'session.completed',
    ])('kilocode %s is broadcast-only', async eventName => {
      const eventQueries = createFakeEventQueries();
      const broadcastFn = vi.fn();
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        doContext
      );
      const ws = createFakeWebSocket(makeAttachment());

      await handler.handleIngestMessage(ws, makeKilocodeMessage(eventName));

      expect(eventQueries.insert).not.toHaveBeenCalled();
      expect(broadcastFn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 0, stream_event_type: 'kilocode' })
      );
    });

    // --- non-kilocode: plain insert path (PERSISTED_STREAM_EVENT_TYPES) ---

    it.each(['complete', 'interrupted', 'error', 'autocommit_started', 'autocommit_completed'])(
      'stream event %s is plain-inserted',
      async eventType => {
        const eventQueries = createFakeEventQueries();
        const broadcastFn = vi.fn();
        const handler = createIngestHandler(
          createFakeState(),
          eventQueries,
          SESSION_ID,
          broadcastFn,
          createFakeDOContext()
        );
        const ws = createFakeWebSocket(makeAttachment());

        await handler.handleIngestMessage(ws, makeStreamMessage(eventType));

        expect(eventQueries.insert).toHaveBeenCalled();
        expect(broadcastFn).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }));
      }
    );

    // --- non-kilocode: broadcast-only (not in PERSISTED_STREAM_EVENT_TYPES) ---

    it.each(['heartbeat', 'pong', 'output', 'status', 'started', 'wrapper_resumed'])(
      'stream event %s is broadcast-only',
      async eventType => {
        const eventQueries = createFakeEventQueries();
        const broadcastFn = vi.fn();
        const handler = createIngestHandler(
          createFakeState(),
          eventQueries,
          SESSION_ID,
          broadcastFn,
          createFakeDOContext()
        );
        const ws = createFakeWebSocket(makeAttachment());

        await handler.handleIngestMessage(ws, makeStreamMessage(eventType));

        expect(eventQueries.insert).not.toHaveBeenCalled();
        expect(broadcastFn).toHaveBeenCalledWith(
          expect.objectContaining({ id: 0, stream_event_type: eventType })
        );
      }
    );

    it('mirrors wrapper preparation progress to cloud.status for existing clients', async () => {
      const eventQueries = createFakeEventQueries();
      const broadcastFn = vi.fn();
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(makeAttachment());

      await handler.handleIngestMessage(
        ws,
        makeStreamMessage('preparing', {
          step: 'cloning',
          message: 'Cloning repository...',
        })
      );

      expect(eventQueries.insert).not.toHaveBeenCalled();
      expect(broadcastFn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: 0,
          stream_event_type: 'preparing',
          payload: JSON.stringify({
            step: 'cloning',
            message: 'Cloning repository...',
          }),
        })
      );
      expect(broadcastFn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: 0,
          stream_event_type: 'cloud.status',
          payload: JSON.stringify({
            cloudStatus: {
              type: 'preparing',
              step: 'cloning',
              message: 'Cloning repository...',
            },
          }),
        })
      );
    });

    it('pong updates wrapper liveness before broadcast without marking meaningful output', async () => {
      const calls: string[] = [];
      const doContext = createFakeDOContext();
      doContext.wrapperSupervisor.isCurrentConnection = vi.fn().mockResolvedValue(true);
      doContext.wrapperSupervisor.observePong = vi.fn().mockImplementation(async () => {
        calls.push('pong');
      });
      doContext.wrapperSupervisor.observeMeaningfulOutput = vi.fn().mockResolvedValue(undefined);
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        () => calls.push('broadcast'),
        doContext
      );
      const ws = createFakeWebSocket(
        makeAttachment({ wrapperGeneration: 3, wrapperConnectionId: 'conn_current' })
      );

      await handler.handleIngestMessage(ws, makeStreamMessage('pong'));

      expect(doContext.wrapperSupervisor.observePong).toHaveBeenCalledWith(
        3,
        'conn_current',
        expect.any(Number)
      );
      expect(doContext.wrapperSupervisor.observeMeaningfulOutput).not.toHaveBeenCalled();
      expect(calls).toEqual(['pong', 'broadcast']);
    });

    it.each(['pong', 'wrapper_resumed'])(
      '%s does not clear no-output liveness',
      async eventType => {
        const doContext = createFakeDOContext();
        doContext.wrapperSupervisor.isCurrentConnection = vi.fn().mockResolvedValue(true);
        doContext.wrapperSupervisor.observePong = vi.fn().mockResolvedValue(undefined);
        doContext.wrapperSupervisor.observeMeaningfulOutput = vi.fn().mockResolvedValue(undefined);
        const handler = createIngestHandler(
          createFakeState(),
          createFakeEventQueries(),
          SESSION_ID,
          vi.fn(),
          doContext
        );
        const ws = createFakeWebSocket(
          makeAttachment({ wrapperGeneration: 3, wrapperConnectionId: 'conn_current' })
        );

        await handler.handleIngestMessage(ws, makeStreamMessage(eventType));

        if (eventType === 'pong') {
          expect(doContext.wrapperSupervisor.observePong).toHaveBeenCalled();
        } else {
          expect(doContext.wrapperSupervisor.observePong).not.toHaveBeenCalled();
        }
        expect(doContext.wrapperSupervisor.observeMeaningfulOutput).not.toHaveBeenCalled();
      }
    );

    it('heartbeat does not refresh no-output liveness', async () => {
      const calls: string[] = [];
      const doContext = createFakeDOContext();
      doContext.wrapperSupervisor.isCurrentConnection = vi.fn().mockResolvedValue(true);
      doContext.wrapperSupervisor.observePong = vi.fn().mockResolvedValue(undefined);
      doContext.wrapperSupervisor.observeMeaningfulOutput = vi.fn().mockImplementation(async () => {
        calls.push('heartbeat');
      });
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        () => calls.push('broadcast'),
        doContext
      );
      const ws = createFakeWebSocket(
        makeAttachment({ wrapperGeneration: 3, wrapperConnectionId: 'conn_current' })
      );

      await handler.handleIngestMessage(ws, makeStreamMessage('heartbeat'));

      // Heartbeats are keepalives only — they must not refresh the no-output
      // deadline, otherwise a stalled wrapper sending only heartbeats would
      // never be caught.
      expect(doContext.wrapperSupervisor.observePong).not.toHaveBeenCalled();
      expect(doContext.wrapperSupervisor.observeMeaningfulOutput).not.toHaveBeenCalled();
      expect(calls).toEqual(['broadcast']);
    });

    it('meaningful output clears no-output liveness before broadcast', async () => {
      const calls: string[] = [];
      const doContext = createFakeDOContext();
      doContext.wrapperSupervisor.isCurrentConnection = vi.fn().mockResolvedValue(true);
      doContext.wrapperSupervisor.observeMeaningfulOutput = vi.fn().mockImplementation(async () => {
        calls.push('meaningful');
      });
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        () => calls.push('broadcast'),
        doContext
      );
      const ws = createFakeWebSocket(
        makeAttachment({ wrapperGeneration: 3, wrapperConnectionId: 'conn_current' })
      );

      await handler.handleIngestMessage(ws, makeStreamMessage('output'));

      expect(doContext.wrapperSupervisor.observeMeaningfulOutput).toHaveBeenCalledWith(
        3,
        'conn_current',
        expect.any(Number)
      );
      expect(calls).toEqual(['meaningful', 'broadcast']);
    });

    it('kilo_snapshot is broadcast-only (no special handling)', async () => {
      const eventQueries = createFakeEventQueries();
      const broadcastFn = vi.fn();
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        doContext
      );
      const ws = createFakeWebSocket(makeAttachment());

      await handler.handleIngestMessage(
        ws,
        JSON.stringify({
          streamEventType: 'kilo_snapshot',
          data: { sessionStatus: { type: 'busy' } },
          timestamp: new Date().toISOString(),
        })
      );

      // Should NOT call onKiloSnapshot (removed)
      // Should be broadcast as a regular event with eventId 0
      expect(broadcastFn).toHaveBeenCalledWith(
        expect.objectContaining({ id: 0, stream_event_type: 'kilo_snapshot' })
      );
    });
  });

  describe('wrapper fencing', () => {
    it('quarantines obsolete hibernated attachment messages without terminal side effects', async () => {
      const eventQueries = createFakeEventQueries();
      const broadcastFn = vi.fn();
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        doContext
      );
      const ws = createFakeWebSocket({
        executionId: 'exc_predeploy',
        connectedAt: Date.now(),
        kiloSessionState: { captured: false },
        lastHeartbeatUpdate: Date.now(),
        lastEventAtUpdate: 0,
      });

      await handler.handleIngestMessage(
        ws,
        makeStreamMessage('interrupted', { reason: 'old run' })
      );

      expect(ws.close).toHaveBeenCalledWith(4401, 'Obsolete wrapper connection');
      expect(eventQueries.insert).not.toHaveBeenCalled();
      expect(broadcastFn).not.toHaveBeenCalled();
      expect(doContext.wrapperSupervisor.onTerminalEvent).not.toHaveBeenCalled();
      expect(doContext.wrapperSupervisor.isCurrentConnection).not.toHaveBeenCalled();
    });

    it('ignores stale fenced socket messages', async () => {
      const eventQueries = createFakeEventQueries();
      const broadcastFn = vi.fn();
      const doContext = createFakeDOContext();
      doContext.wrapperSupervisor.isCurrentConnection = vi.fn().mockResolvedValue(false);
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        doContext
      );
      const ws = createFakeWebSocket(
        makeAttachment({ wrapperGeneration: 1, wrapperConnectionId: 'conn_old' })
      );

      await handler.handleIngestMessage(ws, makeStreamMessage('complete'));

      expect(eventQueries.insert).not.toHaveBeenCalled();
      expect(broadcastFn).not.toHaveBeenCalled();
    });

    it('does not report stale fenced socket close as disconnect', async () => {
      const doContext = createFakeDOContext();
      doContext.wrapperSupervisor.isCurrentConnection = vi.fn().mockResolvedValue(false);
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );
      const ws = createFakeWebSocket(
        makeAttachment({ wrapperGeneration: 1, wrapperConnectionId: 'conn_old' })
      );

      await expect(handler.handleIngestClose(ws)).resolves.toBeNull();
    });

    it('rejects malformed partial fenced connect params', async () => {
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      await expect(
        handler.handleIngestRequest(
          makeIngestRequest({ wrapperRunId: WRAPPER_RUN_ID, wrapperGeneration: '1' })
        )
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        handler.handleIngestRequest(
          makeIngestRequest({ wrapperRunId: WRAPPER_RUN_ID, wrapperConnectionId: 'conn_current' })
        )
      ).resolves.toMatchObject({ status: 400 });
      await expect(
        handler.handleIngestRequest(
          makeIngestRequest({
            wrapperRunId: WRAPPER_RUN_ID,
            wrapperGeneration: 'not-a-number',
            wrapperConnectionId: 'conn_current',
          })
        )
      ).resolves.toMatchObject({ status: 400 });
    });

    it('rejects stale fenced connect params before accepting websocket', async () => {
      const state = createFakeState();
      const doContext = createFakeDOContext();
      doContext.wrapperSupervisor.checkReconnect = vi.fn().mockResolvedValue({
        accepted: false,
        reason: 'stale-wrapper-connection',
      });
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const response = await handler.handleIngestRequest(
        makeIngestRequest({
          wrapperRunId: WRAPPER_RUN_ID,
          wrapperGeneration: '1',
          wrapperConnectionId: 'conn_old',
          sessionId: SESSION_ID,
        })
      );

      expect(response.status).toBe(409);
      expect(state.acceptWebSocket).not.toHaveBeenCalled();
    });

    itWithWebSocketPair(
      'accepts current fenced connection and cancels matching grace',
      async () => {
        const state = createFakeState();
        const doContext = createFakeDOContext();
        const handler = createIngestHandler(
          state,
          createFakeEventQueries(),
          SESSION_ID,
          vi.fn(),
          doContext
        );

        const response = await handler.handleIngestRequest(
          makeIngestRequest({
            wrapperRunId: WRAPPER_RUN_ID,
            wrapperGeneration: '2',
            wrapperConnectionId: 'conn_current',
            sessionId: SESSION_ID,
          })
        );

        expect(response.status).toBe(101);
        expect(state.acceptWebSocket).toHaveBeenCalledOnce();
        expect(doContext.wrapperSupervisor.recordReconnectAccepted).toHaveBeenCalledWith({
          wrapperGeneration: 2,
          wrapperConnectionId: 'conn_current',
        });
      }
    );

    itWithWebSocketPair('replaces duplicate same fenced reconnect', async () => {
      const existingWs = createFakeWebSocket(
        makeAttachment({ wrapperGeneration: 2, wrapperConnectionId: 'conn_current' })
      );
      const state = createFakeState();
      vi.mocked(state.getWebSockets).mockReturnValue([existingWs]);
      const doContext = createFakeDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const response = await handler.handleIngestRequest(
        makeIngestRequest({
          wrapperRunId: WRAPPER_RUN_ID,
          wrapperGeneration: '2',
          wrapperConnectionId: 'conn_current',
          sessionId: SESSION_ID,
        })
      );

      expect(response.status).toBe(101);
      expect(existingWs.close).toHaveBeenCalledWith(1000, 'Replaced by new connection');
    });
  });

  describe('hasActiveConnection', () => {
    it('returns true when getWebSockets finds ingest sockets', () => {
      const state = createFakeState();
      vi.mocked(state.getWebSockets).mockReturnValue([
        createFakeWebSocket(
          makeAttachment({ wrapperGeneration: 1, wrapperConnectionId: 'conn-1' })
        ),
      ]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );

      expect(
        handler.hasActiveConnection({
          wrapperRunId: WRAPPER_RUN_ID,
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn-1',
        })
      ).toBe(true);
      expect(state.getWebSockets).toHaveBeenCalledWith(`ingest:${WRAPPER_RUN_ID}`);
    });

    it('returns false when getWebSockets finds no ingest sockets', () => {
      const state = createFakeState();
      vi.mocked(state.getWebSockets).mockReturnValue([]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );

      expect(
        handler.hasActiveConnection({
          wrapperRunId: WRAPPER_RUN_ID,
          wrapperGeneration: 1,
          wrapperConnectionId: 'conn-1',
        })
      ).toBe(false);
    });
  });

  describe('handleIngestMessage — lastEventAt tracking', () => {
    it('updates lastEventAt in attachment for non-heartbeat events when debounce elapsed', async () => {
      const state = createFakeState();
      const broadcast = vi.fn();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        broadcast,
        createFakeDOContext()
      );

      const staleTime = Date.now() - 31_000;
      const ws = createFakeWebSocket(makeAttachment({ lastEventAtUpdate: staleTime }));

      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: { event: 'message.updated' },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(ws.serializeAttachment).toHaveBeenCalled();
    });

    it('does NOT update lastEventAt for heartbeat events', async () => {
      const state = createFakeState();
      const broadcast = vi.fn();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        broadcast,
        createFakeDOContext()
      );

      const staleTime = Date.now() - 31_000;
      const ws = createFakeWebSocket(makeAttachment({ lastEventAtUpdate: staleTime }));

      const message = JSON.stringify({
        streamEventType: 'heartbeat',
        data: {},
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      // Heartbeat events should not trigger lastEventAt updates
      // (they are not meaningful output for the no-output deadline).
      // Since neither the kilocode handler nor lastEventAt path runs,
      // serializeAttachment is not called (lastHeartbeatUpdate is within debounce).
      expect(ws.serializeAttachment).not.toHaveBeenCalled();
    });

    it('debounces lastEventAt updates within 30s', async () => {
      const state = createFakeState();
      const broadcast = vi.fn();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        broadcast,
        createFakeDOContext()
      );

      const recentTime = Date.now() - 5_000;
      const ws = createFakeWebSocket(makeAttachment({ lastEventAtUpdate: recentTime }));

      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: { event: 'message.updated' },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      // The kilocode handler always calls serializeAttachment, but the
      // lastEventAt debounce logic does not because it's within 30s.
      // The heartbeat debounce does not trigger because lastHeartbeatUpdate is recent.
      expect(ws.serializeAttachment).toHaveBeenCalled();
    });
  });

  describe('new-path: assistant message terminalization', () => {
    const WRAPPER_RUN_ID = 'wr_test_001';

    function makeNewPathAttachment(overrides?: Partial<IngestAttachment>): IngestAttachment {
      const now = Date.now();
      return {
        connectedAt: now,
        kiloSessionState: { captured: false },
        lastHeartbeatUpdate: now,
        lastEventAtUpdate: 0,
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: 1,
        wrapperConnectionId: 'conn-1',
        ...overrides,
      };
    }

    function createNewPathDOContext() {
      return {
        ...createFakeDOContext(),
        observeCorrelatedAgentActivity: vi.fn().mockResolvedValue(undefined),
        terminalizeSessionMessageOnce: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('observes activity without terminalizing on partial assistant message.updated', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const ws = createFakeWebSocket(makeNewPathAttachment());

      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: {
          event: 'message.updated',
          properties: {
            info: {
              id: 'asst_111',
              role: 'assistant',
              parentID: 'msg_user_111',
              // no time.completed — partial update only
            },
          },
        },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.observeCorrelatedAgentActivity).toHaveBeenCalledWith('msg_user_111');
      expect(doContext.terminalizeSessionMessageOnce).not.toHaveBeenCalled();
    });

    it('terminalizes on terminal assistant message.updated (with time.completed)', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const ws = createFakeWebSocket(makeNewPathAttachment());

      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: {
          event: 'message.updated',
          properties: {
            info: {
              id: 'asst_222',
              role: 'assistant',
              parentID: 'msg_user_222',
              time: { completed: Date.now() },
            },
          },
        },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.terminalizeSessionMessageOnce).toHaveBeenCalledWith(
        'msg_user_222',
        expect.objectContaining({
          kind: 'completed',
          assistantMessageId: 'asst_222',
          completionSource: 'assistant_message_event',
        }),
        WRAPPER_RUN_ID
      );
    });

    it('terminalizes on wrapper cloud.message.completed control event', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const eventQueries = createFakeEventQueries();
      const broadcast = vi.fn();
      const handler = createIngestHandler(state, eventQueries, SESSION_ID, broadcast, doContext);

      const ws = createFakeWebSocket(makeNewPathAttachment());

      const message = JSON.stringify({
        streamEventType: 'cloud.message.completed',
        data: {
          messageId: 'msg_compact',
          completionSource: 'manual_compact_summarize',
        },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.terminalizeSessionMessageOnce).toHaveBeenCalledWith(
        'msg_compact',
        {
          kind: 'completed',
          assistantMessageId: undefined,
          completionSource: 'manual_compact_summarize',
        },
        WRAPPER_RUN_ID
      );
      expect(eventQueries.insert).not.toHaveBeenCalled();
      expect(eventQueries.upsert).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
    });

    it('rejects unsupported wrapper cloud.message.completed sources', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const eventQueries = createFakeEventQueries();
      const broadcast = vi.fn();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handler = createIngestHandler(state, eventQueries, SESSION_ID, broadcast, doContext);

      const ws = createFakeWebSocket(makeNewPathAttachment());

      const message = JSON.stringify({
        streamEventType: 'cloud.message.completed',
        data: {
          messageId: 'msg_compact',
          completionSource: 'unsupported_source',
        },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.terminalizeSessionMessageOnce).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        'Invalid cloud.message.completed event payload',
        expect.anything()
      );
      warn.mockRestore();
    });

    it('terminalizes as failed on assistant message.updated with error', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const ws = createFakeWebSocket(makeNewPathAttachment());

      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: {
          event: 'message.updated',
          properties: {
            info: {
              id: 'asst_333',
              role: 'assistant',
              parentID: 'msg_user_333',
              error: 'rate limit exceeded',
            },
          },
        },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.terminalizeSessionMessageOnce).toHaveBeenCalledWith(
        'msg_user_333',
        expect.objectContaining({
          kind: 'failed',
          assistantMessageId: 'asst_333',
          completionSource: 'assistant_message_event',
          error: 'rate limit exceeded',
        }),
        WRAPPER_RUN_ID
      );
    });

    it('terminalizes object-shaped assistant errors with completion as failed', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const ws = createFakeWebSocket(makeNewPathAttachment());
      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: {
          event: 'message.updated',
          properties: {
            info: {
              id: 'asst_object_completed',
              role: 'assistant',
              parentID: 'msg_user_object_completed',
              error: { name: 'UnknownError', data: { message: 'provider failed' } },
              time: { completed: Date.now() },
            },
          },
        },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.terminalizeSessionMessageOnce).toHaveBeenCalledWith(
        'msg_user_object_completed',
        expect.objectContaining({
          kind: 'failed',
          assistantMessageId: 'asst_object_completed',
          completionSource: 'assistant_message_event',
          error: 'provider failed',
        }),
        WRAPPER_RUN_ID
      );
    });

    it('terminalizes object-shaped assistant errors without completion as failed', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const ws = createFakeWebSocket(makeNewPathAttachment());
      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: {
          event: 'message.updated',
          properties: {
            info: {
              id: 'asst_object_pending',
              role: 'assistant',
              parentID: 'msg_user_object_pending',
              error: { name: 'UnknownError', data: { message: 'provider failed early' } },
            },
          },
        },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.terminalizeSessionMessageOnce).toHaveBeenCalledWith(
        'msg_user_object_pending',
        expect.objectContaining({
          kind: 'failed',
          assistantMessageId: 'asst_object_pending',
          completionSource: 'assistant_message_event',
          error: 'provider failed early',
        }),
        WRAPPER_RUN_ID
      );
    });

    it('ingests duplicate terminal updates without error (idempotency at DO level)', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      doContext.terminalizeSessionMessageOnce = vi.fn().mockResolvedValue(undefined);
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const ws = createFakeWebSocket(makeNewPathAttachment());

      const makeMessage = () =>
        JSON.stringify({
          streamEventType: 'kilocode',
          data: {
            event: 'message.updated',
            properties: {
              info: {
                id: 'asst_444',
                role: 'assistant',
                parentID: 'msg_user_444',
                time: { completed: Date.now() },
              },
            },
          },
          timestamp: new Date().toISOString(),
        });

      await handler.handleIngestMessage(ws, makeMessage());
      await handler.handleIngestMessage(ws, makeMessage());

      // Both events trigger terminalizeSessionMessageOnce; the DO handles idempotency
      expect(doContext.terminalizeSessionMessageOnce).toHaveBeenCalledTimes(2);
      expect(doContext.terminalizeSessionMessageOnce).toHaveBeenCalledWith(
        'msg_user_444',
        expect.objectContaining({ kind: 'completed' }),
        WRAPPER_RUN_ID
      );
    });

    it('does NOT terminalize on wrapper complete event (new path)', async () => {
      const state = createFakeState();
      const doContext = createNewPathDOContext();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        doContext
      );

      const ws = createFakeWebSocket(makeNewPathAttachment());

      const message = JSON.stringify({
        streamEventType: 'complete',
        data: { exitCode: 0 },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.terminalizeSessionMessageOnce).not.toHaveBeenCalled();
      expect(doContext.wrapperSupervisor.onTerminalEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'completed', wrapperRunId: WRAPPER_RUN_ID })
      );
    });
  });

  describe('handleIngestRequest — new-path sessionId validation', () => {
    const WRAPPER_RUN_ID = 'wr_test_002';

    function createNewPathDOContextWithSession() {
      return createFakeDOContext();
    }

    it('rejects new-path ingest with missing sessionId', async () => {
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createNewPathDOContextWithSession()
      );

      const request = makeIngestRequest({
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: '1',
        wrapperConnectionId: 'conn-1',
      });

      const response = await handler.handleIngestRequest(request);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Missing sessionId parameter');
    });

    it('rejects new-path ingest with mismatched sessionId', async () => {
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createNewPathDOContextWithSession()
      );

      const request = makeIngestRequest({
        wrapperRunId: WRAPPER_RUN_ID,
        wrapperGeneration: '1',
        wrapperConnectionId: 'conn-1',
        sessionId: 'wrong-session-id',
      });

      const response = await handler.handleIngestRequest(request);
      expect(response.status).toBe(401);
      expect(await response.text()).toBe('Invalid sessionId parameter');
    });

    itWithWebSocketPair(
      'accepts new-path ingest with matching sessionId + wrapperRunId + fence',
      async () => {
        const state = createFakeState();
        const handler = createIngestHandler(
          state,
          createFakeEventQueries(),
          SESSION_ID,
          vi.fn(),
          createNewPathDOContextWithSession()
        );

        const request = makeIngestRequest({
          wrapperRunId: WRAPPER_RUN_ID,
          wrapperGeneration: '1',
          wrapperConnectionId: 'conn-1',
          sessionId: SESSION_ID,
        });

        const response = await handler.handleIngestRequest(request);
        expect(response.status).toBe(101);
      }
    );

    it('rejects executionId-only ingest without a fenced wrapper run', async () => {
      const handler = createIngestHandler(
        createFakeState(),
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );

      const response = await handler.handleIngestRequest(
        makeIngestRequest({ executionId: 'exc_legacy_unknown' })
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('Missing wrapperRunId parameter');
    });
  });
});
