import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAutoCommit } from '../../../wrapper/src/auto-commit.js';
import { runCondenseOnComplete } from '../../../wrapper/src/condense-on-complete.js';
import { createLifecycleManager } from '../../../wrapper/src/lifecycle.js';
import { DrainSessionError, type WrapperKiloClient } from '../../../wrapper/src/kilo-api.js';
import { logToFile } from '../../../wrapper/src/utils.js';
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

const config = { autoCommit: false, condenseOnComplete: false };

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

function eventsOfType(sendToIngest: ReturnType<typeof vi.fn>, kind: string): IngestEvent[] {
  return sendToIngest.mock.calls
    .map(([event]: [IngestEvent]) => event)
    .filter((event: IngestEvent) => event.streamEventType === kind);
}

type Harness = {
  state: WrapperState;
  sendToIngest: ReturnType<typeof vi.fn>;
  closeConnections: ReturnType<typeof vi.fn>;
  drainSession: ReturnType<typeof vi.fn>;
  abortSession: ReturnType<typeof vi.fn>;
  setConnected: (value: boolean) => void;
  manager: ReturnType<typeof createLifecycleManager>;
  finalizing: () => IngestEvent[];
  complete: () => IngestEvent[];
  errors: () => IngestEvent[];
};

function createHarness(): Harness {
  const state = new WrapperState();
  state.bindSession({
    kiloSessionId: 'kilo_session',
    ingestUrl: 'ws://worker.test/ingest',
    workerAuthToken: 'worker-token',
    wrapperRunId: 'run_1',
    wrapperGeneration: 1,
    wrapperConnectionId: 'connection_1',
  });
  const sendToIngest = vi.fn();
  state.setSendToIngestFn(sendToIngest);
  const closeConnections = vi.fn().mockResolvedValue(undefined);
  const drainSession = vi.fn();
  const abortSession = vi.fn().mockResolvedValue(true);
  let connected = true;
  const manager = createLifecycleManager(
    { workspacePath: '/workspace' },
    {
      state,
      kiloClient: {
        drainSession,
        abortSession,
        serverUrl: 'http://127.0.0.1:0',
      } as unknown as WrapperKiloClient,
      closeConnections,
      isConnected: () => connected,
      reconnectEventSubscription: vi.fn(),
    }
  );
  return {
    state,
    sendToIngest,
    closeConnections,
    drainSession,
    abortSession,
    setConnected: value => {
      connected = value;
    },
    manager,
    finalizing: () => eventsOfType(sendToIngest, 'wrapper_finalizing'),
    complete: () => eventsOfType(sendToIngest, 'complete'),
    errors: () => eventsOfType(sendToIngest, 'error'),
  };
}

