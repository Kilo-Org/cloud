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
} from '../../../wrapper/src/lifecycle.js';
import { WrapperState, type SessionContext } from '../../../wrapper/src/state.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';

vi.mock('../../../wrapper/src/auto-commit.js', () => ({
  runAutoCommit: vi.fn(),
}));

vi.mock('../../../wrapper/src/condense-on-complete.js', () => ({
  runCondenseOnComplete: vi.fn(),
}));

vi.mock('../../../wrapper/src/utils.js', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  logToFile: vi.fn(),
}));

import { runAutoCommit } from '../../../wrapper/src/auto-commit.js';
import { runCondenseOnComplete } from '../../../wrapper/src/condense-on-complete.js';

const mockRunAutoCommit = vi.mocked(runAutoCommit);
const mockRunCondenseOnComplete = vi.mocked(runCondenseOnComplete);
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
  getSessionStatuses: vi.fn().mockResolvedValue({}),
  getQuestions: vi.fn().mockResolvedValue([]),
  getPermissions: vi.fn().mockResolvedValue([]),
  getNetworkWaits: vi.fn().mockResolvedValue([]),
  resumeNetworkWait: vi.fn().mockResolvedValue(true),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: 'test commit' }),
  getSessionStatuses: vi.fn().mockResolvedValue({}),
  getQuestions: vi.fn().mockResolvedValue([]),
  getPermissions: vi.fn().mockResolvedValue([]),
  subscribeEvents: vi.fn().mockResolvedValue({ stream: undefined }),
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

const createSessionContext = (overrides: Partial<SessionContext> = {}): SessionContext => ({
  kiloSessionId: 'kilo_sess_456',
  ingestUrl: 'wss://ingest.example.com',
  ingestToken: 'token_secret',
  workerAuthToken: 'kilo_token_789',
  ...overrides,
});

