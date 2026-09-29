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

function drainClient(drainSession: WrapperKiloClient['drainSession']): WrapperKiloClient {
  return {
    drainSession,
    abortSession: async () => true,
  } as unknown as WrapperKiloClient;
}

/**
 * `finalizeDrain` probes the workspace branch with a git subprocess, so a fixed
 * short wait races that spawn. Poll for the event instead of assuming it lands
 * inside the wait.
 */
async function waitForStreamEvent(
  events: IngestEvent[],
  streamEventType: IngestEvent['streamEventType'],
  timeoutMs = 10_000
): Promise<void> {
  const start = Date.now();
  while (!events.some(event => event.streamEventType === streamEventType)) {
    if (Date.now() - start > timeoutMs) return;
    await wait(25);
  }
}

describe('wrapper lifecycle drain races', () => {
  it('clears aborted state when reset interrupts a drain and completes on a new drain', async () => {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    state.bindSession(sessionContext);
    state.setSendToIngestFn(event => events.push(event));

    let closeCalls = 0;
    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: drainClient(async () => true),
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
    await waitForStreamEvent(events, 'complete');
    expect(events.map(event => event.streamEventType)).toContain('complete');
  }, 15_000);

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
        kiloClient: drainClient(async () => true),
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

  it('does not complete until the drain resolves true', async () => {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    state.bindSession(sessionContext);
    state.setSendToIngestFn(event => events.push(event));
    state.acceptMessage('message-1', {
      autoCommit: false,
      condenseOnComplete: false,
    });
    let resolveDrain: ((value: boolean) => void) | undefined;
    const pendingDrain = new Promise<boolean>(resolve => {
      resolveDrain = resolve;
    });
    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: drainClient(() => pendingDrain),
        closeConnections: async () => {},
        isConnected: () => true,
        reconnectEventSubscription: () => {},
      }
    );

    lifecycle.onSessionIdle();
    await wait(300);
    expect(events.map(event => event.streamEventType)).not.toContain('complete');

    if (!resolveDrain) throw new Error('Expected the drain to be pending');
    resolveDrain(true);
    await waitForStreamEvent(events, 'complete');
    expect(events.map(event => event.streamEventType)).toContain('complete');
  }, 15_000);

  it('requires a fresh drain after root activity', async () => {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    state.bindSession(sessionContext);
    state.setSendToIngestFn(event => events.push(event));
    state.acceptMessage('message-1', {
      autoCommit: false,
      condenseOnComplete: false,
    });

    let drainCalls = 0;
    let resolveFirst: ((value: boolean) => void) | undefined;
    const client = drainClient(() => {
      drainCalls += 1;
      if (drainCalls === 1) {
        return new Promise<boolean>(resolve => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(true);
    });
    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient: client,
        closeConnections: async () => {},
        isConnected: () => true,
        reconnectEventSubscription: () => {},
      }
    );

    lifecycle.onSessionIdle();
    await wait(100);
    lifecycle.onRootSessionActivity();

    await wait(300);
    expect(events.map(event => event.streamEventType)).not.toContain('complete');

    lifecycle.onSessionIdle();
    await waitForStreamEvent(events, 'complete');
    expect(drainCalls).toBe(2);

    resolveFirst?.(true);
    await wait(100);
    expect(events.filter(event => event.streamEventType === 'complete')).toHaveLength(1);
  }, 20_000);
});
