/**
 * Unit tests for WrapperState class.
 *
 * Tests state transitions, invariants, and edge cases for the wrapper's
 * centralized state management.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WrapperState, type JobContext } from '../../../wrapper/src/state.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const createJobContext = (overrides: Partial<JobContext> = {}): JobContext => ({
  executionId: 'exc_test-123',
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WrapperState', () => {
  let state: WrapperState;

  beforeEach(() => {
    state = new WrapperState();
  });

  // -------------------------------------------------------------------------
  // Initial State
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);
    });

    it('has no job context', () => {
      expect(state.hasJob).toBe(false);
      expect(state.currentJob).toBeNull();
    });

    it('is not active', () => {
      expect(state.isActive).toBe(false);
    });

    it('is not connected', () => {
      expect(state.isConnected).toBe(false);
    });

    it('has no last error', () => {
      expect(state.getLastError()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Job Lifecycle
  // -------------------------------------------------------------------------

  describe('job lifecycle', () => {
    describe('startJob', () => {
      it('stores job context', () => {
        const context = createJobContext();
        state.startJob(context);

        expect(state.hasJob).toBe(true);
        expect(state.currentJob).toEqual(context);
      });

      it('clears previous error on start', () => {
        state.setLastError({
          code: 'TEST_ERROR',
          message: 'previous error',
          timestamp: Date.now(),
        });

        state.startJob(createJobContext());

        expect(state.getLastError()).toBeNull();
      });

      it('is idempotent for same executionId', () => {
        const context = createJobContext({ executionId: 'exc_same' });
        state.startJob(context);

        state.startJob(context);

        expect(state.currentJob).toEqual(context);
      });

      it('allows starting new job when idle (no inflight)', () => {
        state.startJob(createJobContext({ executionId: 'exc_first' }));
        state.clearJob();

        // Should be able to start a new job
        expect(() => {
          state.startJob(createJobContext({ executionId: 'exc_second' }));
        }).not.toThrow();
      });

      it('throws when starting different job while active', () => {
        state.startJob(createJobContext({ executionId: 'exc_first' }));
        state.setActive(true);

        expect(() => {
          state.startJob(createJobContext({ executionId: 'exc_second' }));
        }).toThrow(/Cannot start new job while active/);
      });

      it('allows replacing job when idle but same job active', () => {
        state.startJob(createJobContext({ executionId: 'exc_first' }));
        // No inflight, so we can replace

        state.clearJob();
        state.startJob(createJobContext({ executionId: 'exc_second' }));

        expect(state.currentJob?.executionId).toBe('exc_second');
      });
    });

    describe('clearJob', () => {
      it('clears job context', () => {
        state.startJob(createJobContext());
        state.clearJob();

        expect(state.hasJob).toBe(false);
        expect(state.currentJob).toBeNull();
      });

      it('clears active state', () => {
        state.startJob(createJobContext());
        state.setActive(true);
        state.clearJob();
        expect(state.isActive).toBe(false);
        expect(state.isIdle).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // setActive
  // -------------------------------------------------------------------------

  describe('setActive', () => {
    it('transitions state to active', () => {
      expect(state.isIdle).toBe(true);
      state.setActive(true);
      expect(state.isActive).toBe(true);
      expect(state.isIdle).toBe(false);
    });

    it('transitions state back to idle', () => {
      state.setActive(true);
      state.setActive(false);
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);
    });

    it('updates activity timestamp when activating', () => {
      const before = Date.now();
      state.setActive(true);
      const after = Date.now();
      const idleMs = state.getIdleMs(after);
      expect(idleMs).toBeLessThanOrEqual(after - before + 1);
    });

    it('is idempotent for same value', () => {
      state.setActive(true);
      state.setActive(true);
      expect(state.isActive).toBe(true);

      state.setActive(false);
      state.setActive(false);
      expect(state.isIdle).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Activity Tracking
  // -------------------------------------------------------------------------

  describe('activity tracking', () => {
    it('updateActivity updates timestamp', () => {
      const before = Date.now();
      state.updateActivity();
      const after = Date.now();

      const idleMs = state.getIdleMs(after);
      expect(idleMs).toBeLessThanOrEqual(after - before + 1);
    });

    it('getIdleMs returns time since last activity', async () => {
      state.updateActivity();
      const activityTime = Date.now();

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 50));

      const now = Date.now();
      const idleMs = state.getIdleMs(now);

      // Should be at least 50ms but not much more
      expect(idleMs).toBeGreaterThanOrEqual(now - activityTime - 5);
      expect(idleMs).toBeLessThan(200);
    });
  });

  // -------------------------------------------------------------------------
  // Error Tracking
  // -------------------------------------------------------------------------

  describe('error tracking', () => {
    it('setLastError stores error', () => {
      const error = {
        code: 'TEST_ERROR',
        message: 'Something went wrong',
        timestamp: Date.now(),
      };

      state.setLastError(error);

      expect(state.getLastError()).toEqual(error);
    });

    it('setLastError with messageId', () => {
      const error = {
        code: 'INFLIGHT_TIMEOUT',
        messageId: 'msg_123',
        message: 'Timeout',
        timestamp: Date.now(),
      };

      state.setLastError(error);

      expect(state.getLastError()).toEqual(error);
    });

    it('clearLastError removes error', () => {
      state.setLastError({
        code: 'TEST_ERROR',
        message: 'Error',
        timestamp: Date.now(),
      });

      state.clearLastError();

      expect(state.getLastError()).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Connection Management
  // -------------------------------------------------------------------------

  describe('connection management', () => {
    it('isConnected returns false with no WebSocket', () => {
      expect(state.isConnected).toBe(false);
    });

    it('setConnections stores WebSocket and AbortController', () => {
      const mockWs = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
      const mockAbort = new AbortController();

      state.setConnections(mockWs, mockAbort);

      expect(state.ingestWs).toBe(mockWs);
      expect(state.sseAbortController).toBe(mockAbort);
    });

    it('isConnected returns true when WebSocket is OPEN', () => {
      const mockWs = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
      state.setConnections(mockWs, new AbortController());

      expect(state.isConnected).toBe(true);
    });

    it('isConnected returns false when WebSocket is not OPEN', () => {
      const mockWs = { readyState: WebSocket.CLOSED, close: vi.fn() } as unknown as WebSocket;
      state.setConnections(mockWs, new AbortController());

      expect(state.isConnected).toBe(false);
    });

    it('clearConnectionRefs nulls references without closing or aborting', () => {
      const mockClose = vi.fn();
      const mockWs = { readyState: WebSocket.OPEN, close: mockClose } as unknown as WebSocket;
      const mockAbort = new AbortController();
      const abortSpy = vi.spyOn(mockAbort, 'abort');

      state.setConnections(mockWs, mockAbort);
      state.clearConnectionRefs();

      // Refs are nulled
      expect(state.ingestWs).toBeNull();
      expect(state.sseAbortController).toBeNull();

      // clearConnectionRefs is purely passive — close/abort owned by connection.ts
      expect(mockClose).not.toHaveBeenCalled();
      expect(abortSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Send to Ingest
  // -------------------------------------------------------------------------

  describe('sendToIngest', () => {
    it('does nothing when no send function set', () => {
      const event: IngestEvent = {
        streamEventType: 'status',
        data: { message: 'test' },
        timestamp: new Date().toISOString(),
      };

      // Should not throw
      expect(() => state.sendToIngest(event)).not.toThrow();
    });

    it('calls send function when set', () => {
      const mockSend = vi.fn();
      state.setSendToIngestFn(mockSend);

      const event: IngestEvent = {
        streamEventType: 'status',
        data: { message: 'test' },
        timestamp: new Date().toISOString(),
      };

      state.sendToIngest(event);

      expect(mockSend).toHaveBeenCalledWith(event);
    });

    it('setSendToIngestFn can clear function', () => {
      const mockSend = vi.fn();
      state.setSendToIngestFn(mockSend);
      state.setSendToIngestFn(null);

      const event: IngestEvent = {
        streamEventType: 'status',
        data: {},
        timestamp: new Date().toISOString(),
      };

      state.sendToIngest(event);

      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Status API
  // -------------------------------------------------------------------------

  describe('getStatus', () => {
    it('returns idle state with no job', () => {
      const status = state.getStatus();

      expect(status).toEqual({
        state: 'idle',
        executionId: undefined,
        sessionId: undefined,
        lastError: undefined,
      });
    });

    it('returns idle state with job but no inflight', () => {
      state.startJob(
        createJobContext({
          executionId: 'exec_123',
          kiloSessionId: 'kilo_456',
        })
      );

      const status = state.getStatus();

      expect(status).toEqual({
        state: 'idle',
        executionId: 'exec_123',
        sessionId: 'kilo_456',
        lastError: undefined,
      });
    });

    it('returns active state when active', () => {
      state.startJob(
        createJobContext({
          executionId: 'exec_123',
          kiloSessionId: 'kilo_456',
        })
      );
      state.setActive(true);
      const status = state.getStatus();
      expect(status).toEqual({
        state: 'active',
        executionId: 'exec_123',
        sessionId: 'kilo_456',
        lastError: undefined,
      });
    });

    it('includes lastError when present', () => {
      state.startJob(createJobContext());
      const error = {
        code: 'INFLIGHT_TIMEOUT',
        messageId: 'msg_123',
        message: 'Timeout',
        timestamp: Date.now(),
      };
      state.setLastError(error);

      const status = state.getStatus();

      expect(status.lastError).toEqual(error);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases and Invariants
  // -------------------------------------------------------------------------

  describe('edge cases and invariants', () => {
    it('state is IDLE when not active and ACTIVE when active', () => {
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);

      state.setActive(true);
      expect(state.isIdle).toBe(false);
      expect(state.isActive).toBe(true);

      state.setActive(false);
      expect(state.isIdle).toBe(true);
      expect(state.isActive).toBe(false);
    });
  });
});
