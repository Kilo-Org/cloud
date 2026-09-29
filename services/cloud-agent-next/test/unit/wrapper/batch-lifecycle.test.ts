import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAutoCommit } from '../../../wrapper/src/auto-commit.js';
import { createLifecycleManager } from '../../../wrapper/src/lifecycle.js';
import type { WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import type { IngestEvent } from '../../../src/shared/protocol.js';
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

function createKiloClient(deps: {
  drainSession: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
}): WrapperKiloClient {
  return {
    createSession: vi.fn(),
    getSession: vi.fn(),
    drainSession: deps.drainSession,
    sendPromptAsync: vi.fn(),
    abortSession: deps.abortSession,
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
  } as unknown as WrapperKiloClient;
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('sealed wrapper batch lifecycle', () => {
  let state: WrapperState;
  let sendToIngest: ReturnType<typeof vi.fn>;
  let closeConnections: ReturnType<typeof vi.fn>;
  let drainSession: ReturnType<typeof vi.fn>;
  let abortSession: ReturnType<typeof vi.fn>;
  let manager: ReturnType<typeof createLifecycleManager>;

  const eventsOfType = (kind: string): IngestEvent[] =>
    sendToIngest.mock.calls
      .map(([event]: [IngestEvent]) => event)
      .filter((event: IngestEvent) => event.streamEventType === kind);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runAutoCommit).mockReset();
    vi.mocked(runAutoCommit).mockResolvedValue({ success: true });
    state = new WrapperState();
    bindRun(state);
    sendToIngest = vi.fn();
    state.setSendToIngestFn(sendToIngest);
    closeConnections = vi.fn().mockResolvedValue(undefined);
    drainSession = vi.fn();
    abortSession = vi.fn().mockResolvedValue(true);
    manager = createLifecycleManager(
      { workspacePath: '/workspace' },
      {
        state,
        kiloClient: createKiloClient({ drainSession, abortSession }),
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

  it('seals exact admitted membership only after the drain resolves true', async () => {
    state.acceptMessage('message-1', messageConfig);
    state.acceptMessage('message-2', messageConfig);
    const drain = deferred<boolean>();
    drainSession.mockReturnValueOnce(drain.promise);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(2_999);

    expect(eventsOfType('wrapper_finalizing')).toHaveLength(0);

    drain.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(eventsOfType('wrapper_finalizing')).toHaveLength(1);
    const complete = eventsOfType('complete');
    expect(complete).toHaveLength(1);
    expect(complete[0].data).toMatchObject({
      exitCode: 0,
      kiloSessionId: 'kilo_session',
      messageIds: ['message-1', 'message-2'],
    });
  });

  it('passes the admitted user-message identity to the post-completion auto-commit', async () => {
    state.acceptMessage('message-1', { autoCommit: false, condenseOnComplete: false });
    state.acceptMessage('message-2', { autoCommit: true, condenseOnComplete: false });
    state.setLastAssistantMessageId('assistant-2');

    manager.triggerDrainAndClose();
    await vi.advanceTimersByTimeAsync(300);

    expect(vi.mocked(runAutoCommit)).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'assistant-2',
        userMessageId: 'message-2',
      })
    );
  });

  it('aborts the wait on root activity and requires a later root idle', async () => {
    state.acceptMessage('message-1', messageConfig);
    const first = deferred<boolean>();
    drainSession.mockReturnValueOnce(first.promise).mockResolvedValueOnce(true);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(drainSession).toHaveBeenCalledTimes(1);

    manager.onRootSessionActivity();
    expect((drainSession.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(eventsOfType('wrapper_finalizing')).toHaveLength(0);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(0);

    expect(eventsOfType('wrapper_finalizing')).toHaveLength(1);

    first.resolve(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(eventsOfType('complete')).toHaveLength(1);
  });

  it('keeps repeated root idle on the single in-flight drain', async () => {
    state.acceptMessage('message-1', messageConfig);
    const drain = deferred<boolean>();
    drainSession.mockReturnValueOnce(drain.promise);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(1_000);
    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(0);

    expect(drainSession).toHaveBeenCalledTimes(1);

    drain.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(eventsOfType('wrapper_finalizing')).toHaveLength(1);
    expect(eventsOfType('complete')).toHaveLength(1);
  });

  it('does not start a drain while a delivery acknowledgement is in flight', async () => {
    state.acceptMessage('message-1', messageConfig);
    state.beginDeliveryAcknowledgement();
    const drain = deferred<boolean>();
    drainSession.mockReturnValueOnce(drain.promise);

    manager.onSessionIdle();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(drainSession).not.toHaveBeenCalled();
    expect(eventsOfType('wrapper_finalizing')).toHaveLength(0);

    state.endDeliveryAcknowledgement();
    manager.onDeliveryAcknowledged('sync-command');
    await vi.advanceTimersByTimeAsync(0);

    expect(drainSession).toHaveBeenCalledTimes(1);

    drain.resolve(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(eventsOfType('wrapper_finalizing')).toHaveLength(1);
    expect(eventsOfType('complete')).toHaveLength(1);
  });

  it('blocks admissions immediately when drain starts without a sealed batch', () => {
    state.clearAllMessages();

    manager.triggerDrainAndClose();

    expect(state.beginDeliveryAcknowledgement()).toBe(false);
    expect(state.isFinalizing).toBe(false);
  });
});
