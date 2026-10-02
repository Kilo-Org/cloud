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

/**
 * The stable-idle drain emits `complete` only after `finalizeDrain` probes the
 * workspace branch with a git subprocess, so a fixed short wait races that
 * spawn. Poll for the event instead of assuming it lands inside the wait.
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
    await waitForStreamEvent(events, 'complete');
    expect(events.map(event => event.streamEventType)).toContain('complete');
  }, 15_000);

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
    await waitForStreamEvent(events, 'complete');
    expect(events.filter(event => event.streamEventType === 'complete')).toHaveLength(1);
  }, 20_000);
});

describe('wrapper lifecycle publication self-check', () => {
  const agent = { mode: 'code', model: { modelID: 'kilo/test-model' }, variant: 'high' };

  function setup(options: { sendFails?: boolean } = {}) {
    const state = new WrapperState();
    const events: IngestEvent[] = [];
    const prompts: Array<{ prompt?: string; agent?: string }> = [];
    state.bindSession({ ...sessionContext, publicationSelfCheck: true });
    state.setSendToIngestFn(event => events.push(event));
    state.acceptMessage('message-1', { autoCommit: false, condenseOnComplete: false, agent });
    const kiloClient = {
      sendPromptAsync: async (opts: { prompt?: string; agent?: string }) => {
        if (options.sendFails) throw new Error('kilo unavailable');
        prompts.push(opts);
      },
    } as unknown as WrapperKiloClient;
    const lifecycle = createLifecycleManager(
      { workspacePath: '/tmp' },
      {
        state,
        kiloClient,
        closeConnections: async () => {},
        isConnected: () => true,
        reconnectEventSubscription: () => {},
      }
    );
    const types = () => events.map(event => event.streamEventType);
    return { state, events, prompts, lifecycle, types };
  }

  it('sends one self-check instead of sealing, then completes on the next stable idle', async () => {
    const { events, prompts, lifecycle, types } = setup();

    lifecycle.onSessionIdle();
    await wait(3_100);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.agent).toBe('code');
    expect(types()).not.toContain('wrapper_finalizing');

    // The self-check turn runs and goes idle like any other turn.
    lifecycle.onRootSessionActivity();
    lifecycle.onSessionIdle();
    await wait(3_100);
    await waitForStreamEvent(events, 'complete');
    expect(types()).toContain('complete');
    expect(prompts).toHaveLength(1);
  }, 15_000);

  it('seals without a self-check when the agent already wrote the summary', async () => {
    const { state, events, prompts, lifecycle, types } = setup();
    state.observeSummaryPublication();

    lifecycle.onSessionIdle();
    await wait(3_100);
    await waitForStreamEvent(events, 'complete');
    expect(types()).toContain('complete');
    expect(prompts).toHaveLength(0);
  }, 15_000);

  it('still completes the turn when the self-check cannot be sent', async () => {
    const { events, lifecycle, types } = setup({ sendFails: true });

    lifecycle.onSessionIdle();
    await wait(6_200);
    await waitForStreamEvent(events, 'complete');
    expect(events).toContainEqual(
      expect.objectContaining({
        streamEventType: 'error',
        data: { error: 'Publication self-check failed: kilo unavailable', fatal: false },
      })
    );
    expect(types()).toContain('complete');
  }, 20_000);
});
