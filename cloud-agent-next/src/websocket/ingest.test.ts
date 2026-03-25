/* eslint-disable @typescript-eslint/unbound-method */
import { describe, expect, it, vi } from 'vitest';
import { createIngestHandler, type IngestDOContext, type IngestAttachment } from './ingest.js';
import type { EventQueries } from '../session/queries/index.js';
import type { SessionId, ExecutionId } from '../types/ids.js';

const SESSION_ID = 'sess_test' as SessionId;
const EXECUTION_ID = 'exc_test' as ExecutionId;

function createFakeState() {
  return {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    getTags: vi.fn().mockReturnValue([]),
  } as unknown as DurableObjectState;
}

function createFakeEventQueries() {
  return {
    insert: vi.fn().mockReturnValue(1),
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
    clearActiveExecution: vi.fn().mockResolvedValue(undefined),
    getActiveExecutionId: vi.fn().mockResolvedValue(null),
    getExecution: vi.fn().mockResolvedValue(null),
    transitionToRunning: vi.fn().mockResolvedValue(true),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
    updateLastEventAt: vi.fn().mockResolvedValue(undefined),
    updateExecutionStatus: vi.fn().mockResolvedValue(undefined),
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
    executionId: EXECUTION_ID,
    connectedAt: now,
    kiloSessionState: { captured: false },
    lastHeartbeatUpdate: now,
    lastEventAtUpdate: now,
    ...overrides,
  };
}

describe('createIngestHandler', () => {
  describe('handleIngestClose', () => {
    it('returns null when WebSocket has no attachment', () => {
      const state = createFakeState();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(null);

      expect(handler.handleIngestClose(ws)).toBeNull();
    });

    it('returns executionId when no other ingest sockets remain', () => {
      const state = createFakeState();
      // No remaining sockets for this execution
      vi.mocked(state.getWebSockets).mockReturnValue([]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );
      const ws = createFakeWebSocket(makeAttachment());

      expect(handler.handleIngestClose(ws)).toBe(EXECUTION_ID);
      expect(state.getWebSockets).toHaveBeenCalledWith(`ingest:${EXECUTION_ID}`);
    });

    it('returns null when a replacement ingest socket exists', () => {
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

      expect(handler.handleIngestClose(ws)).toBeNull();
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

    function makeStreamMessage(streamEventType: string, data?: Record<string, unknown>) {
      return JSON.stringify({
        streamEventType,
        data: data ?? {},
        timestamp: new Date().toISOString(),
      });
    }

    // --- kilocode events: upsert path ---

    it('message.updated is upserted by entity ID', async () => {
      const eventQueries = createFakeEventQueries();
      (eventQueries as unknown as Record<string, unknown>).upsert = vi.fn().mockReturnValue(42);
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
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        createFakeDOContext()
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
      const handler = createIngestHandler(
        createFakeState(),
        eventQueries,
        SESSION_ID,
        broadcastFn,
        createFakeDOContext()
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

  describe('hasActiveConnection', () => {
    it('returns true when getWebSockets finds ingest sockets', () => {
      const state = createFakeState();
      vi.mocked(state.getWebSockets).mockReturnValue([createFakeWebSocket()]);

      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        vi.fn(),
        createFakeDOContext()
      );

      expect(handler.hasActiveConnection(EXECUTION_ID)).toBe(true);
      expect(state.getWebSockets).toHaveBeenCalledWith(`ingest:${EXECUTION_ID}`);
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

      expect(handler.hasActiveConnection(EXECUTION_ID)).toBe(false);
    });
  });

  describe('handleIngestMessage — lastEventAt tracking', () => {
    it('calls updateLastEventAt for non-heartbeat events when debounce elapsed', async () => {
      const state = createFakeState();
      const doContext = createFakeDOContext();
      const broadcast = vi.fn();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        broadcast,
        doContext
      );

      const staleTime = Date.now() - 31_000; // 31s ago — past HEARTBEAT_DEBOUNCE_MS
      const ws = createFakeWebSocket(makeAttachment({ lastEventAtUpdate: staleTime }));

      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: { event: 'message.updated' },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.updateLastEventAt).toHaveBeenCalledWith(EXECUTION_ID, expect.any(Number));
    });

    it('does NOT call updateLastEventAt for heartbeat events', async () => {
      const state = createFakeState();
      const doContext = createFakeDOContext();
      const broadcast = vi.fn();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        broadcast,
        doContext
      );

      const staleTime = Date.now() - 31_000;
      const ws = createFakeWebSocket(makeAttachment({ lastEventAtUpdate: staleTime }));

      const message = JSON.stringify({
        streamEventType: 'heartbeat',
        data: { executionId: EXECUTION_ID },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.updateLastEventAt).not.toHaveBeenCalled();
    });

    it('debounces updateLastEventAt calls within 30s', async () => {
      const state = createFakeState();
      const doContext = createFakeDOContext();
      const broadcast = vi.fn();
      const handler = createIngestHandler(
        state,
        createFakeEventQueries(),
        SESSION_ID,
        broadcast,
        doContext
      );

      // Recent lastEventAtUpdate — within debounce window
      const recentTime = Date.now() - 5_000; // 5s ago — within HEARTBEAT_DEBOUNCE_MS
      const ws = createFakeWebSocket(makeAttachment({ lastEventAtUpdate: recentTime }));

      const message = JSON.stringify({
        streamEventType: 'kilocode',
        data: { event: 'message.updated' },
        timestamp: new Date().toISOString(),
      });

      await handler.handleIngestMessage(ws, message);

      expect(doContext.updateLastEventAt).not.toHaveBeenCalled();
    });
  });
});