const createDeferred = <T>() => {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

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
    mockRunCondenseOnComplete.mockResolvedValue({ wasAborted: false, success: true });
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
      {
        state,
        kiloClient,
        closeConnections: connectionFns.closeConnections,
        isConnected: connectionFns.isConnected,
        reconnectEventSubscription: connectionFns.reconnectEventSubscription,
      }
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
      expect(mgr).toHaveProperty('onRootSessionActivity');
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
    it('sets state to idle after completing last message', () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
      mgr.onMessageComplete('msg_1');
      expect(state.isIdle).toBe(true);
    });

    it('triggers drain after the final message and root session idle', async () => {
      const mgr = createManager();
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(500);
      expect(connectionFns.closeConnections).toHaveBeenCalled();
    });

    it('does not trigger drain when pending messages remain', async () => {
      const mgr = createManager();
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });
      mgr.onMessageComplete('msg_1');
      await vi.advanceTimersByTimeAsync(500);
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();
      expect(state.isActive).toBe(true);
      expect(state.activeMessageId).toBe('msg_2');
    });

    it('handles unknown messageId gracefully', () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());
      expect(() => mgr.onMessageComplete('unknown_msg')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Root idle freshness barrier
  // -------------------------------------------------------------------------

  describe('root idle freshness barrier', () => {
    it('waits for a fresh root idle after post-idle activity before finalizing', async () => {
      const mgr = createManager();
      const sendToIngestSpy = vi.fn();
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      state.setSendToIngestFn(sendToIngestSpy);
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

      mgr.onSessionIdle();
      mgr.onRootSessionActivity();
      mgr.onMessageComplete('msg_1');

      await vi.advanceTimersByTimeAsync(1000);

      expect(sendToIngestSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();

      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(1000);

      expect(sendToIngestSpy).toHaveBeenCalledTimes(1);
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(1);
    });

    it('finalizes once after repeated stale idle and root activity cycles', async () => {
      const mgr = createManager();
      const sendToIngestSpy = vi.fn();
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      state.setSendToIngestFn(sendToIngestSpy);
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_cycle', { autoCommit: false, condenseOnComplete: false });

      mgr.onSessionIdle();
      mgr.onRootSessionActivity();
      mgr.onSessionIdle();
      mgr.onRootSessionActivity();
      mgr.onMessageComplete('msg_cycle');

      await vi.advanceTimersByTimeAsync(1000);

      expect(sendToIngestSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();

      mgr.onSessionIdle();
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(1000);

      expect(sendToIngestSpy).toHaveBeenCalledTimes(1);
      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ streamEventType: 'complete' })
      );
      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(1);
    });
  });

  it('includes the observed gate result in the final complete event', async () => {
    const mgr = createManager();
    const sendToIngestSpy = vi.fn();
    (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    state.setSendToIngestFn(sendToIngestSpy);
    state.bindSession(createSessionContext());
    state.acceptMessage('msg_gate_result', { autoCommit: false, condenseOnComplete: false });
    state.observeGateResult('pass');

    mgr.onMessageComplete('msg_gate_result');
    mgr.onSessionIdle();
    await vi.advanceTimersByTimeAsync(1000);

    expect(sendToIngestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        streamEventType: 'complete',
        data: expect.objectContaining({ gateResult: 'pass' }),
      })
    );
  });

  it('does not carry an observed gate result into a follow-up message accepted during drain', async () => {
    const mgr = createManager();
    const sendToIngestSpy = vi.fn();
    (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
    state.setSendToIngestFn(sendToIngestSpy);
    state.bindSession(createSessionContext());
    state.acceptMessage('msg_first', { autoCommit: false, condenseOnComplete: false });
    state.observeGateResult('fail');

    mgr.onMessageComplete('msg_first');
    mgr.onSessionIdle();
    await vi.advanceTimersByTimeAsync(0);

    expect(sendToIngestSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        streamEventType: 'complete',
        data: expect.objectContaining({ gateResult: 'fail' }),
      })
    );

    state.acceptMessage('msg_followup', { autoCommit: false, condenseOnComplete: false });
    await vi.advanceTimersByTimeAsync(300);

    expect(connectionFns.closeConnections).not.toHaveBeenCalled();

    mgr.onMessageComplete('msg_followup');
    mgr.onSessionIdle();
    await vi.advanceTimersByTimeAsync(1000);

    const completeEvents = sendToIngestSpy.mock.calls
      .map(([event]) => event)
      .filter(event => event.streamEventType === 'complete');

    expect(completeEvents).toHaveLength(2);
    expect(completeEvents[1].data).not.toHaveProperty('gateResult');
  });

  // -------------------------------------------------------------------------
  // Drain and Close
  // -------------------------------------------------------------------------

  describe('triggerDrainAndClose', () => {
    it('closes connection after drain delay', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

      mgr.triggerDrainAndClose();

      // Before delay - not closed
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();

      // After 250ms drain delay
      await vi.advanceTimersByTimeAsync(300);

      expect(connectionFns.closeConnections).toHaveBeenCalled();
    });

    it('is idempotent - multiple calls do not queue multiple drains', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

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
      state.bindSession(createSessionContext());

      mgr.start();

      await vi.advanceTimersByTimeAsync(3000);
      mgr.stop();

      await vi.advanceTimersByTimeAsync(20000);

      expect(state.hasSession).toBe(true);
    });

    it('cancels pending drain', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

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
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: true, condenseOnComplete: false });

      mgr.setAborted();

      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mgr.onMessageComplete('msg_1');

      await vi.advanceTimersByTimeAsync(1000);
    });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  describe('reset', () => {
    it('reset clears aborted flag - allows complete event after reset', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

      mgr.setAborted();
      mgr.reset();

      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);

      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(1000);

      expect(sendToIngestSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          streamEventType: 'complete',
        })
      );
    });

    it('reset clears draining flag - allows new drain after reset', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      // First drain — complete the message to simulate realistic flow
      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(500);

      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(1);

      // Reset clears isDraining so a second drain can happen
      mgr.reset();

      // Start a fresh session
      state.clearSession();
      state.bindSession(createSessionContext({ kiloSessionId: 'kilo_sess_second' }));
      state.acceptMessage('msg_2', { autoCommit: false, condenseOnComplete: false });

      // Completing last active message triggers a new drain
      mgr.onMessageComplete('msg_2');
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(1000);

      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(2);
    });

    it('reset enables post-completion flow after previous abort', async () => {
      const mgr = createManager({}, { autoCommit: false });
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: false });

      mgr.setAborted();
      mgr.reset();

      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      const sendToIngestSpy = vi.fn();
      state.setSendToIngestFn(sendToIngestSpy);

      mgr.onMessageComplete('msg_1');
      mgr.signalCompletion();
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(1000);

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

      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: true, condenseOnComplete: false });

      mgr.start();
      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();

      mgr.signalCompletion();

      await vi.advanceTimersByTimeAsync(1000);
    });

    it('runs condense when enabled', async () => {
      const mgr = createManager({}, { condenseOnComplete: true });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: false, condenseOnComplete: true });

      mgr.start();
      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();

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
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: true, condenseOnComplete: false });

      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();
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
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: true, condenseOnComplete: false });

      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();
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

    it('awaits final message auto-commit before log upload, complete event, and close', async () => {
      const order: string[] = [];
      const autoCommit = createDeferred<{ success: true }>();
      mockRunAutoCommit.mockImplementation(async () => {
        order.push('auto-commit:start');
        const result = await autoCommit.promise;
        order.push('auto-commit:finish');
        return result;
      });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      connectionFns.closeConnections.mockImplementation(async () => {
        order.push('close');
      });
      state.setLogUploader({
        start: vi.fn(),
        uploadNow: vi.fn(async () => {
          order.push('upload');
        }),
        stop: vi.fn(),
      });
      state.setSendToIngestFn(event => {
        if (event.streamEventType === 'complete') {
          order.push('complete');
        }
      });

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: true, condenseOnComplete: false });

      mgr.onMessageComplete('msg_1');
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(0);

      expect(order).toEqual(['auto-commit:start']);

      autoCommit.resolve({ success: true });
      await vi.advanceTimersByTimeAsync(300);

      expect(order).toEqual([
        'auto-commit:start',
        'auto-commit:finish',
        'upload',
        'complete',
        'close',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // Edge Cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles connection not connected during drain', async () => {
      const mgr = createManager();
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(false);

      state.bindSession(createSessionContext());

      mgr.triggerDrainAndClose();

      await vi.advanceTimersByTimeAsync(500);

      expect(connectionFns.closeConnections).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // onSseEvent / transport timer
  // -------------------------------------------------------------------------

  describe('onSseEvent / transport timer', () => {
    it('fires reconnectEventSubscription after 15s of no events', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

      mgr.onSseEvent();

      await vi.advanceTimersByTimeAsync(15_000);

      expect(connectionFns.reconnectEventSubscription).toHaveBeenCalledTimes(1);
    });

    it('resets timer on each onSseEvent call', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

      mgr.onSseEvent();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();

      mgr.onSseEvent();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(connectionFns.reconnectEventSubscription).toHaveBeenCalledTimes(1);
    });

    it('does not fire timer when no session context', async () => {
      const mgr = createManager();

      mgr.onSseEvent();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();
    });

    it('transport timer is cleared on stop', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

      mgr.onSseEvent();
      mgr.stop();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();
    });

    it('transport timer is cleared on reset', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

      mgr.onSseEvent();
      mgr.reset();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).not.toHaveBeenCalled();
    });

    it('initial arming triggers reconnect when stream never yields', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());

      mgr.onSseEvent();

      await vi.advanceTimersByTimeAsync(15_000);
      expect(connectionFns.reconnectEventSubscription).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Post-completion exactly-once
  // -------------------------------------------------------------------------

  describe('post-completion exactly-once', () => {
    it('final message auto-commit runs exactly once, not twice', async () => {
      mockRunAutoCommit.mockResolvedValue({ success: true });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_final', { autoCommit: true, condenseOnComplete: false });

      mgr.onMessageComplete('msg_final');
      mgr.signalCompletion();
      mgr.onSessionIdle();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockRunAutoCommit).toHaveBeenCalledTimes(1);
    });

    it('defers non-final message auto-commit while wrapper remains active', async () => {
      mockRunAutoCommit.mockResolvedValue({ success: true });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: true, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      mgr.onMessageComplete('msg_a');
      mgr.signalCompletion();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockRunAutoCommit).not.toHaveBeenCalled();
      expect(state.activeMessageId).toBe('msg_b');
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();
    });

    it('finalizes a multi-message sequence once after the batch reaches idle', async () => {
      mockRunAutoCommit.mockResolvedValue({ success: true });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: true, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: true, condenseOnComplete: false });

      mgr.onMessageComplete('msg_a');
      mgr.signalCompletion();
      await vi.advanceTimersByTimeAsync(100);

      expect(mockRunAutoCommit).not.toHaveBeenCalled();

      mgr.onMessageComplete('msg_b');
      mgr.signalCompletion();
      mgr.onSessionIdle();
      await vi.advanceTimersByTimeAsync(1000);

      expect(mockRunAutoCommit).toHaveBeenCalledTimes(1);
    });

    it('abort path does not run auto-commit', async () => {
      mockRunAutoCommit.mockResolvedValue({ success: true });

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_1', { autoCommit: true, condenseOnComplete: false });

      mgr.setAborted();
      mgr.triggerDrainAndClose();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockRunAutoCommit).not.toHaveBeenCalled();
    });

    it('final message condense runs exactly once', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_final', { autoCommit: false, condenseOnComplete: true });

      mgr.onMessageComplete('msg_final');
      mgr.signalCompletion();
      mgr.onSessionIdle();

      await vi.advanceTimersByTimeAsync(1000);

      expect(mockRunCondenseOnComplete).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Idle-batch post-completion tasks
  // -------------------------------------------------------------------------

  describe('onMessageComplete — idle-batch post-completion', () => {
    it('runs auto-commit after the final message reaches drain', async () => {
      mockRunAutoCommit.mockResolvedValue({ success: true });
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_comp_1', { autoCommit: true, condenseOnComplete: false });

      mgr.onMessageComplete('msg_comp_1');
      mgr.onSessionIdle();

      // Auto-commit runs asynchronously after completion
      await vi.advanceTimersByTimeAsync(100);

      expect(mockRunAutoCommit).toHaveBeenCalledTimes(1);
    });

    it('does not trigger drain when onMessageComplete and more messages are pending', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_first', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_second', { autoCommit: false, condenseOnComplete: false });

      // Complete first message — should NOT drain because second is still pending
      mgr.onMessageComplete('msg_first');

      await vi.advanceTimersByTimeAsync(100);

      expect(connectionFns.closeConnections).not.toHaveBeenCalled();
      expect(state.activeMessageId).toBe('msg_second');
    });

    it('promotes next accepted message after completing active', async () => {
      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_c', { autoCommit: false, condenseOnComplete: false });

      expect(state.activeMessageId).toBe('msg_a');

      mgr.onMessageComplete('msg_a');
      expect(state.activeMessageId).toBe('msg_b');

      mgr.onMessageComplete('msg_b');
      expect(state.activeMessageId).toBe('msg_c');

      mgr.onMessageComplete('msg_c');
      expect(state.activeMessageId).toBeNull();
      expect(state.isIdle).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Message-ID-gated completion (stale/duplicate protection)
  // -------------------------------------------------------------------------

  describe('onMessageComplete — stale and duplicate protection', () => {
    it('duplicate completion for already-completed message does not affect the new active message', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mockRunAutoCommit.mockResolvedValue({ success: true });

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      mgr.onMessageComplete('msg_a');
      expect(state.activeMessageId).toBe('msg_b');

      mgr.onMessageComplete('msg_a');
      expect(state.activeMessageId).toBe('msg_b');
      expect(state.isActive).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();
    });

    it('completion for accepted-but-not-active message is ignored', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      mgr.onMessageComplete('msg_b');

      expect(state.activeMessageId).toBe('msg_a');
      expect(state.isActive).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();
    });

    it('completion for unknown message ID is ignored', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: false, condenseOnComplete: false });

      mgr.onMessageComplete('msg_nonexistent');

      expect(state.activeMessageId).toBe('msg_a');
      expect(state.isActive).toBe(true);

      await vi.advanceTimersByTimeAsync(500);
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();
    });

    it('stale completion does not run post-completion tasks for the wrong message', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);
      mockRunAutoCommit.mockResolvedValue({ success: true });

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_a', { autoCommit: true, condenseOnComplete: false });
      state.acceptMessage('msg_b', { autoCommit: false, condenseOnComplete: false });

      mgr.onMessageComplete('msg_a');
      await vi.advanceTimersByTimeAsync(100);

      const autoCommitCallsAfterFirst = mockRunAutoCommit.mock.calls.length;

      mgr.onMessageComplete('msg_a');
      await vi.advanceTimersByTimeAsync(100);

      expect(mockRunAutoCommit.mock.calls.length).toBe(autoCommitCallsAfterFirst);
    });
  });

  // -------------------------------------------------------------------------
  // Drain guard — drain does not close over newly accepted prompts
  // -------------------------------------------------------------------------

  describe('drain guard', () => {
    it('drain does not close connections when a new message is accepted during drain', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_last', { autoCommit: false, condenseOnComplete: false });

      // Complete last message and observe root idle — triggers drain
      mgr.onMessageComplete('msg_last');
      mgr.onSessionIdle();

      // Before drain delay expires, accept a new message
      state.acceptMessage('msg_new', { autoCommit: false, condenseOnComplete: false });

      // Advance past drain delay
      await vi.advanceTimersByTimeAsync(1000);

      // Drain should NOT have closed connections because a new message is active
      expect(connectionFns.closeConnections).not.toHaveBeenCalled();

      // The session should still be active
      expect(state.activeMessageId).toBe('msg_new');
      expect(state.isIdle).toBe(false);
    });

    it('drain still closes after delay when no new messages arrive', async () => {
      (connectionFns.isConnected as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const mgr = createManager();
      state.bindSession(createSessionContext());
      state.acceptMessage('msg_only', { autoCommit: false, condenseOnComplete: false });

      // Complete the only message and observe root idle — triggers drain
      mgr.onMessageComplete('msg_only');
      mgr.onSessionIdle();

      // Advance past drain delay
      await vi.advanceTimersByTimeAsync(1000);

      // Drain should close connections
      expect(connectionFns.closeConnections).toHaveBeenCalledTimes(1);
    });
  });
});
