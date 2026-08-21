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

    let closeCalls = 0;
    const lifecycle = createLifecycleManager(
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

    state.acceptMessage('message-1', {
      autoCommit: false,
      condenseOnComplete: false,
    });
    state.clearAllMessages();
    lifecycle.setAborted();
    lifecycle.triggerDrainAndClose();

    lifecycle.reset();
    state.acceptMessage('message-2', {
      autoCommit: false,
      condenseOnComplete: false,
    });
    await wait(300);
    expect(closeCalls).toBe(0);

    lifecycle.onSessionIdle();
    await wait(3_050);

    expect(events.map(event => event.streamEventType)).toContain('complete');
  });

  it('does not complete, close, or clear a session when reset interrupts an active drain', async () => {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    let closeCalls = 0;
    state.bindSession(sessionContext);
    state.setSendToIngestFn(event => events.push(event));
    const lifecycle = createLifecycleManager(
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

    state.acceptMessage('message-1', { autoCommit: false, condenseOnComplete: false });
    state.clearAllMessages();
    const drain = lifecycle.drainAndClose();
    expect(events.map(event => event.streamEventType)).toContain('wrapper_finalizing');

    lifecycle.reset();
    await drain;

    expect(events.map(event => event.streamEventType)).not.toContain('complete');
    expect(closeCalls).toBe(0);
    expect(state.currentSession).toEqual(sessionContext);
  });

  it('waits for three seconds of stable root idle before completing', async () => {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    state.bindSession(sessionContext);
    state.setSendToIngestFn(event => events.push(event));
    state.acceptMessage('message-1', {
      autoCommit: false,
      condenseOnComplete: false,
    });
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

    lifecycle.onSessionIdle();
    await wait(2_950);
    expect(events.map(event => event.streamEventType)).not.toContain('complete');

    await wait(150);
    expect(events.map(event => event.streamEventType)).toContain('complete');
  });

  it('requires a fresh stable idle interval after root activity', async () => {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    state.bindSession(sessionContext);
    state.setSendToIngestFn(event => events.push(event));
    state.acceptMessage('message-1', {
      autoCommit: false,
      condenseOnComplete: false,
    });
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

    lifecycle.onSessionIdle();
    await wait(2_900);
    lifecycle.onRootSessionActivity();

    await wait(200);
    expect(events.map(event => event.streamEventType)).not.toContain('complete');

    lifecycle.onSessionIdle();
    await wait(2_900);
    expect(events.map(event => event.streamEventType)).not.toContain('complete');

    await wait(500);
    expect(events.filter(event => event.streamEventType === 'complete')).toHaveLength(1);
  }, 10_000);
});
