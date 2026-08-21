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
    state.clearAllMessages();
    lifecycle.setAborted();
    lifecycle.triggerDrainAndClose();

    lifecycle.reset();
    state.acceptMessage('message-2', {
      autoCommit: false,
      condenseOnComplete: false,
    });
    await wait(300);

    lifecycle.onSessionIdle();
    await wait(3_050);

    expect(events.map(event => event.streamEventType)).toContain('complete');
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

  it('delays close longer when aborted while disconnected to allow reconnect delivery', async () => {
    const state = new WrapperState();
    state.bindSession(sessionContext);
    state.setSendToIngestFn(() => {});

    let closed = false;
    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        closeConnections: async () => {
          closed = true;
        },
        isConnected: () => false,
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

    await wait(500);
    expect(closed).toBe(false);

    await wait(2_000);
    expect(closed).toBe(true);
  }, 10_000);

  it('closes immediately when reconnect restores during aborted drain', async () => {
    const state = new WrapperState();
    state.bindSession(sessionContext);
    state.setSendToIngestFn(() => {});

    let closeCount = 0;
    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        closeConnections: async () => {
          closeCount++;
        },
        isConnected: () => false,
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

    await wait(300);
    expect(closeCount).toBe(0);

    lifecycle.onConnectionRestored();

    await wait(100);
    expect(closeCount).toBe(1);

    await wait(2_000);
    expect(closeCount).toBe(1);
  }, 10_000);

  it('defers close while reconnecting during aborted drain until reconnect gives up', async () => {
    const state = new WrapperState();
    state.bindSession(sessionContext);
    state.setSendToIngestFn(() => {});

    let closed = false;
    let reconnecting = true;
    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: {} as WrapperKiloClient,
        closeConnections: async () => {
          closed = true;
        },
        isConnected: () => false,
        isReconnecting: () => reconnecting,
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

    // Past the 2-second fallback ceiling the close is still deferred because a
    // reconnect is in progress with a buffered terminal frame.
    await wait(2_500);
    expect(closed).toBe(false);

    // Once the reconnect gives up the next poll closes.
    reconnecting = false;
    await wait(500);
    expect(closed).toBe(true);
  }, 10_000);
});
