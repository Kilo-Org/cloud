import { describe, expect, it } from 'vitest';

import { createLocalSessionCreateOrchestrator } from './use-local-session-create-orchestrator';
import { type LocalSessionCreateOrchestratorState } from './local-session-create-orchestrator-shared';
import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';
import { type CreateAndRunResult } from './local-session-create-effects';
import {
  type CreateAndRunSpy,
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

const HAPPY_RESULT: CreateAndRunResult = {
  status: 'ready',
  result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
};

const PROMPT_PARTIAL_RESULT: CreateAndRunResult = {
  status: 'ready',
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

const PARTIAL_INFO_MESSAGE =
  'The session was created, but the first prompt did not start. Retry from the session composer.';

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

function resolveOnce(spy: CreateAndRunSpy, value: CreateAndRunResult) {
  spy.mockResolvedValueOnce(value);
}

describe('useLocalSessionCreateOrchestrator — happy and partial paths', () => {
  it('happy ready path: createAndRun once, invalidate, capture analytics, success haptic, navigate', async () => {
    const { deps, trace, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockResolvedValue(HAPPY_RESULT);

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(createAndRunImpl).toHaveBeenCalledTimes(1);
    expect(trace.createAndRun[0]).toEqual({ fence: FENCE, requestId: REQUEST_ID_1 });
    expect(trace.invalidateCalls).toBe(1);
    expect(trace.captureEvent).toEqual([
      { name: 'session_created', properties: { surface: 'remote-session' } },
    ]);
    expect(trace.haptic).toEqual(['success']);
    expect(trace.navigate).toEqual([{ path: SESSION_DETAIL_PATH }]);
    expect(trace.showError).toEqual([]);
    expect(trace.showInfo).toEqual([]);
  });

  it('coalesces concurrent submits while a request is in flight', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    resolveOnce(createAndRunImpl, HAPPY_RESULT);

    const orchestrator = makeOrchestrator(deps);
    const first = orchestrator.submit();
    const second = orchestrator.submit();

    expect(createAndRunImpl).toHaveBeenCalledTimes(1);
    expect(orchestrator.getState().phase).toBe('submitting');
    await Promise.all([first, second]);
  });

  it('promptStarted:false ready: invalidates, fires fixed info toast, navigates; no analytics, no success haptic', async () => {
    const { deps, trace, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockResolvedValue(PROMPT_PARTIAL_RESULT);

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(createAndRunImpl).toHaveBeenCalledTimes(1);
    expect(trace.invalidateCalls).toBe(1);
    expect(trace.showInfo).toEqual([{ message: PARTIAL_INFO_MESSAGE }]);
    expect(trace.showError).toEqual([]);
    expect(trace.navigate).toEqual([{ path: SESSION_DETAIL_PATH }]);
    expect(trace.haptic).toEqual([]);
    expect(trace.captureEvent).toEqual([]);
  });

  it('promptStarted:false: invalidation runs before the navigate and the info toast', async () => {
    const { deps, trace, createAndRunImpl, invalidateCachesImpl } = makeDeps({
      requestIds: [REQUEST_ID_1],
    });
    createAndRunImpl.mockResolvedValue(PROMPT_PARTIAL_RESULT);
    const events: string[] = [];
    invalidateCachesImpl.mockImplementation(() => {
      events.push('invalidate');
    });
    deps.showInfo = message => {
      events.push(`info:${message}`);
    };
    deps.navigate = path => {
      events.push(`navigate:${path}`);
    };

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(events).toEqual([
      'invalidate',
      `info:${PARTIAL_INFO_MESSAGE}`,
      `navigate:${SESSION_DETAIL_PATH}`,
    ]);
    expect(trace.createAndRun).toHaveLength(1);
  });

  it('promptStarted:false where invalidation throws still navigates and surfaces the info toast', async () => {
    const { deps, trace, createAndRunImpl, invalidateCachesImpl } = makeDeps({
      requestIds: [REQUEST_ID_1],
    });
    createAndRunImpl.mockResolvedValue(PROMPT_PARTIAL_RESULT);
    invalidateCachesImpl.mockRejectedValueOnce(new Error('cache down'));
    const events: string[] = [];
    deps.showInfo = message => {
      events.push(`info:${message}`);
    };
    deps.navigate = path => {
      events.push(`navigate:${path}`);
    };

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(events).toEqual([`info:${PARTIAL_INFO_MESSAGE}`, `navigate:${SESSION_DETAIL_PATH}`]);
    expect(createAndRunImpl).toHaveBeenCalledTimes(1);
    expect(trace.showError).toEqual([]);
  });

  it('does not call createAndRun when validation fails before the mutation', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockResolvedValue(HAPPY_RESULT);

    const orchestrator = createLocalSessionCreateOrchestrator({
      deps,
      fence: FENCE,
      catalog: CATALOG,
      selectedAgentSlug: 'rogue-agent',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      getPrompt: () => 'hi',
    });
    await orchestrator.submit();

    expect(createAndRunImpl).not.toHaveBeenCalled();
    const state = orchestrator.getState();
    expect(state.phase).toBe('recovery');
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('catalog-changed');
  });
});

describe('useLocalSessionCreateOrchestrator — subscription contract', () => {
  it('replays the current state to a listener that subscribes after submit is in flight', () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    const pending = new Promise<CreateAndRunResult>(() => {
      // Intentionally never resolves so the test can observe the submitting state.
    });
    createAndRunImpl.mockReturnValue(pending);

    const orchestrator = makeOrchestrator(deps);
    void orchestrator.submit();

    const receivedStates: LocalSessionCreateOrchestratorState[] = [];
    const listener = (state: LocalSessionCreateOrchestratorState) => {
      receivedStates.push(state);
    };
    orchestrator.subscribe(listener);

    expect(receivedStates).toEqual([{ phase: 'submitting' }]);
  });

  it('replays the current state to a listener that subscribes while idle', () => {
    const { deps } = makeDeps({ requestIds: [REQUEST_ID_1] });
    const orchestrator = makeOrchestrator(deps);

    const receivedStates: LocalSessionCreateOrchestratorState[] = [];
    const listener = (state: LocalSessionCreateOrchestratorState) => {
      receivedStates.push(state);
    };
    orchestrator.subscribe(listener);

    expect(receivedStates).toEqual([{ phase: 'idle' }]);
  });
});
