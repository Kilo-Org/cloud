import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAutoCommit } from '../../../wrapper/src/auto-commit.js';
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

function createKiloClient(): WrapperKiloClient {
  return { serverUrl: 'http://127.0.0.1:0' } as WrapperKiloClient;
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

const config = { autoCommit: false, condenseOnComplete: false };

describe('wrapper sealed batch lifecycle', () => {
  let state: WrapperState;
  let sendToIngest: ReturnType<typeof vi.fn>;
  let closeConnections: ReturnType<typeof vi.fn>;
  let manager: ReturnType<typeof createLifecycleManager>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runAutoCommit).mockClear();
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

  it('emits finalizing then complete once with exact admitted membership', async () => {
    state.acceptMessage('message-1', config);
    state.acceptMessage('message-2', config);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_300);

    expect(sendToIngest).toHaveBeenCalledWith({
      streamEventType: 'wrapper_finalizing',
      data: { wrapperRunId: 'run_1' },
      timestamp: expect.any(String),
    });
    const completeEvents = sendToIngest.mock.calls
      .map(([event]) => event)
      .filter(event => event.streamEventType === 'complete');
    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0].data).toMatchObject({
      kiloSessionId: 'kilo_session',
      messageIds: ['message-1', 'message-2'],
    });
    expect(closeConnections).toHaveBeenCalledOnce();
  });

  it('does not seal until root idle is stable for three seconds', async () => {
    state.acceptMessage('message-1', config);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(sendToIngest).not.toHaveBeenCalled();

    manager.onRootSessionActivity();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendToIngest).not.toHaveBeenCalled();

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );
  });

  it('preserves the idle candidate through transient ingest reconnect', async () => {
    state.acceptMessage('message-1', config);
    manager.onSessionIdle();

    await vi.advanceTimersByTimeAsync(2_000);
    manager.onConnectionRestored();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );
  });

  it('does not seal while delivery acknowledgement remains in flight', async () => {
    state.acceptMessage('message-1', config);
    state.beginDeliveryAcknowledgement();
    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sendToIngest).not.toHaveBeenCalled();

    state.endDeliveryAcknowledgement();
    manager.onDeliveryAcknowledged('failed');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );
  });

  it('waits for enabled post-processing before complete and close', async () => {
    let resolveAutoCommit: ((result: { success: boolean }) => void) | undefined;
    vi.mocked(runAutoCommit).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAutoCommit = resolve;
        })
    );
    state.acceptMessage('message-1', { ...config, autoCommit: true });

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'wrapper_finalizing' })
    );
    expect(sendToIngest).not.toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'complete' })
    );
    expect(closeConnections).not.toHaveBeenCalled();

    resolveAutoCommit?.({ success: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(sendToIngest).toHaveBeenCalledWith(
      expect.objectContaining({ streamEventType: 'complete' })
    );
    expect(closeConnections).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(closeConnections).toHaveBeenCalledOnce();
  });

  it('uses latest admitted finalization config', async () => {
    state.acceptMessage('message-1', { ...config, autoCommit: true });
    state.acceptMessage('message-2', config);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_300);

    expect(runAutoCommit).not.toHaveBeenCalled();
  });
});
