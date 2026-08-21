import { describe, expect, it } from 'bun:test';
import type { WrapperKiloClient } from './kilo-api';
import { createLifecycleManager } from './lifecycle';
import { abortKiloSessionForShutdown } from './shutdown';
import { WrapperState } from './state';
import type { IngestEvent } from '../../src/shared/protocol';

describe('abortKiloSessionForShutdown', () => {
  it('aborts the active Kilo session before draining and never emits complete', async () => {
    const events: IngestEvent[] = [];
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_test',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
    });
    state.setSendToIngestFn(event => events.push(event));
    state.acceptMessage('message-1', { autoCommit: false, condenseOnComplete: false });
    const calls: string[] = [];
    const lifecycleManager = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        closeConnections: async () => {
          calls.push('close');
        },
        isConnected: () => true,
        reconnectEventSubscription: () => {},
      }
    );
    const kiloClient: Pick<WrapperKiloClient, 'abortSession'> = {
      abortSession: async () => {
        calls.push('abort');
        return true;
      },
    };

    state.sendToIngest({
      streamEventType: 'interrupted',
      data: { reason: 'Container shutdown' },
      timestamp: new Date().toISOString(),
    });
    lifecycleManager.setAborted();
    const activeKiloSessionId = state.currentSession?.kiloSessionId;
    await abortKiloSessionForShutdown({ activeKiloSessionId, kiloClient });
    await lifecycleManager.drainAndClose();

    expect(calls).toEqual(['abort', 'close']);
    expect(events.map(event => event.streamEventType)).toEqual(['interrupted']);
    expect(state.currentSession).toBeNull();
  });

  it('does not complete a drain interrupted while final log upload is pending', async () => {
    const events: IngestEvent[] = [];
    const state = new WrapperState();
    state.bindSession({
      kiloSessionId: 'kilo_sess_test',
      ingestUrl: 'ws://worker.test/ingest',
      workerAuthToken: 'worker-token',
    });
    state.setSendToIngestFn(event => events.push(event));
    state.acceptMessage('message-1', { autoCommit: false, condenseOnComplete: false });

    let resolveUpload: (() => void) | undefined;
    let signalUploadStarted: (() => void) | undefined;
    const uploadStarted = new Promise<void>(resolve => {
      signalUploadStarted = resolve;
    });
    let uploaderStopped = false;
    state.setLogUploader({
      start: () => {},
      uploadNow: async () => {
        signalUploadStarted?.();
        await new Promise<void>(resolve => {
          resolveUpload = resolve;
        });
      },
      stop: () => {
        uploaderStopped = true;
      },
    });

    let closeCalls = 0;
    const lifecycleManager = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        closeConnections: async () => {
          closeCalls += 1;
        },
        isConnected: () => true,
        reconnectEventSubscription: () => {},
      }
    );

    const drain = lifecycleManager.drainAndClose();
    await uploadStarted;

    state.sendToIngest({
      streamEventType: 'interrupted',
      data: { reason: 'Container shutdown' },
      timestamp: new Date().toISOString(),
    });
    lifecycleManager.setAborted();
    if (!resolveUpload) throw new Error('Expected final log upload to be pending');
    resolveUpload();
    await drain;

    expect(events.map(event => event.streamEventType)).toEqual([
      'wrapper_finalizing',
      'interrupted',
    ]);
    expect(uploaderStopped).toBe(true);
    expect(closeCalls).toBe(1);
    expect(state.currentSession).toBeNull();
  });
});
