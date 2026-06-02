import { describe, expect, it } from 'bun:test';
import { WrapperState } from './state';
import { createLifecycleManager } from './lifecycle';
import type { IngestEvent } from '../../src/shared/protocol';
import type { WrapperKiloClient } from './kilo-api';

const sessionContext = {
  kiloSessionId: 'kilo_sess_test',
  ingestUrl: 'ws://worker.test/ingest',
  workerAuthToken: 'worker-token',
  wrapperRunId: 'run_1',
  wrapperGeneration: 1,
  wrapperConnectionId: 'conn_1',
  agentSessionId: 'agent_00000000-0000-0000-0000-000000000000',
};

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('wrapper lifecycle drain races', () => {
  it('clears aborted state when activity cancels an aborted drain', async () => {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    state.bindSession(sessionContext);
    state.setSendToIngestFn(event => events.push(event));

    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        closeConnections: async () => {},
        isConnected: () => true,
        reconnectEventSubscription: () => {},
      }
    );

    state.acceptMessage('message-1', {
      autoCommit: false,
      condenseOnComplete: false,
    });
    lifecycle.setAborted();
    state.clearAllMessages();
    lifecycle.triggerDrainAndClose();

    state.acceptMessage('message-2', {
      autoCommit: false,
      condenseOnComplete: false,
    });
    await wait(300);

    lifecycle.onMessageComplete('message-2');
    lifecycle.onSessionIdle();
    await wait(50);

    expect(events.map(event => event.streamEventType)).toContain('complete');
  });
});
