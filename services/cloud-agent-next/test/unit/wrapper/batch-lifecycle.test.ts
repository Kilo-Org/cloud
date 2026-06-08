import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleManager } from '../../../wrapper/src/lifecycle.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import { WrapperState } from '../../../wrapper/src/state.js';

vi.mock('../../../wrapper/src/auto-commit.js', () => ({
  runAutoCommit: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../../wrapper/src/condense-on-complete.js', () => ({
  runCondenseOnComplete: vi.fn().mockResolvedValue({ wasAborted: false, success: true }),
}));

vi.mock('../../../wrapper/src/utils.js', () => ({
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  logToFile: vi.fn(),
}));

const messageConfig = {
  autoCommit: false,
  condenseOnComplete: false,
};

function createKiloClient(): WrapperKiloClient {
  return {
    createSession: vi.fn(),
    getSession: vi.fn(),
    sendPromptAsync: vi.fn(),
    abortSession: vi.fn(),
    summarizeSession: vi.fn(),
    sendCommand: vi.fn(),
    answerPermission: vi.fn(),
    answerQuestion: vi.fn(),
    rejectQuestion: vi.fn(),
    generateCommitMessage: vi.fn(),
    getSessionStatuses: vi.fn(),
    getQuestions: vi.fn(),
    getPermissions: vi.fn(),
    getNetworkWaits: vi.fn(),
    resumeNetworkWait: vi.fn(),
    subscribeEvents: vi.fn(),
    serverUrl: 'http://127.0.0.1:0',
  } as WrapperKiloClient;
}

function bindRun(state: WrapperState): void {
  state.bindSession({
    kiloSessionId: 'kilo_session',
    ingestUrl: 'ws://worker.test/ingest',
    workerAuthToken: 'worker-token',
    wrapperRunId: 'run_1',
    wrapperGeneration: 1,
    wrapperConnectionId: 'connection_1',
  });
}

describe('sealed wrapper batch lifecycle', () => {
  let state: WrapperState;
  let sendToIngest: ReturnType<typeof vi.fn>;
  let closeConnections: ReturnType<typeof vi.fn>;
  let manager: ReturnType<typeof createLifecycleManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    state = new WrapperState();
    bindRun(state);
    sendToIngest = vi.fn();
    state.setSendToIngestFn(sendToIngest);
    closeConnections = vi.fn().mockResolvedValue(undefined);
    manager = createLifecycleManager(
      { workspacePath: '/workspace' },
      {
        state,
        kiloClient: createKiloClient(),
        closeConnections,
        isConnected: () => true,
        reconnectEventSubscription: vi.fn(),
      }
    );
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  it('seals exact admitted membership after three seconds of stable root idle', async () => {
    state.acceptMessage('message-1', messageConfig);
    state.acceptMessage('message-2', messageConfig);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(2_999);

    expect(sendToIngest).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );

    await vi.advanceTimersByTimeAsync(1);

    expect(sendToIngest).toHaveBeenCalledWith({
      streamEventType: 'wrapper_finalizing',
      data: { wrapperRunId: 'run_1' },
      timestamp: expect.any(String),
    });
    expect(sendToIngest).toHaveBeenCalledWith({
      streamEventType: 'complete',
      data: expect.objectContaining({
        exitCode: 0,
        kiloSessionId: 'kilo_session',
        messageIds: ['message-1', 'message-2'],
      }),
      timestamp: expect.any(String),
    });
  });

  it('requires a later root idle after root activity', async () => {
    state.acceptMessage('message-1', messageConfig);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(2_000);
    manager.onRootSessionActivity();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sendToIngest).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );
  });

  it('keeps repeated root idle and trailing turn close on the existing candidate', async () => {
    state.acceptMessage('message-1', messageConfig);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(1_000);
    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );
  });

  it('does not seal while a delivery acknowledgement is in flight', async () => {
    state.acceptMessage('message-1', messageConfig);
    state.beginDeliveryAcknowledgement();

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sendToIngest).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );

    state.endDeliveryAcknowledgement();
    manager.onDeliveryAcknowledged('sync-command');
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );
  });

  it('blocks admissions immediately when drain starts without a sealed batch', () => {
    state.clearAllMessages();

    manager.triggerDrainAndClose();

    expect(state.beginDeliveryAcknowledgement()).toBe(false);
    expect(state.isFinalizing).toBe(false);
  });
});
