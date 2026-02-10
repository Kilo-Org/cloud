/**
 * Unit tests for WrapperState class.
 *
 * Tests state transitions, invariants, and edge cases for the wrapper's
 * centralized state management.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { WrapperState, type JobContext, type InflightEntry } from '../../../wrapper/src/state.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const createJobContext = (overrides: Partial<JobContext> = {}): JobContext => ({
  executionId: 'exc_test-123',
  sessionId: 'session_abc',
  userId: 'user_xyz',
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com',
  ingestToken: 'token_secret',
  kilocodeToken: 'kilo_token_789',
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

    it('has no inflight entries', () => {
      expect(state.inflightCount).toBe(0);
      expect(state.inflightMessageIds).toEqual([]);
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

      it('resets message counter on start', () => {
        state.startJob(createJobContext({ executionId: 'exc_first' }));
        state.nextMessageId(); // counter = 1
        state.nextMessageId(); // counter = 2

        // Clear job and start new one
        state.clearJob();
        state.startJob(createJobContext({ executionId: 'exc_second' }));

        // Counter should be reset
        const messageId = state.nextMessageId();
        expect(messageId).toBe('msg_second_1');
      });

      it('is idempotent for same executionId', () => {
        const context = createJobContext({ executionId: 'exc_same' });
        state.startJob(context);
        state.nextMessageId(); // counter = 1

        // Re-start with same executionId should not reset counter
        state.startJob(context);

        // Counter should NOT be reset for idempotent call
        // (This is the current behavior - idempotent returns early)
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

      it('throws when starting different job with inflight > 0', () => {
        state.startJob(createJobContext({ executionId: 'exc_first' }));
        state.addInflight('msg_1', Date.now() + 60000);

        expect(() => {
          state.startJob(createJobContext({ executionId: 'exc_second' }));
        }).toThrow(/Cannot start new job while inflight > 0/);
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

      it('clears inflight entries', () => {
        state.startJob(createJobContext());
        state.addInflight('msg_1', Date.now() + 60000);
        state.addInflight('msg_2', Date.now() + 60000);

        state.clearJob();

        expect(state.inflightCount).toBe(0);
      });

      it('resets message counter', () => {
        state.startJob(createJobContext({ executionId: 'exc_test' }));
        state.nextMessageId();
        state.nextMessageId();

        state.clearJob();
        state.startJob(createJobContext({ executionId: 'exc_new' }));

        expect(state.nextMessageId()).toBe('msg_new_1');
      });
    });
  });

  // -------------------------------------------------------------------------
  // Inflight Management
  // -------------------------------------------------------------------------

  describe('inflight management', () => {
    beforeEach(() => {
      state.startJob(createJobContext());
    });

    describe('addInflight', () => {
      it('adds entry to inflight map', () => {
        state.addInflight('msg_1', Date.now() + 60000);

        expect(state.inflightCount).toBe(1);
        expect(state.inflightMessageIds).toContain('msg_1');
      });

      it('transitions state to active', () => {
        expect(state.isIdle).toBe(true);

        state.addInflight('msg_1', Date.now() + 60000);

        expect(state.isIdle).toBe(false);
        expect(state.isActive).toBe(true);
      });

      it('updates activity timestamp', () => {
        const beforeTime = Date.now();
        state.addInflight('msg_1', Date.now() + 60000);
        const afterTime = Date.now();

        const idleMs = state.getIdleMs(afterTime);
        // Should be very small (just added)
        expect(idleMs).toBeLessThanOrEqual(afterTime - beforeTime + 1);
      });

      it('allows multiple inflight entries', () => {
        state.addInflight('msg_1', Date.now() + 60000);
        state.addInflight('msg_2', Date.now() + 60000);
        state.addInflight('msg_3', Date.now() + 60000);

        expect(state.inflightCount).toBe(3);
        expect(state.inflightMessageIds).toEqual(['msg_1', 'msg_2', 'msg_3']);
      });
    });

    describe('removeInflight', () => {
      it('removes entry from inflight map', () => {
        state.addInflight('msg_1', Date.now() + 60000);
        state.addInflight('msg_2', Date.now() + 60000);

        const removed = state.removeInflight('msg_1');

        expect(removed).toBe(true);
        expect(state.inflightCount).toBe(1);
        expect(state.inflightMessageIds).toEqual(['msg_2']);
      });

      it('returns false for unknown messageId', () => {
        state.addInflight('msg_1', Date.now() + 60000);

        const removed = state.removeInflight('msg_unknown');

        expect(removed).toBe(false);
        expect(state.inflightCount).toBe(1);
      });

      it('transitions to idle when last entry removed', () => {
        state.addInflight('msg_1', Date.now() + 60000);
        expect(state.isActive).toBe(true);

        state.removeInflight('msg_1');

        expect(state.isIdle).toBe(true);
        expect(state.isActive).toBe(false);
      });

      it('updates activity timestamp on successful remove', () => {
        state.addInflight('msg_1', Date.now() + 60000);
        const beforeRemove = Date.now();

        state.removeInflight('msg_1');

        const afterRemove = Date.now();
        const idleMs = state.getIdleMs(afterRemove);
        expect(idleMs).toBeLessThanOrEqual(afterRemove - beforeRemove + 1);
      });
    });

    describe('hasInflight', () => {
      it('returns true for existing messageId', () => {
        state.addInflight('msg_1', Date.now() + 60000);

        expect(state.hasInflight('msg_1')).toBe(true);
      });

      it('returns false for unknown messageId', () => {
        state.addInflight('msg_1', Date.now() + 60000);

        expect(state.hasInflight('msg_unknown')).toBe(false);
      });
    });

    describe('getExpiredInflight', () => {
      it('returns entries past their deadline', () => {
        const now = Date.now();
        state.addInflight('msg_expired', now - 1000); // Deadline in the past
        state.addInflight('msg_valid', now + 60000); // Deadline in the future

        const expired = state.getExpiredInflight(now);

        expect(expired).toHaveLength(1);
        expect(expired[0].messageId).toBe('msg_expired');
      });

      it('returns empty array when no expired entries', () => {
        const now = Date.now();
        state.addInflight('msg_1', now + 60000);
        state.addInflight('msg_2', now + 60000);

        const expired = state.getExpiredInflight(now);

        expect(expired).toHaveLength(0);
      });

      it('does not remove expired entries (query only)', () => {
        const now = Date.now();
        state.addInflight('msg_expired', now - 1000);

        state.getExpiredInflight(now);

        // Entry should still be in inflight
        expect(state.hasInflight('msg_expired')).toBe(true);
      });

      it('includes entries at exactly deadline time', () => {
        const now = Date.now();
        state.addInflight('msg_exact', now); // Deadline exactly at now

        const expired = state.getExpiredInflight(now);

        expect(expired).toHaveLength(1);
      });
    });

    describe('clearAllInflight', () => {
      it('removes all inflight entries', () => {
        state.addInflight('msg_1', Date.now() + 60000);
        state.addInflight('msg_2', Date.now() + 60000);
        state.addInflight('msg_3', Date.now() + 60000);

        state.clearAllInflight();

        expect(state.inflightCount).toBe(0);
        expect(state.isIdle).toBe(true);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Message ID Generation
  // -------------------------------------------------------------------------

  describe('message ID generation', () => {
    it('throws when no job context', () => {
      expect(() => state.nextMessageId()).toThrow(/No job context/);
    });

    it('generates sequential IDs', () => {
      state.startJob(createJobContext({ executionId: 'exc_test' }));

      expect(state.nextMessageId()).toBe('msg_test_1');
      expect(state.nextMessageId()).toBe('msg_test_2');
      expect(state.nextMessageId()).toBe('msg_test_3');
    });

    it('strips exec_ prefix', () => {
      state.startJob(createJobContext({ executionId: 'exec_abc123' }));

      expect(state.nextMessageId()).toBe('msg_abc123_1');
    });

    it('strips execution_ prefix', () => {
      state.startJob(createJobContext({ executionId: 'execution_def456' }));

      expect(state.nextMessageId()).toBe('msg_def456_1');
    });

    it('strips msg_ prefix', () => {
      state.startJob(createJobContext({ executionId: 'msg_ghi789' }));

      expect(state.nextMessageId()).toBe('msg_ghi789_1');
    });

    it('strips exc_ prefix', () => {
      state.startJob(createJobContext({ executionId: 'exc_ghi789' }));

      expect(state.nextMessageId()).toBe('msg_ghi789_1');
    });

    it('handles executionId without prefix', () => {
      state.startJob(createJobContext({ executionId: 'custom-id-123' }));

      expect(state.nextMessageId()).toBe('msg_custom-id-123_1');
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

    it('clearConnections closes WebSocket and aborts controller', () => {
      const mockClose = vi.fn();
      const mockWs = { readyState: WebSocket.OPEN, close: mockClose } as unknown as WebSocket;
      const mockAbort = new AbortController();
      const abortSpy = vi.spyOn(mockAbort, 'abort');

      state.setConnections(mockWs, mockAbort);
      state.clearConnections();

      expect(mockClose).toHaveBeenCalled();
      expect(abortSpy).toHaveBeenCalled();
      expect(state.ingestWs).toBeNull();
      expect(state.sseAbortController).toBeNull();
    });

    it('clearConnections handles close errors gracefully', () => {
      const mockWs = {
        readyState: WebSocket.OPEN,
        close: () => {
          throw new Error('Close failed');
        },
      } as unknown as WebSocket;

      state.setConnections(mockWs, new AbortController());

      // Should not throw
      expect(() => state.clearConnections()).not.toThrow();
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
        kiloSessionId: undefined,
        inflight: [],
        inflightCount: 0,
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
        kiloSessionId: 'kilo_456',
        inflight: [],
        inflightCount: 0,
        lastError: undefined,
      });
    });

    it('returns active state with inflight', () => {
      state.startJob(
        createJobContext({
          executionId: 'exec_123',
          kiloSessionId: 'kilo_456',
        })
      );
      state.addInflight('msg_1', Date.now() + 60000);
      state.addInflight('msg_2', Date.now() + 60000);

      const status = state.getStatus();

      expect(status).toEqual({
        state: 'active',
        executionId: 'exec_123',
        kiloSessionId: 'kilo_456',
        inflight: ['msg_1', 'msg_2'],
        inflightCount: 2,
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
    it('state is IDLE iff inflightCount == 0', () => {
      state.startJob(createJobContext());

      // Initially idle
      expect(state.isIdle).toBe(state.inflightCount === 0);
      expect(state.isActive).toBe(state.inflightCount > 0);

      // Add one - should be active
      state.addInflight('msg_1', Date.now() + 60000);
      expect(state.isIdle).toBe(state.inflightCount === 0);
      expect(state.isActive).toBe(state.inflightCount > 0);

      // Add another - still active
      state.addInflight('msg_2', Date.now() + 60000);
      expect(state.isIdle).toBe(state.inflightCount === 0);
      expect(state.isActive).toBe(state.inflightCount > 0);

      // Remove one - still active
      state.removeInflight('msg_1');
      expect(state.isIdle).toBe(state.inflightCount === 0);
      expect(state.isActive).toBe(state.inflightCount > 0);

      // Remove last - back to idle
      state.removeInflight('msg_2');
      expect(state.isIdle).toBe(state.inflightCount === 0);
      expect(state.isActive).toBe(state.inflightCount > 0);
    });

    it('inflight entries independent of job context', () => {
      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);

      // Inflight exists
      expect(state.hasInflight('msg_1')).toBe(true);

      // clearJob clears inflight
      state.clearJob();
      expect(state.hasInflight('msg_1')).toBe(false);
    });

    it('duplicate inflight messageId overwrites', () => {
      state.startJob(createJobContext());
      const firstDeadline = Date.now() + 30000;
      const secondDeadline = Date.now() + 60000;

      state.addInflight('msg_1', firstDeadline);
      state.addInflight('msg_1', secondDeadline);

      // Should only have one entry
      expect(state.inflightCount).toBe(1);

      // Second deadline should be used
      const now = firstDeadline + 1; // Past first deadline
      const expired = state.getExpiredInflight(now);
      expect(expired).toHaveLength(0); // Not expired yet with second deadline
    });
  });
});
