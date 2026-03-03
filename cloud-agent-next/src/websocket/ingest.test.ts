import { describe, expect, it, vi } from 'vitest';
import { createIngestHandler, type IngestDOContext, type IngestAttachment } from './ingest.js';
import type { EventQueries } from '../session/queries/index.js';
import type { SessionId, ExecutionId } from '../types/ids.js';

const SESSION_ID = 'sess_test' as SessionId;

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
    getExecution: vi.fn().mockResolvedValue(null),
    transitionToRunning: vi.fn().mockResolvedValue(true),
    updateHeartbeat: vi.fn().mockResolvedValue(undefined),
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

function createHandler() {
  return createIngestHandler(
    createFakeState(),
    createFakeEventQueries(),
    SESSION_ID,
    vi.fn(),
    createFakeDOContext()
  );
}

describe('createIngestHandler', () => {
  describe('handleIngestClose', () => {
    it('returns null when WebSocket has no attachment', () => {
      const handler = createHandler();
      const ws = createFakeWebSocket(null);

      const result = handler.handleIngestClose(ws);

      expect(result).toBeNull();
    });

    it('returns null when WebSocket is not the active connection', () => {
      const handler = createHandler();
      const attachment: IngestAttachment = {
        executionId: 'exc_test' as ExecutionId,
        connectedAt: Date.now(),
        kiloSessionState: { captured: false },
        lastHeartbeatUpdate: Date.now(),
      };
      const ws = createFakeWebSocket(attachment);

      // This WS was never registered via handleIngestRequest,
      // so it won't be in the internal activeConnections map.
      const result = handler.handleIngestClose(ws);

      expect(result).toBeNull();
    });

    // The positive case (returns executionId when the WS is the active connection)
    // requires going through handleIngestRequest, which uses WebSocketPair and
    // state.acceptWebSocket — Cloudflare Worker APIs unavailable in vitest Node.
    // That path is covered by integration tests in test/.
  });
});
