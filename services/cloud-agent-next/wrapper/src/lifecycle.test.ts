import { describe, expect, it, jest } from 'bun:test';
import { WrapperState } from './state';
import { createLifecycleManager, PUBLICATION_RECOVERY_SUBMIT_TIMEOUT_MS } from './lifecycle';
import {
  assistantReportsNoActionableOutput,
  classifyPublicationToolPart,
  decidePublicationRecovery,
  messageInfoReportsOutputLimit,
} from './publication-recovery';
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
        isGitHubReviewPublicationInstalled: () => false,
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
        isGitHubReviewPublicationInstalled: () => false,
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
        isGitHubReviewPublicationInstalled: () => false,
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
        isGitHubReviewPublicationInstalled: () => false,
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

describe('decidePublicationRecovery', () => {
  const base = { configured: true, outputLimit: false, budgetUsed: false };

  it('seals when the tool is not configured or the turn hit its output limit', () => {
    expect(decidePublicationRecovery({ ...base, configured: false, signal: null })).toBe('seal');
    expect(decidePublicationRecovery({ ...base, outputLimit: true, signal: null })).toBe('seal');
  });

  it('seals on a verified result and on terminal tool errors', () => {
    expect(decidePublicationRecovery({ ...base, signal: { kind: 'verified', commentId: 5 } })).toBe(
      'seal'
    );
    for (const code of ['locked', 'rate_limited', 'scan_limit', 'forbidden', 'misconfigured']) {
      expect(decidePublicationRecovery({ ...base, signal: { kind: 'error', code } })).toBe('seal');
    }
  });

  it('prompts once for a rejected or unverified result and then seals', () => {
    expect(
      decidePublicationRecovery({ ...base, signal: { kind: 'error', code: 'rejected_body' } })
    ).toBe('prompt');
    expect(
      decidePublicationRecovery({ ...base, signal: { kind: 'error', code: 'unverified' } })
    ).toBe('prompt');
    expect(decidePublicationRecovery({ ...base, signal: null })).toBe('prompt');
    expect(
      decidePublicationRecovery({
        ...base,
        budgetUsed: true,
        signal: { kind: 'error', code: 'unverified' },
      })
    ).toBe('seal');
    expect(decidePublicationRecovery({ ...base, budgetUsed: true, signal: null })).toBe('seal');
  });
});

describe('classifyPublicationToolPart', () => {
  it('reads a verified result from the completed tool output', () => {
    expect(
      classifyPublicationToolPart({
        tool: 'code_review_publish_review_summary',
        state: {
          status: 'completed',
          output: JSON.stringify({ verified: true, commentId: 7, url: 'https://x' }),
        },
      })
    ).toEqual({ kind: 'verified', commentId: 7 });
  });

  it('reads the leading code from a tool error state', () => {
    expect(
      classifyPublicationToolPart({
        tool: 'code_review_publish_review_summary',
        state: { status: 'error', error: 'rate_limited: too many requests' },
      })
    ).toEqual({ kind: 'error', code: 'rate_limited' });
  });

  it('ignores other tools, the bare tool name, and unparseable output', () => {
    expect(
      classifyPublicationToolPart({ tool: 'bash', state: { status: 'completed', output: '{}' } })
    ).toBeNull();
    expect(
      classifyPublicationToolPart({
        tool: 'publish_review_summary',
        state: { status: 'completed', output: '{}' },
      })
    ).toBeNull();
    expect(
      classifyPublicationToolPart({
        tool: 'code_review_publish_review_summary',
        state: { status: 'completed', output: 'not json' },
      })
    ).toBeNull();
  });
});

