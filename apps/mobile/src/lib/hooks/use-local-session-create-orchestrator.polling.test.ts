import { describe, expect, it } from 'vitest';

import { createLocalSessionCreateOrchestrator } from './use-local-session-create-orchestrator';
import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';
import { type CreateAndRunResult } from './local-session-create-effects';
import {
  makeDeps,
  REQUEST_ID_1,
  SESSION_ID,
} from './use-local-session-create-orchestrator.test-harness';

const FENCE: LocalRuntimeFence = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
};

const CATALOG: LocalRuntimeCatalog = {
  protocolVersion: 1,
  defaultAgent: 'build',
  agents: [{ slug: 'build', name: 'Build' }],
  models: {
    protocolVersion: 1,
    providers: [
      {
        id: 'kilo',
        models: [{ id: 'claude-opus-4-7', variants: ['max', 'min'] }],
      },
    ],
    truncated: false,
  },
};

const NOT_READY_HAPPY: CreateAndRunResult = {
  status: 'session_not_ready',
  code: 'SESSION_NOT_READY',
  result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
};

const NOT_READY_PARTIAL: CreateAndRunResult = {
  status: 'session_not_ready',
  code: 'SESSION_NOT_READY',
  result: {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    promptStarted: false,
    error: {
      code: 'PROMPT_START_FAILED',
      message: 'The session was created, but the first prompt did not start.',
    },
  },
};

const SESSION_DETAIL_PATH = `/(app)/agent-chat/${SESSION_ID}`;

function makeOrchestrator(
  deps: ReturnType<typeof makeDeps>['deps'],
  fence: LocalRuntimeFence = FENCE
) {
  return createLocalSessionCreateOrchestrator({
    deps,
    fence,
    catalog: CATALOG,
    selectedAgentSlug: 'build',
    selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
    getPrompt: () => 'Build me a thing',
  });
}

describe('useLocalSessionCreateOrchestrator — polling and check-again', () => {
  it('session_not_ready + promptStarted:true: polls readiness up to budget, ready transitions to happy path', async () => {
    const { deps, trace, createAndRunImpl, pollReadinessImpl, sleepImpl } = makeDeps({
      requestIds: [REQUEST_ID_1],
    });
    createAndRunImpl.mockResolvedValue(NOT_READY_HAPPY);
    pollReadinessImpl
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'pending' })
      .mockResolvedValueOnce({ status: 'ready', organizationId: null });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(trace.pollReadiness).toEqual([
      { sessionId: SESSION_ID },
      { sessionId: SESSION_ID },
      { sessionId: SESSION_ID },
    ]);
    expect(sleepImpl).toHaveBeenCalled();
    expect(trace.invalidateCalls).toBe(1);
    expect(trace.navigate).toEqual([{ path: SESSION_DETAIL_PATH }]);
    expect(trace.haptic).toEqual(['success']);
  });

  it('session_not_ready + promptStarted:false: invalidates, info toast, navigates without polling', async () => {
    const { deps, trace, createAndRunImpl, pollReadinessImpl } = makeDeps({
      requestIds: [REQUEST_ID_1],
    });
    createAndRunImpl.mockResolvedValue(NOT_READY_PARTIAL);

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(createAndRunImpl).toHaveBeenCalledTimes(1);
    expect(pollReadinessImpl).not.toHaveBeenCalled();
    expect(trace.invalidateCalls).toBe(1);
    expect(trace.showInfo).toEqual([
      {
        message:
          'The session was created, but the first prompt did not start. Retry from the session composer.',
      },
    ]);
    expect(trace.navigate).toEqual([{ path: SESSION_DETAIL_PATH }]);
  });

  it('session_not_ready timeout: stores sessionId/requestId and exposes the Check again CTA only', async () => {
    const { deps, trace, createAndRunImpl, pollReadinessImpl, sleepImpl } = makeDeps({
      requestIds: [REQUEST_ID_1],
      pollMaxMs: 1500,
      pollIntervalMs: 500,
    });
    createAndRunImpl.mockResolvedValue(NOT_READY_HAPPY);
    pollReadinessImpl.mockResolvedValue({ status: 'pending' });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(pollReadinessImpl).toHaveBeenCalled();
    expect(sleepImpl).toHaveBeenCalled();
    expect(trace.invalidateCalls).toBe(0);
    expect(trace.navigate).toEqual([]);
    expect(trace.haptic).toEqual([]);
    expect(trace.captureEvent).toEqual([]);
    const state = orchestrator.getState();
    expect(state.phase).toBe('recovery');
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('readiness-timeout');
    expect(state.recovery.ctaLabel).toBe('Check again');
    expect(state.sessionId).toBe(SESSION_ID);
    expect(state.requestId).toBe(REQUEST_ID_1);
  });

  it('Check again only polls readiness, never creates a new session', async () => {
    const { deps, createAndRunImpl, pollReadinessImpl } = makeDeps({
      requestIds: [REQUEST_ID_1, REQUEST_ID_1],
      pollMaxMs: 1500,
      pollIntervalMs: 500,
    });
    createAndRunImpl.mockResolvedValueOnce(NOT_READY_HAPPY);
    pollReadinessImpl.mockResolvedValue({ status: 'pending' });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();
    expect(orchestrator.getState().phase).toBe('recovery');
    const createAndRunCallsBefore = createAndRunImpl.mock.calls.length;

    pollReadinessImpl.mockResolvedValueOnce({ status: 'ready', organizationId: null });
    await orchestrator.checkAgain();

    expect(createAndRunImpl.mock.calls.length).toBe(createAndRunCallsBefore);
  });

  it('uses a bounded attempt count derived from pollMaxMs / pollIntervalMs (30 attempts at default budget)', async () => {
    const { deps, createAndRunImpl, pollReadinessImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockResolvedValue(NOT_READY_HAPPY);
    pollReadinessImpl.mockResolvedValue({ status: 'pending' });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(pollReadinessImpl.mock.calls.length).toBeLessThanOrEqual(30);
  });
});
