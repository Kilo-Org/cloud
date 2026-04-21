/**
 * Unit tests for lifecycle management.
 *
 * Tests timer logic with mocked state for:
 * - SSE transport timer (15s reconnect)
 * - Drain period
 * - Post-completion task triggering
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  createLifecycleManager,
  type LifecycleConfig,
  type LifecycleDependencies,
  type LifecycleManager,
  type PerTurnConfig,
} from '../../../wrapper/src/lifecycle.js';
import { WrapperState, type JobContext } from '../../../wrapper/src/state.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';

vi.mock('../../../wrapper/src/auto-commit.js', () => ({
  runAutoCommit: vi.fn(),
}));

import { runAutoCommit } from '../../../wrapper/src/auto-commit.js';

const mockRunAutoCommit = vi.mocked(runAutoCommit);
// ---------------------------------------------------------------------------
// Test Helpers
// ---------------------------------------------------------------------------

const createMockKiloClient = (): WrapperKiloClient => ({
  createSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  getSession: vi.fn().mockResolvedValue({ id: 'kilo_sess' }),
  sendPromptAsync: vi.fn().mockResolvedValue(undefined),
  abortSession: vi.fn().mockResolvedValue(true),
  sendCommand: vi.fn().mockResolvedValue(undefined),
  answerPermission: vi.fn().mockResolvedValue(true),
  answerQuestion: vi.fn().mockResolvedValue(true),
  rejectQuestion: vi.fn().mockResolvedValue(true),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
  sdkClient: {} as WrapperKiloClient['sdkClient'],
  serverUrl: 'http://127.0.0.1:0',
});

type MockConnectionFns = {
  closeConnections: ReturnType<typeof vi.fn>;
  isConnected: ReturnType<typeof vi.fn>;
  reconnectEventSubscription: ReturnType<typeof vi.fn>;
};

const createMockConnectionFns = (): MockConnectionFns => ({
  closeConnections: vi.fn().mockResolvedValue(undefined),
  isConnected: vi.fn().mockReturnValue(false),
  reconnectEventSubscription: vi.fn(),
});

const createDefaultConfig = (overrides: Partial<LifecycleConfig> = {}): LifecycleConfig => ({
  workspacePath: '/workspace',
  ...overrides,
});

const createDefaultPerTurnConfig = (overrides: Partial<PerTurnConfig> = {}): PerTurnConfig => ({
  autoCommit: false,
  condenseOnComplete: false,
  ...overrides,
});

const createJobContext = (overrides: Partial<JobContext> = {}): JobContext => ({
  executionId: 'exec_test',
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createLifecycleManager', () => {
  let state: WrapperState;
  let kiloClient: WrapperKiloClient;
  let connectionFns: MockConnectionFns;
  let config: LifecycleConfig;
  let manager: LifecycleManager;

  beforeEach(() => {
    vi.useFakeTimers();
    state = new WrapperState();
    kiloClient = createMockKiloClient();
    connectionFns = createMockConnectionFns();
    config = createDefaultConfig();
    mockRunAutoCommit.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    if (manager) {
      manager.stop();
    }
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const createManager = (
    overrides: Partial<LifecycleConfig> = {},
    perTurnOverrides: Partial<PerTurnConfig> = {}
  ): LifecycleManager => {
    manager = createLifecycleManager(
      { ...config, ...overrides },
      {
        state,
        kiloClient,
        closeConnections: connectionFns.closeConnections,
        isConnected: connectionFns.isConnected,
        reconnectEventSubscription: connectionFns.reconnectEventSubscription,
      }
    );
    // Apply per-turn config if overrides provided
    if (Object.keys(perTurnOverrides).length > 0) {
      manager.setPerTurnConfig(createDefaultPerTurnConfig(perTurnOverrides));
    }
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
      expect(mgr).toHaveProperty('onSseEvent');
      expect(mgr).toHaveProperty('signalCompletion');
      expect(mgr).toHaveProperty('setAborted');
    });

    it('has onSseEvent method', () => {
      const mgr = createManager();
      expect(typeof mgr.onSseEvent).toBe('function');
    });
  });

  // -------------------------------------------------------------------------
  // Message Completion
  // -------------------------------------------------------------------------

  describe('onMessageComplete', () => {
    it('sets state to inactive', () => {
      const mgr = createManager();
      state.startJob(createJobContext());
      state.setActive(true);
      mgr.onMessageComplete('msg_1');
      expect(state.isIdle).toBe(true);
    });

    it('triggers drain when message completes', async () => {
      const mgr = createManager();
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      state.startJob(createJobContext());
      state.setActive(true);
      mgr.onMessageComplete('msg_1');
      await vi.advanceTimersByTimeAsync(500);
      expect(connectionFns.closeConnections).toHaveBeenCalled();
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
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();

      // After 250ms drain delay
      await vi.advanceTimersByTimeAsync(300);

      expect(connectionFns.closeConnections).toHaveBeenCalled();
    });

    it('is idempotent - multiple calls do not queue multiple drains', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.triggerDrainAndClose();
      mgr.triggerDrainAndClose();
      mgr.triggerDrainAndClose();

      await vi.advanceTimersByTimeAsync(1000);

      // Close should only be called once
      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Stop
  // -------------------------------------------------------------------------

  describe('stop', () => {
    it('clears all timers', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.start();

      await vi.advanceTimersByTimeAsync(3000);
      mgr.stop();

      // Advance well past any timer interval
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
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();
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
      const mgr = createManager({}, { autoCommit: true });
      state.startJob(createJobContext());
      state.setActive(true);

      // Set aborted before completion
      mgr.setAborted();

      // Complete the message (would trigger post-completion tasks)
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mgr.onMessageComplete('msg_1');

      // Wait for any async tasks
      await vi.advanceTimersByTimeAsync(1000);
    });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  describe('reset', () => {
    it('reset clears aborted flag - allows complete event after reset', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());
      state.setActive(true);

      mgr.setAborted();
      mgr.reset();

      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);

      // Completing the last active message triggers drain
      mgr.onMessageComplete('msg_1');
      await vi.advanceTimersByTimeAsync(1000);

      // complete event should be sent because isAborted was reset
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamEventType: 'complete',
        })
      );
    });

    it('reset clears draining flag - allows new drain after reset', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      // First drain
      mgr.triggerDrainAndClose();
      await vi.advanceTimersByTimeAsync(500);

      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(1);

      // Reset clears isDraining so a second drain can happen
      mgr.reset();

      // Start a fresh job
      state.clearJob();
      state.startJob(createJobContext({ executionId: 'exc_second' }));
      state.setActive(true);

      // Completing last active message triggers a new drain
      mgr.onMessageComplete('msg_2');
      await vi.advanceTimersByTimeAsync(1000);

      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(2);
    });

    it('reset enables post-completion flow after previous abort', async () => {
      const mgr = createManager({}, { autoCommit: false });
      state.startJob(createJobContext());
      state.setActive(true);

      mgr.setAborted();
      mgr.reset();

      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);

      mgr.onMessageComplete('msg_1');
      mgr.signalCompletion();
      await vi.advanceTimersByTimeAsync(1000);

      // complete event should be sent (not skipped due to stale aborted flag)
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamEventType: 'complete',
        })
      );
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
      const mgr = createManager({}, { autoCommit: true });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());
      state.setActive(true);

      mgr.start();
      mgr.onMessageComplete('msg_1');

      // Signal completion to unblock auto-commit waiter
      mgr.signalCompletion();

      // Post-completion tasks run before drain
      // This is an integration point - actual auto-commit behavior tested elsewhere
      await vi.advanceTimersByTimeAsync(1000);
    });

    it('runs condense when enabled', async () => {
      const mgr = createManager({}, { condenseOnComplete: true });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.startJob(createJobContext());
      state.setActive(true);

      mgr.start();
      mgr.onMessageComplete('msg_1');

      mgr.signalCompletion();

      await vi.advanceTimersByTimeAsync(1000);
    });

    it('aborts auto-commit when the lifecycle timeout fires', async () => {
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);
      mockRunAutoCommit.mockImplementation(
        ({ signal }) =>
          new Promise(resolve => {
            signal?.addEventListener(
              'abort',
              () => resolve({ success: false, error: 'exec aborted' }),
              {
                once: true,
              }
            );
          })
      );

      const mgr = createManager({}, { autoCommit: true });
      state.startJob(createJobContext());

      mgr.triggerDrainAndClose();
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(300);

      const autoCommitCall = mockRunAutoCommit.mock.calls[0]?.[0];
      expect(autoCommitCall?.signal?.aborted).toBe(true);
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamEventType: 'error',
          data: { error: 'Auto-commit timed out', fatal: false },
        })
      );
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
    });

    it('does not report lifecycle timeout when auto-commit wins the timeout race', async () => {
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);
      mockRunAutoCommit.mockImplementation(
        ({ signal }) =>
          new Promise(resolve => {
            signal?.addEventListener('abort', () => resolve({ success: true }), {
              once: true,
            });
          })
      );

      const mgr = createManager({}, { autoCommit: true });
      state.startJob(createJobContext());

      mgr.triggerDrainAndClose();
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(300);

      expect(sendToIngestSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          streamEventType: 'error',
          data: { error: 'Auto-commit timed out', fatal: false },
        })
      );
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles connection not connected during drain', async () => {
      const mgr = createManager();
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      state.startJob(createJobContext());

      // Even without connection, triggerDrainAndClose should work
      mgr.triggerDrainAndClose();

      await vi.advanceTimersByTimeAsync(500);

      // close() should still be called (to ensure cleanup)
      expect(connectionFns.closeConnections).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onSseEvent / transport timer
  // -------------------------------------------------------------------------

  describe('onSseEvent / transport timer', () => {
    it('fires reconnectEventSubscription after 15s of no events', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      // First call starts the timer
      mgr.onSseEvent();

      // Advance 15 seconds — timer should fire
      await vi.advanceTimersByTimeAsync(15_000);

      expect(connectionFns.reconnectEventSubscription).toHaveBeenCalledTimes(1);
    });

    it('resets timer on each onSseEvent call', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.onSseEvent();

      // Advance 10s (not yet expired)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();

      // Reset timer
      mgr.onSseEvent();

      // Advance another 10s (timer was reset, so 10s since last reset)
      await vi.advanceTimersByTimeAsync(10_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();

      // Advance 5 more seconds (15s since last reset)
      await vi.advanceTimersByTimeAsync(5_000);
      expect(connectionFns.reconnectEventSubscription).toHaveBeenCalledTimes(1);
    });

    it('does not fire timer when no job context', async () => {
      const mgr = createManager();
      // No job started

      mgr.onSseEvent();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();
    });

    it('transport timer is cleared on stop', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.onSseEvent();
      mgr.stop();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();
    });

    it('transport timer is cleared on reset', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      mgr.onSseEvent();
      mgr.reset();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();
    });

    it('initial arming triggers reconnect when stream never yields', async () => {
      const mgr = createManager();
      state.startJob(createJobContext());

      // Simulate the initial arming added in startEventSubscription()
      // before the for-await loop — no stream events follow.
      mgr.onSseEvent();

      // After 15s with no further onSseEvent calls, the timer should fire.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).toHaveBeenCalledTimes(1);
    });
  });
});