describe('output-limit detection', () => {
  it('detects the structured MessageOutputLengthError on a root message', () => {
    expect(messageInfoReportsOutputLimit({ error: { name: 'MessageOutputLengthError' } })).toBe(
      true
    );
    expect(messageInfoReportsOutputLimit({ error: { name: 'ProviderAuthError' } })).toBe(false);
    expect(messageInfoReportsOutputLimit({ error: null })).toBe(false);
    expect(messageInfoReportsOutputLimit({})).toBe(false);
  });

  it('detects the exact two-fragment plaintext notice and ignores a single fragment', () => {
    expect(
      assistantReportsNoActionableOutput([
        { text: 'The task stopped: no actionable output because the output limit was reached.' },
      ])
    ).toBe(true);
    expect(assistantReportsNoActionableOutput([{ text: 'no actionable output reported' }])).toBe(
      false
    );
    expect(assistantReportsNoActionableOutput([{ text: 'the output limit was reached' }])).toBe(
      false
    );
    expect(
      assistantReportsNoActionableOutput([
        {
          type: 'reasoning',
          text: 'no actionable output because the output limit was reached',
        },
      ])
    ).toBe(false);
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function createRecoveryHarness(options: { abortDeferred?: boolean; submitFails?: boolean } = {}) {
  const state = new WrapperState();
  const events: IngestEvent[] = [];
  state.bindSession(sessionContext);
  state.setSendToIngestFn(event => events.push(event));
  state.acceptMessage('message-1', { autoCommit: false, condenseOnComplete: false });

  const messageIds: string[] = [];
  let sendCalls = 0;
  let abortCalls = 0;
  let resolveDeferredAbort: (() => void) | null = null;
  const client = {
    sendPromptAsync: (opts: { messageId?: string; signal?: AbortSignal }) => {
      sendCalls += 1;
      if (opts.messageId) messageIds.push(opts.messageId);
      if (options.submitFails) return Promise.reject(new Error('submit failed'));
      if (options.abortDeferred) {
        return new Promise<void>((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return Promise.resolve();
    },
    abortSession: () => {
      abortCalls += 1;
      if (options.abortDeferred) {
        return new Promise<void>(resolve => {
          resolveDeferredAbort = resolve;
        });
      }
      return Promise.resolve();
    },
  } as unknown as WrapperKiloClient;

  const lifecycle = createLifecycleManager(
    { workspacePath: '/tmp' },
    {
      state,
      kiloClient: client,
      closeConnections: async () => {},
      isConnected: () => true,
      reconnectEventSubscription: () => {},
      isGitHubReviewPublicationInstalled: () => true,
    }
  );

  return {
    state,
    events,
    lifecycle,
    messageIds,
    get sendCalls() {
      return sendCalls;
    },
    get abortCalls() {
      return abortCalls;
    },
    resolveDeferredAbort: () => resolveDeferredAbort?.(),
  };
}

async function triggerRecovery(harness: ReturnType<typeof createRecoveryHarness>): Promise<void> {
  harness.lifecycle.onSessionIdle();
  jest.advanceTimersByTime(3_000);
  await flushMicrotasks();
}

describe('publication recovery lifecycle', () => {
  it('a verified result seals without aborting the session or emitting an error', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness();
      await triggerRecovery(harness);
      expect(harness.sendCalls).toBe(1);

      harness.state.observePublicationSignal({ kind: 'verified', commentId: 5 });
      harness.lifecycle.onSessionIdle();
      jest.advanceTimersByTime(3_000);
      await flushMicrotasks();

      expect(harness.abortCalls).toBe(0);
      expect(harness.events.some(event => event.streamEventType === 'error')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a verified result that arrives during submit and does not prompt again', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness();
      await triggerRecovery(harness);
      harness.state.observePublicationSignal({ kind: 'verified', commentId: 6 });
      harness.lifecycle.onSessionIdle();
      jest.advanceTimersByTime(3_000);
      await flushMicrotasks();
      expect(harness.sendCalls).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses a Kilo-valid msg-prefixed id for the recovery prompt', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness();
      await triggerRecovery(harness);

      expect(harness.messageIds).toHaveLength(1);
      expect(harness.messageIds[0]?.startsWith('msg')).toBe(true);
      expect(harness.messageIds[0]?.startsWith('msg_recovery_')).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('superseding a deferred submit via a new message does not emit or abort the new turn', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness({ abortDeferred: true });
      await triggerRecovery(harness);
      expect(harness.sendCalls).toBe(1);

      harness.lifecycle.resetPublicationRecoveryBudget();
      harness.state.acceptMessage('message-new', {
        autoCommit: false,
        condenseOnComplete: false,
      });
      await flushMicrotasks();

      expect(harness.abortCalls).toBe(0);
      expect(harness.events.some(event => event.streamEventType === 'error')).toBe(false);
      expect(harness.events.map(event => event.streamEventType)).not.toContain(
        'wrapper_finalizing'
      );
      expect(harness.events.map(event => event.streamEventType)).not.toContain('complete');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a new message during a failed-submit bounded abort cannot finalize the new batch', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness({ submitFails: true, abortDeferred: true });
      await triggerRecovery(harness);
      expect(harness.sendCalls).toBe(1);
      expect(harness.abortCalls).toBe(1);

      harness.lifecycle.resetPublicationRecoveryBudget();
      harness.state.acceptMessage('message-new', {
        autoCommit: false,
        condenseOnComplete: false,
      });
      harness.resolveDeferredAbort();
      await flushMicrotasks();

      expect(harness.abortCalls).toBe(1);
      expect(harness.events.map(event => event.streamEventType)).not.toContain(
        'wrapper_finalizing'
      );
      expect(harness.events.map(event => event.streamEventType)).not.toContain('complete');
    } finally {
      jest.useRealTimers();
    }
  });

  it('a reset during a failed-submit bounded abort cannot finalize the new batch', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness({ submitFails: true, abortDeferred: true });
      await triggerRecovery(harness);
      expect(harness.abortCalls).toBe(1);

      harness.lifecycle.reset();
      harness.state.bindSession({
        ...sessionContext,
        kiloSessionId: 'kilo_sess_new',
        wrapperGeneration: 2,
        wrapperConnectionId: 'conn_2',
      });
      harness.state.acceptMessage('message-new', {
        autoCommit: false,
        condenseOnComplete: false,
      });
      harness.resolveDeferredAbort();
      await flushMicrotasks();

      expect(harness.events.map(event => event.streamEventType)).not.toContain(
        'wrapper_finalizing'
      );
      expect(harness.events.map(event => event.streamEventType)).not.toContain('complete');
    } finally {
      jest.useRealTimers();
    }
  });

  it('aborts a hung recovery submit at the submit bound and fails fast', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness({ abortDeferred: true });
      await triggerRecovery(harness);
      expect(harness.sendCalls).toBe(1);

      // The submit is still pending: it must not hold the batch open.
      expect(harness.abortCalls).toBe(0);
      expect(harness.events.map(event => event.streamEventType)).not.toContain(
        'wrapper_finalizing'
      );

      jest.advanceTimersByTime(PUBLICATION_RECOVERY_SUBMIT_TIMEOUT_MS);
      await flushMicrotasks();

      expect(harness.abortCalls).toBe(1);
      expect(harness.events.some(event => event.streamEventType === 'error')).toBe(true);

      harness.resolveDeferredAbort();
      await flushMicrotasks();

      expect(harness.events.map(event => event.streamEventType)).toContain('wrapper_finalizing');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not bound a productive post-delivery recovery turn', async () => {
    jest.useFakeTimers();
    try {
      const harness = createRecoveryHarness();
      await triggerRecovery(harness);
      expect(harness.sendCalls).toBe(1);

      // The submit resolved. A long productive turn must not be aborted or
      // sealed by any leftover submit bound.
      jest.advanceTimersByTime(PUBLICATION_RECOVERY_SUBMIT_TIMEOUT_MS * 10);
      await flushMicrotasks();

      expect(harness.abortCalls).toBe(0);
      expect(harness.events.some(event => event.streamEventType === 'error')).toBe(false);
      expect(harness.events.map(event => event.streamEventType)).not.toContain(
        'wrapper_finalizing'
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