describe('wrapper drain-based completion', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runAutoCommit).mockReset();
    vi.mocked(runAutoCommit).mockResolvedValue({ success: true });
    vi.mocked(runCondenseOnComplete).mockReset();
    vi.mocked(runCondenseOnComplete).mockResolvedValue({ wasAborted: false, success: true });
    vi.mocked(logToFile).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not complete while the drain is unresolved after root idle', async () => {
    const h = createHarness();
    const drain = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(drain.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.drainSession).toHaveBeenCalledTimes(1);
    expect(h.sendToIngest).not.toHaveBeenCalled();
    expect(h.closeConnections).not.toHaveBeenCalled();

    drain.resolve(true);
    await flush();
    h.manager.stop();
  });

  it('seals finalizing then complete with branch and observed gate result on drain true', async () => {
    const h = createHarness();
    h.drainSession.mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', config);
    h.state.acceptMessage('message-2', config);
    h.state.observeGateResult('fail');

    h.manager.onSessionIdle();
    await flush();

    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    expect(h.complete()[0].data).toMatchObject({
      exitCode: 0,
      kiloSessionId: 'kilo_session',
      messageIds: ['message-1', 'message-2'],
      currentBranch: 'main',
      gateResult: 'fail',
    });
    expect(h.closeConnections).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    h.manager.stop();
  });

  it('fails a connected drain that returns false with one fatal error and no complete', async () => {
    const h = createHarness();
    h.drainSession.mockResolvedValueOnce(false);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();

    expect(h.errors()).toHaveLength(1);
    expect(h.errors()[0].data).toEqual({ error: 'Session drain returned false', fatal: true });
    expect(h.finalizing()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);
    expect(h.abortSession).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    h.manager.stop();
  });

  it('fails a connected drain that throws with the transport message', async () => {
    const h = createHarness();
    h.drainSession.mockRejectedValueOnce(new Error('socket exploded'));
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();

    expect(h.errors()).toHaveLength(1);
    expect(h.errors()[0].data).toEqual({
      error: 'Session drain failed: socket exploded',
      fatal: true,
    });
    expect(h.complete()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    h.manager.stop();
  });

  it('leaves a quiet pending first drain past 15 minutes then seals once on a later true', async () => {
    const h = createHarness();
    const drain = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(drain.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);

    expect(h.errors()).toHaveLength(0);
    expect(h.abortSession).not.toHaveBeenCalled();
    expect(h.closeConnections).not.toHaveBeenCalled();
    expect(h.complete()).toHaveLength(0);

    drain.resolve(true);
    await flush();
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('leaves a quiet pending retry past 15 minutes then seals once on a later true', async () => {
    const h = createHarness();
    const retry = deferred<boolean>();
    h.drainSession
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockReturnValueOnce(retry.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(h.errors()).toHaveLength(0);
    expect(h.abortSession).not.toHaveBeenCalled();
    expect(h.complete()).toHaveLength(0);

    retry.resolve(true);
    await flush();
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('keeps a disconnected transient under the limit silent and does not abort', async () => {
    const h = createHarness();
    h.setConnected(false);
    const retry = deferred<boolean>();
    h.drainSession
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockReturnValueOnce(retry.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    h.setConnected(true);
    h.manager.onConnectionRestored();
    await flush();

    expect(h.errors()).toHaveLength(0);
    expect(h.abortSession).not.toHaveBeenCalled();
    expect(h.complete()).toHaveLength(0);

    retry.resolve(true);
    await flush();
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('emits one fatal on restore for a disconnected definitive 404', async () => {
    const h = createHarness();
    h.setConnected(false);
    h.drainSession.mockRejectedValueOnce(
      new DrainSessionError('definitive', 'HTTP 404', { status: 404 })
    );
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    expect(h.sendToIngest).not.toHaveBeenCalled();

    h.manager.onConnectionRestored();
    await flush();

    expect(h.errors()).toHaveLength(1);
    expect(h.errors()[0].data).toEqual({ error: 'Session drain failed: HTTP 404', fatal: true });
    expect(h.complete()).toHaveLength(0);
    expect(h.abortSession).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    h.manager.stop();
  });

  it('emits one fatal on restore for a disconnected three-fast-503 burst with no fourth call', async () => {
    const h = createHarness();
    h.setConnected(false);
    h.drainSession.mockRejectedValue(
      new DrainSessionError('transient', 'HTTP 503', { status: 503 })
    );
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(h.drainSession).toHaveBeenCalledTimes(3);
    expect(vi.mocked(logToFile)).toHaveBeenCalledWith(
      expect.stringContaining('drain-transient-limit')
    );
    expect(h.sendToIngest).not.toHaveBeenCalled();
    expect(h.abortSession).toHaveBeenCalledOnce();

    h.setConnected(true);
    h.manager.onConnectionRestored();
    await flush();

    expect(h.errors()).toHaveLength(1);
    expect(h.errors()[0].data).toEqual({ error: 'Session drain failed: HTTP 503', fatal: true });
    expect(h.complete()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.drainSession).toHaveBeenCalledTimes(3);
    h.manager.stop();
  });

  it('adds no call and shortens no delay during backoff on idle, restore, or a failed ack', async () => {
    const h = createHarness();
    const retry = deferred<boolean>();
    h.drainSession
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockReturnValueOnce(retry.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    h.manager.onSessionIdle();
    h.manager.onConnectionRestored();
    h.manager.onDeliveryAcknowledged('failed');

    await vi.advanceTimersByTimeAsync(999);
    expect(h.drainSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.drainSession).toHaveBeenCalledTimes(2);

    retry.resolve(true);
    await flush();
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it.each([
    ['root activity', (h: Harness) => h.manager.onRootSessionActivity()],
    ['async-prompt ack', (h: Harness) => h.manager.onDeliveryAcknowledged('async-prompt')],
    ['setAborted', (h: Harness) => h.manager.setAborted()],
    ['stop', (h: Harness) => h.manager.stop()],
    ['reset', (h: Harness) => h.manager.reset()],
  ])('aborts a backoff retry on %s and a later true does not complete', async (_name, act) => {
    const h = createHarness();
    const late = deferred<boolean>();
    h.drainSession
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockReturnValueOnce(late.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);

    act(h);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.drainSession).toHaveBeenCalledTimes(1);

    late.resolve(true);
    await flush();
    expect(h.finalizing()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);
  });

  it('invalidates a backoff retry on a sync-command ack and starts one fresh drain', async () => {
    const h = createHarness();
    const fresh = deferred<boolean>();
    h.drainSession
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockReturnValueOnce(fresh.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    h.manager.onDeliveryAcknowledged('sync-command');
    await flush();

    expect(h.drainSession).toHaveBeenCalledTimes(2);
    fresh.resolve(true);
    await flush();
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('does not carry two fast failures into an immediate fatal after a slow transient', async () => {
    const h = createHarness();
    const slow = deferred<boolean>();
    const last = deferred<boolean>();
    h.drainSession
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockRejectedValueOnce(new DrainSessionError('transient', 'HTTP 503', { status: 503 }))
      .mockReturnValueOnce(slow.promise)
      .mockReturnValueOnce(last.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.drainSession).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(30_000);
    slow.reject(new DrainSessionError('transient', 'HTTP 503', { status: 503 }));
    await flush();
    expect(h.errors()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.drainSession).toHaveBeenCalledTimes(4);
    last.resolve(true);
    await flush();
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('aborts the in-flight drain without waiting and without completing', async () => {
    const h = createHarness();
    const drain = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(drain.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();

    h.manager.setAborted();
    const signal = h.drainSession.mock.calls[0][0].signal as AbortSignal;
    expect(signal.aborted).toBe(true);
    h.manager.triggerDrainAndClose();

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    expect(h.complete()).toHaveLength(0);
    expect(h.errors()).toHaveLength(0);
    expect(h.abortSession).not.toHaveBeenCalled();

    drain.resolve(true);
    await flush();
    expect(h.finalizing()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);
    expect(h.errors()).toHaveLength(0);
    h.manager.stop();
  });

  it('suppresses complete when abort arrives after the drain seal', async () => {
    const h = createHarness();
    let resolveAutoCommit: ((result: { success: boolean }) => void) | undefined;
    vi.mocked(runAutoCommit).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAutoCommit = resolve;
        })
    );
    h.drainSession.mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', { ...config, autoCommit: true });

    h.manager.onSessionIdle();
    await flush();

    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(0);

    h.manager.setAborted();
    resolveAutoCommit?.({ success: true });
    await flush();

    expect(h.complete()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    expect(h.state.currentSession).toBeNull();
    h.manager.stop();
  });

  it('starts one drain after a failed acknowledgement that carried the idle hint', async () => {
    const h = createHarness();
    h.drainSession.mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', config);
    expect(h.state.beginDeliveryAcknowledgement()).toBe(true);

    h.manager.onSessionIdle();
    await flush();
    await vi.advanceTimersByTimeAsync(3_000);

    expect(h.drainSession).not.toHaveBeenCalled();
    expect(h.finalizing()).toHaveLength(0);

    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('failed');
    await flush();

    expect(h.drainSession).toHaveBeenCalledTimes(1);
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('aborts the wait on root activity and does not start a second call for repeated idle', async () => {
    const h = createHarness();
    const first = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(first.promise).mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);

    h.manager.onRootSessionActivity();
    expect((h.drainSession.mock.calls[0][0].signal as AbortSignal).aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.finalizing()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);

    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(2);
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);

    first.resolve(true);
    await flush();
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('defers a disconnected drain true and seals once on connection restore', async () => {
    const h = createHarness();
    h.setConnected(false);
    h.drainSession.mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();

    expect(h.state.isFinalizing).toBe(false);
    expect(h.state.admissionsBlocked).toBe(false);
    expect(h.finalizing()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);

    h.manager.onConnectionRestored();
    await flush();
    expect(h.state.isFinalizing).toBe(false);
    expect(h.finalizing()).toHaveLength(0);

    h.setConnected(true);
    h.manager.onConnectionRestored();
    await flush();

    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    expect(h.drainSession).toHaveBeenCalledTimes(1);
    h.manager.stop();
  });

  it('does not emit or close on a disconnected drain failure until restore', async () => {
    const h = createHarness();
    h.setConnected(false);
    h.drainSession.mockResolvedValueOnce(false);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();

    expect(h.sendToIngest).not.toHaveBeenCalled();
    expect(h.closeConnections).not.toHaveBeenCalled();
    expect(h.state.isFinalizing).toBe(false);

    h.manager.onConnectionRestored();
    await flush();

    expect(h.errors()).toHaveLength(1);
    expect(h.errors()[0].data).toEqual({ error: 'Session drain returned false', fatal: true });
    expect(h.finalizing()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    h.manager.stop();
  });

  it('does not emit or close on a disconnected drain throw until restore', async () => {
    const h = createHarness();
    h.setConnected(false);
    h.drainSession.mockRejectedValueOnce(new Error('offline'));
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();

    expect(h.sendToIngest).not.toHaveBeenCalled();
    expect(h.closeConnections).not.toHaveBeenCalled();

    h.manager.onConnectionRestored();
    await flush();

    expect(h.errors()).toHaveLength(1);
    expect(h.errors()[0].data).toEqual({ error: 'Session drain failed: offline', fatal: true });
    expect(h.complete()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    h.manager.stop();
  });

  it('remembers a drain true during an in-flight ack and completes on a failed ack', async () => {
    const h = createHarness();
    const drain = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(drain.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    expect(h.state.beginDeliveryAcknowledgement()).toBe(true);

    drain.resolve(true);
    await flush();
    expect(h.state.isFinalizing).toBe(false);
    expect(h.finalizing()).toHaveLength(0);

    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);

    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('failed');
    await flush();

    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('holds an ack-time drain true until restore when disconnected at the failed ack', async () => {
    const h = createHarness();
    const drain = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(drain.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    h.state.beginDeliveryAcknowledgement();
    drain.resolve(true);
    await flush();

    h.state.endDeliveryAcknowledgement();
    h.setConnected(false);
    h.manager.onDeliveryAcknowledged('failed');
    await flush();

    expect(h.state.isFinalizing).toBe(false);
    expect(h.finalizing()).toHaveLength(0);

    h.setConnected(true);
    h.manager.onConnectionRestored();
    await flush();

    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('invalidates an ack-time drain true on a successful async prompt and drains again when idle was observed', async () => {
    const h = createHarness();
    const first = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(first.promise).mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    h.state.beginDeliveryAcknowledgement();
    h.manager.onSessionIdle();
    await flush();

    first.resolve(true);
    await flush();
    expect(h.state.isFinalizing).toBe(false);

    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('async-prompt');
    await flush();

    expect(h.drainSession).toHaveBeenCalledTimes(2);
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('does not drain again after a successful async prompt unless idle was observed', async () => {
    const h = createHarness();
    const first = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(first.promise);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    h.state.beginDeliveryAcknowledgement();
    first.resolve(true);
    await flush();

    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('async-prompt');
    await flush();

    expect(h.drainSession).toHaveBeenCalledTimes(1);
    expect(h.finalizing()).toHaveLength(0);

    h.drainSession.mockResolvedValueOnce(true);
    h.manager.onSessionIdle();
    await flush();

    expect(h.drainSession).toHaveBeenCalledTimes(2);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('consumes a disconnected drain true through the failed-ack path after restore no-ops on an active ack', async () => {
    const h = createHarness();
    h.setConnected(false);
    h.drainSession.mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    expect(h.state.isFinalizing).toBe(false);

    expect(h.state.beginDeliveryAcknowledgement()).toBe(true);
    h.setConnected(true);
    h.manager.onConnectionRestored();
    await flush();

    expect(h.state.isFinalizing).toBe(false);
    expect(h.finalizing()).toHaveLength(0);
    expect(h.complete()).toHaveLength(0);

    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('failed');
    await flush();

    expect(h.drainSession).toHaveBeenCalledTimes(1);
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('preserves idle observed during overlapping async-prompt acks and drains once on the last ack', async () => {
    const h = createHarness();
    const drain = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(drain.promise);
    h.state.acceptMessage('message-1', config);
    expect(h.state.beginDeliveryAcknowledgement()).toBe(true);
    expect(h.state.beginDeliveryAcknowledgement()).toBe(true);

    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).not.toHaveBeenCalled();

    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('async-prompt');
    await flush();
    expect(h.drainSession).not.toHaveBeenCalled();

    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('async-prompt');
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);

    drain.resolve(true);
    await flush();
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('does not start a drain on an async-prompt ack after a sync-command drain unless idle was observed', async () => {
    const h = createHarness();
    const first = deferred<boolean>();
    h.drainSession.mockReturnValueOnce(first.promise);
    h.state.acceptMessage('message-1', config);

    expect(h.state.beginDeliveryAcknowledgement()).toBe(true);
    h.manager.onSessionIdle();
    await flush();
    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('sync-command');
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);

    expect(h.state.beginDeliveryAcknowledgement()).toBe(true);
    h.state.endDeliveryAcknowledgement();
    h.manager.onDeliveryAcknowledged('async-prompt');
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);
    expect(h.finalizing()).toHaveLength(0);

    h.drainSession.mockResolvedValueOnce(true);
    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(2);
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });

  it('runs enabled post-processing only after drain true and closes after complete', async () => {
    const h = createHarness();
    const drain = deferred<boolean>();
    let resolveAutoCommit: ((result: { success: boolean }) => void) | undefined;
    vi.mocked(runAutoCommit).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAutoCommit = resolve;
        })
    );
    h.drainSession.mockReturnValueOnce(drain.promise);
    h.state.acceptMessage('message-1', { ...config, autoCommit: true });

    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);
    expect(runAutoCommit).not.toHaveBeenCalled();
    expect(h.finalizing()).toHaveLength(0);

    drain.resolve(true);
    await flush();
    expect(h.finalizing()).toHaveLength(1);
    expect(runAutoCommit).toHaveBeenCalledOnce();
    expect(h.complete()).toHaveLength(0);
    expect(h.closeConnections).not.toHaveBeenCalled();

    resolveAutoCommit?.({ success: true });
    await flush();
    expect(h.complete()).toHaveLength(1);
    expect(h.closeConnections).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(h.closeConnections).toHaveBeenCalledOnce();
    h.manager.stop();
  });

  it('does not start a second drain on idle after a disconnected drain true', async () => {
    const h = createHarness();
    h.setConnected(false);
    h.drainSession.mockResolvedValueOnce(true);
    h.state.acceptMessage('message-1', config);

    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);

    h.manager.onSessionIdle();
    await flush();
    expect(h.drainSession).toHaveBeenCalledTimes(1);
    expect(h.finalizing()).toHaveLength(0);

    h.setConnected(true);
    h.manager.onConnectionRestored();
    await flush();
    expect(h.finalizing()).toHaveLength(1);
    expect(h.complete()).toHaveLength(1);
    h.manager.stop();
  });
});
