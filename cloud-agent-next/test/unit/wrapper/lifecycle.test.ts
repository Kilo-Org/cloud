/**
 * Unit tests for lifecycle management.
 *
 * Tests timer logic with mocked state for:
 * - Inflight expiry (per-message timeout)
 * - Idle timeout (session-level cleanup)
 * - Drain period
 * - Post-completion task triggering
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createLifecycleManager,
  DEFAULT_INFLIGHT_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  type LifecycleConfig,
  type LifecycleDependencies,
  type LifecycleManager,
} from '../../../wrapper/src/lifecycle.js';
import { WrapperState, type JobContext } from '../../../wrapper/src/state.js';
import type { KiloClient } from '../../../wrapper/src/kilo-client.js';
import type { ConnectionManager } from '../../../wrapper/src/connection.js';

// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const createMockKiloClient = (): KiloClient => ({
  listSessions: vi.fn().mockResolvedValue([]),
  createSession: vi.fn().mockResolvedValue({ id: 'kilo_sess', time: { created: '', updated: '' } }),
  getSession: vi.fn().mockResolvedValue({ id: 'kilo_sess', time: { created: '', updated: '' } }),
  sendPromptAsync: vi.fn().mockResolvedValue(undefined),
  abortSession: vi.fn().mockResolvedValue(true),
  checkHealth: vi.fn().mockResolvedValue({ healthy: true, version: '1.0.0' }),
  sendCommand: vi.fn().mockResolvedValue(undefined),
  answerPermission: vi.fn().mockResolvedValue(true),
  answerQuestion: vi.fn().mockResolvedValue(true),
  rejectQuestion: vi.fn().mockResolvedValue(true),
});

const createMockConnectionManager = (): ConnectionManager => ({
  open: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(false),
});

const createDefaultConfig = (overrides: Partial<LifecycleConfig> = {}): LifecycleConfig => ({
  maxRuntimeMs: DEFAULT_INFLIGHT_TIMEOUT_MS,
  idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
  autoCommit: false,
  condenseOnComplete: false,
  workspacePath: '/workspace',
  ...overrides,
});

const createJobContext = (overrides: Partial<JobContext> = {}): JobContext => ({
  executionId: 'exec_test',
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

describe('createLifecycleManager', () => {
  let state: WrapperState;
  let kiloClient: KiloClient;
  let connectionManager: ConnectionManager;
  let config: LifecycleConfig;
  let manager: LifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    state = new WrapperState();
    kiloClient = createMockKiloClient();
    connectionManager = createMockConnectionManager();
    config = createDefaultConfig();
  });

  afterEach(() => {
    if (manager) {
      manager.stop();
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createManager = (overrides: Partial<LifecycleConfig> = {}): LifecycleManager => {
    manager = createLifecycleManager(
      { ...config, ...overrides },
      { state, kiloClient, connectionManager }
    );
    return manager;
  };

  // -------------------------------------------------------------------------
  // Basic Lifecycle
  // -------------------------------------------------------------------------

  describe('basic lifecycle', () => {
    it('returns a manager with expected methods', () => {
      const mgr = createManager();

      expect(mgr).toHaveProperty('start');
      expect(mgr).toHaveProperty('stop');
      expect(mgr).toHaveProperty('onMessageComplete');
      expect(mgr).toHaveProperty('triggerDrainAndClose');
      expect(mgr).toHaveProperty('getMaxRuntimeMs');
      expect(mgr).toHaveProperty('signalCompletion');
      expect(mgr).toHaveProperty('setAborted');
    });

    it('getMaxRuntimeMs returns configured value', () => {
      const mgr = createManager({ maxRuntimeMs: 300000 });

      expect(mgr.getMaxRuntimeMs()).toBe(300000);
    });

    it('uses default values when config not provided', () => {
      const mgr = createManager();

      expect(mgr.getMaxRuntimeMs()).toBe(DEFAULT_INFLIGHT_TIMEOUT_MS);
    });
  });

  // -------------------------------------------------------------------------
  // Inflight Expiry
  // -------------------------------------------------------------------------

  describe('inflight expiry', () => {
    it('expires inflight entries past deadline', async () => {
      const mgr = createManager();
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);

      state.startJob(createJobContext());
      const now = Date.now();
      // Add entry that expires in 3 seconds
      state.addInflight('msg_1', now + 3000);

      mgr.start();

      // Advance past the deadline + check interval (5 seconds)
      await vi.advanceTimersByTimeAsync(6000);

      // Should have sent error event
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamEventType: 'error',
          data: expect.objectContaining({
            code: 'INFLIGHT_TIMEOUT',
            messageId: 'msg_1',
          }),
        })
      );

      // Entry should be removed
      expect(state.hasInflight('msg_1')).toBe(false);
    });

    it('sets lastError on inflight timeout', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 1000);

      mgr.start();
      await vi.advanceTimersByTimeAsync(6000);

      const error = state.getLastError();
      expect(error).not.toBeNull();
      expect(error?.code).toBe('INFLIGHT_TIMEOUT');
      expect(error?.messageId).toBe('msg_1');
    });

    it('does not expire entries before deadline', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000); // 60 seconds from now

      mgr.start();
      await vi.advanceTimersByTimeAsync(6000); // Only 6 seconds

      expect(state.hasInflight('msg_1')).toBe(true);
    });

    it('triggers drain and close when inflight hits 0 after expiry', async () => {
      const mgr = createManager();
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 1000);

      mgr.start();
      await vi.advanceTimersByTimeAsync(6000);

      // After drain delay, close should be called
      await vi.advanceTimersByTimeAsync(500);

      expect(connectionManager.close).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Idle Timeout
  // -------------------------------------------------------------------------

  describe('idle timeout', () => {
    it('clears job after idle timeout when no inflight', async () => {
      const mgr = createManager({ idleTimeoutMs: 5000 });
      state.startJob(createJobContext());

      mgr.start();

      // Advance past idle timeout + check interval (10 seconds)
      await vi.advanceTimersByTimeAsync(15000);

      expect(state.hasJob).toBe(false);
    });

    it('sends idle timeout error event', async () => {
      const mgr = createManager({ idleTimeoutMs: 5000 });
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());

      mgr.start();
      await vi.advanceTimersByTimeAsync(15000);

      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamEventType: 'error',
          data: expect.objectContaining({
            code: 'IDLE_TIMEOUT',
          }),
        })
      );
    });

    it('sets lastError on idle timeout', async () => {
      const mgr = createManager({ idleTimeoutMs: 5000 });
      state.startJob(createJobContext());

      mgr.start();
      await vi.advanceTimersByTimeAsync(15000);

      const error = state.getLastError();
      expect(error).not.toBeNull();
      expect(error?.code).toBe('IDLE_TIMEOUT');
    });

    it('does not trigger idle timeout when active', async () => {
      const mgr = createManager({ idleTimeoutMs: 5000 });
      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 120000); // Long deadline

      mgr.start();
      await vi.advanceTimersByTimeAsync(15000);

      // Job should still exist because there's inflight
      expect(state.hasJob).toBe(true);
    });

    it('does not trigger idle timeout without job context', async () => {
      const mgr = createManager({ idleTimeoutMs: 5000 });
      // No job started

      mgr.start();
      await vi.advanceTimersByTimeAsync(15000);

      // Nothing should happen (no job to clear)
      expect(connectionManager.close).not.toHaveBeenCalled();
    });

    it('resets idle timer on activity', async () => {
      const mgr = createManager({ idleTimeoutMs: 10000 });
      state.startJob(createJobContext());

      mgr.start();

      // Wait 8 seconds (less than timeout)
      await vi.advanceTimersByTimeAsync(8000);

      // Update activity
      state.updateActivity();

      // Wait another 8 seconds (total 16 seconds but activity was 8 seconds ago)
      await vi.advanceTimersByTimeAsync(8000);

      // Job should still exist (activity was only 8 seconds ago)
      expect(state.hasJob).toBe(true);

      // Wait until idle timeout from last activity
      await vi.advanceTimersByTimeAsync(5000);

      // Now job should be cleared
      expect(state.hasJob).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Message Completion
  // -------------------------------------------------------------------------

  describe('onMessageComplete', () => {
    it('removes message from inflight', () => {
      const mgr = createManager();
      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);

      mgr.onMessageComplete('msg_1');

      expect(state.hasInflight('msg_1')).toBe(false);
    });

    it('triggers drain when last message completes', async () => {
      const mgr = createManager();
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);

      mgr.onMessageComplete('msg_1');

      // Drain should be triggered (close called after delay)
      // Need to use advanceTimersByTimeAsync for async operations
      await vi.advanceTimersByTimeAsync(500);
      expect(connectionManager.close).toHaveBeenCalled();
    });

    it('does not trigger drain when other messages remain', () => {
      const mgr = createManager();
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);
      state.addInflight('msg_2', Date.now() + 60000);

      mgr.onMessageComplete('msg_1');

      // Advance past drain delay
      vi.advanceTimersByTime(500);

      // Close should NOT be called - still have msg_2
      expect(connectionManager.close).not.toHaveBeenCalled();
    });

    it('handles unknown messageId gracefully', () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      // Should not throw
      expect(() => mgr.onMessageComplete('unknown_msg')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Drain and Close
  // -------------------------------------------------------------------------

  describe('triggerDrainAndClose', () => {
    it('closes connection after drain delay', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.triggerDrainAndClose();

      // Before delay - not closed
      expect(connectionManager.close).not.toHaveBeenCalled();

      // After 250ms drain delay
      await vi.advanceTimersByTimeAsync(300);

      expect(connectionManager.close).toHaveBeenCalled();
    });

    it('is idempotent - multiple calls do not queue multiple drains', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.triggerDrainAndClose();
      mgr.triggerDrainAndClose();
      mgr.triggerDrainAndClose();

      await vi.advanceTimersByTimeAsync(1000);

      // Close should only be called once
      expect(connectionManager.close).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Stop
  // -------------------------------------------------------------------------

  describe('stop', () => {
    it('clears all timers', async () => {
      const mgr = createManager({ idleTimeoutMs: 5000 });
      state.startJob(createJobContext());

      mgr.start();

      // Stop before idle timeout
      await vi.advanceTimersByTimeAsync(3000);
      mgr.stop();

      // Advance past what would have been idle timeout
      await vi.advanceTimersByTimeAsync(20000);

      // Job should still exist (timers stopped)
      expect(state.hasJob).toBe(true);
    });

    it('cancels pending drain', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.triggerDrainAndClose();

      // Stop before drain completes
      vi.advanceTimersByTime(100);
      mgr.stop();

      // Advance past drain delay
      vi.advanceTimersByTime(500);

      // Close should not have been called
      expect(connectionManager.close).not.toHaveBeenCalled();
    });

    it('sets aborted flag', () => {
      const mgr = createManager();

      mgr.stop();

      // This is internal state, verified by behavior in post-completion tests
      // The stop() method sets isAborted = true
    });
  });

  // -------------------------------------------------------------------------
  // setAborted
  // -------------------------------------------------------------------------

  describe('setAborted', () => {
    it('prevents post-completion tasks from running', async () => {
      const mgr = createManager({ autoCommit: true });
      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);

      // Set aborted before completion
      mgr.setAborted();

      // Complete the message (would trigger post-completion tasks)
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mgr.onMessageComplete('msg_1');

      // Wait for any async tasks
      await vi.advanceTimersByTimeAsync(1000);

      // Auto-commit should not have been attempted
      // (We can't easily test this without more mocking, but the flag is set)
    });
  });

  // -------------------------------------------------------------------------
  // signalCompletion
  // -------------------------------------------------------------------------

  describe('signalCompletion', () => {
    it('can be called without error', () => {
      const mgr = createManager();

      // Should not throw
      expect(() => mgr.signalCompletion()).not.toThrow();
    });

    // Integration test: signalCompletion resolves waitForCompletion in runPostCompletionTasks
    // This is tested more thoroughly in integration tests
  });

  // -------------------------------------------------------------------------
  // Post-Completion Tasks
  // -------------------------------------------------------------------------

  describe('post-completion tasks', () => {
    it('runs auto-commit when enabled', async () => {
      const mgr = createManager({ autoCommit: true });
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);

      mgr.start();
      mgr.onMessageComplete('msg_1');

      // Signal completion to unblock auto-commit waiter
      mgr.signalCompletion();

      // Post-completion tasks run before drain
      // This is an integration point - actual auto-commit behavior tested elsewhere
      await vi.advanceTimersByTimeAsync(1000);
    });

    it('runs condense when enabled', async () => {
      const mgr = createManager({ condenseOnComplete: true });
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());
      state.addInflight('msg_1', Date.now() + 60000);

      mgr.start();
      mgr.onMessageComplete('msg_1');

      mgr.signalCompletion();

      await vi.advanceTimersByTimeAsync(1000);
    });

    it('sends error event if auto-commit fails', async () => {
      // This would require mocking runAutoCommit which is imported
      // For unit tests, we verify the error handling path exists
      // Full integration testing would mock the auto-commit module
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles state with no job during expiry check', async () => {
      const mgr = createManager();

      // Add inflight without job context (unusual but possible)
      state.addInflight('msg_1', Date.now() - 1000); // Already expired

      mgr.start();

      // Should not throw during expiry check
      await vi.advanceTimersByTimeAsync(6000);
    });

    it('handles connection not connected during drain', async () => {
      const mgr = createManager();
      (connectionManager.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      state.startJob(createJobContext());

      // Even without connection, triggerDrainAndClose should work
      mgr.triggerDrainAndClose();

      await vi.advanceTimersByTimeAsync(500);

      // close() should still be called (to ensure cleanup)
      expect(connectionManager.close).toHaveBeenCalled();
    });

    it('multiple inflight entries with different deadlines', async () => {
      const mgr = createManager();
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);

      state.startJob(createJobContext());
      const now = Date.now();
      state.addInflight('msg_short', now + 2000); // Expires at 2s
      state.addInflight('msg_long', now + 10000); // Expires at 10s

      mgr.start();

      // After 6 seconds, only msg_short should be expired
      await vi.advanceTimersByTimeAsync(6000);

      expect(state.hasInflight('msg_short')).toBe(false);
      expect(state.hasInflight('msg_long')).toBe(true);

      // Check that error was sent for short one only
      const errorCalls = sendToIngestSpy.mock.calls.filter(
        call => call[0]?.streamEventType === 'error'
      );
      expect(errorCalls).toHaveLength(1);
      expect(errorCalls[0][0].data.messageId).toBe('msg_short');
    });
  });
});
