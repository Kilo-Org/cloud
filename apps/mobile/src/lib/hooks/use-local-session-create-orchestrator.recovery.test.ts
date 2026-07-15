import { describe, expect, it } from 'vitest';

import { createLocalSessionCreateOrchestrator } from './use-local-session-create-orchestrator';
import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';
import { type CreateAndRunResult } from './local-session-create-effects';
import {
  makeDeps,
  REQUEST_ID_1,
  REQUEST_ID_2,
  SESSION_ID,
} from './use-local-session-create-orchestrator.test-harness';

const FENCE: LocalRuntimeFence = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
};
const FENCE_NEW: LocalRuntimeFence = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a-new',
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

function makeOrchestrator(
  deps: ReturnType<typeof makeDeps>['deps'],
  fence: LocalRuntimeFence = FENCE,
  getPrompt: () => string = () => 'Build me a thing'
) {
  return createLocalSessionCreateOrchestrator({
    deps,
    fence,
    catalog: CATALOG,
    selectedAgentSlug: 'build',
    selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
    getPrompt,
  });
}

describe('useLocalSessionCreateOrchestrator — recovery, retry, fence-change', () => {
  it('fence change (new connectionId) clears the requestId; the next fence allocates a new UUID', async () => {
    const { deps, trace, createAndRunImpl } = makeDeps({
      requestIds: [REQUEST_ID_1, REQUEST_ID_2],
    });
    createAndRunImpl.mockResolvedValue(HAPPY_RESULT);

    const orchestrator = makeOrchestrator(deps, FENCE);
    await orchestrator.submit();
    expect(trace.createAndRun[0]).toEqual({ fence: FENCE, requestId: REQUEST_ID_1 });

    const next = makeOrchestrator(deps, FENCE_NEW);
    await next.submit();
    expect(trace.createAndRun[1]).toEqual({ fence: FENCE_NEW, requestId: REQUEST_ID_2 });
  });

  it('retry after a transient rejection reuses the original requestId', async () => {
    const { deps, trace, createAndRunImpl } = makeDeps({
      requestIds: [REQUEST_ID_1, REQUEST_ID_2],
    });
    createAndRunImpl
      .mockRejectedValueOnce({ data: { upstreamCode: 'COMMAND_EXPIRED' } })
      .mockResolvedValueOnce(HAPPY_RESULT);

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();
    expect(orchestrator.getState().phase).toBe('recovery');

    await orchestrator.retry();
    expect(trace.createAndRun).toEqual([
      { fence: FENCE, requestId: REQUEST_ID_1 },
      { fence: FENCE, requestId: REQUEST_ID_1 },
    ]);
  });

  it('unknown transient error: keeps the requestId and surfaces the Retry CTA without auto-retrying', async () => {
    const { deps, createAndRunImpl, trace } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockRejectedValueOnce(new Error('network down'));

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(createAndRunImpl).toHaveBeenCalledTimes(1);
    const state = orchestrator.getState();
    expect(state.phase).toBe('recovery');
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('transient');
    expect(state.recovery.ctaLabel).toBe('Retry');
    expect(state.requestId).toBe(REQUEST_ID_1);
    expect(trace.captureEvent).toEqual([]);
    expect(trace.navigate).toEqual([]);
  });

  it('fence-changed (RUNTIME_NOT_CONNECTED) recovery clears the requestId so the next fence gets a new one', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1, REQUEST_ID_2] });
    createAndRunImpl.mockRejectedValueOnce({ data: { upstreamCode: 'RUNTIME_NOT_CONNECTED' } });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();
    const state = orchestrator.getState();
    expect(state.phase).toBe('recovery');
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('fence-changed');
    expect(state.recovery.ctaLabel).toBe('Select runtime');
    expect(state.requestId).toBeNull();

    createAndRunImpl.mockResolvedValueOnce(HAPPY_RESULT);
    const next = makeOrchestrator(deps, FENCE_NEW);
    await next.submit();
    expect(createAndRunImpl.mock.calls.at(-1)).toEqual([
      expect.objectContaining({
        fence: FENCE_NEW,
        request: expect.objectContaining({ requestId: REQUEST_ID_2 }),
      }),
    ]);
  });

  it('non-retryable CLI upgrade error: no Retry CTA, no auto-retry', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockRejectedValueOnce({ data: { upstreamCode: 'CLI_UPGRADE_REQUIRED' } });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(createAndRunImpl).toHaveBeenCalledTimes(1);
    const state = orchestrator.getState();
    expect(state.phase).toBe('recovery');
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('non-retryable-cli-upgrade');
    expect(state.recovery.ctaLabel).toBeNull();
  });

  it('non-retryable malformed response: no Retry CTA, no auto-retry', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockRejectedValueOnce({ data: { upstreamCode: 'INVALID_RUNTIME_RESPONSE' } });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    const state = orchestrator.getState();
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('non-retryable-malformed');
    expect(state.recovery.ctaLabel).toBeNull();
  });

  it('catalog-changed keeps the requestId while the fence is unchanged (so a Retry can carry the same id)', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockRejectedValueOnce({ data: { upstreamCode: 'CATALOG_CHANGED' } });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    const state = orchestrator.getState();
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('catalog-changed');
    expect(state.recovery.ctaLabel).toBe('Refresh catalog');
    expect(state.requestId).toBe(REQUEST_ID_1);
  });

  it('PENDING_COMMAND_LIMIT keeps the requestId and surfaces a Retry CTA', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockRejectedValueOnce({ data: { upstreamCode: 'PENDING_COMMAND_LIMIT' } });

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    const state = orchestrator.getState();
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('limit');
    expect(state.recovery.ctaLabel).toBe('Retry');
    expect(state.requestId).toBe(REQUEST_ID_1);
  });

  it('surfaces the upstream error message exactly once through the showError seam', async () => {
    const { deps, createAndRunImpl, trace } = makeDeps({ requestIds: [REQUEST_ID_1] });
    const err = Object.assign(new Error('mutation rejected'), {
      data: { upstreamCode: 'COMMAND_EXPIRED' },
    });
    createAndRunImpl.mockRejectedValueOnce(err);

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();

    expect(trace.showError).toEqual([{ message: 'mutation rejected' }]);
  });

  it('clears the recovery state when submit is called again (fresh attempt)', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1, REQUEST_ID_2] });
    createAndRunImpl
      .mockRejectedValueOnce({ data: { upstreamCode: 'COMMAND_EXPIRED' } })
      .mockResolvedValueOnce(HAPPY_RESULT);

    const orchestrator = makeOrchestrator(deps);
    await orchestrator.submit();
    expect(orchestrator.getState().phase).toBe('recovery');

    await orchestrator.submit();
    expect(createAndRunImpl).toHaveBeenCalledTimes(2);
    expect(orchestrator.getState().phase).toBe('navigated');
  });
});

describe('useLocalSessionCreateOrchestrator — live prompt getter and prompt-length recovery', () => {
  it('retry sends the current prompt from the getter, with the same requestId', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl
      .mockRejectedValueOnce({ data: { upstreamCode: 'COMMAND_EXPIRED' } })
      .mockResolvedValueOnce(HAPPY_RESULT);

    let livePrompt = 'prompt A';
    const orchestrator = makeOrchestrator(deps, FENCE, () => livePrompt);
    await orchestrator.submit();

    const firstCall = createAndRunImpl.mock.calls[0]?.[0] as {
      request: { prompt: string; requestId: string };
    };
    expect(firstCall.request.prompt).toBe('prompt A');
    expect(firstCall.request.requestId).toBe(REQUEST_ID_1);

    livePrompt = 'prompt B';
    await orchestrator.retry();

    const secondCall = createAndRunImpl.mock.calls[1]?.[0] as {
      request: { prompt: string; requestId: string };
    };
    expect(secondCall.request.prompt).toBe('prompt B');
    expect(secondCall.request.requestId).toBe(REQUEST_ID_1);
  });

  it('a fresh submit after editing uses the current prompt', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1, REQUEST_ID_2] });
    createAndRunImpl.mockResolvedValue(HAPPY_RESULT);

    let livePrompt = 'first prompt';
    const orchestrator = makeOrchestrator(deps, FENCE, () => livePrompt);
    await orchestrator.submit();

    const firstCall = createAndRunImpl.mock.calls[0]?.[0] as {
      request: { prompt: string; requestId: string };
    };
    expect(firstCall.request.prompt).toBe('first prompt');

    livePrompt = 'second prompt';
    await orchestrator.submit();

    const secondCall = createAndRunImpl.mock.calls[1]?.[0] as {
      request: { prompt: string; requestId: string };
    };
    expect(secondCall.request.prompt).toBe('second prompt');
  });

  it('rejects an over-length prompt with a non-retryable recovery and no Retry CTA', async () => {
    const { deps, createAndRunImpl } = makeDeps({ requestIds: [REQUEST_ID_1] });
    createAndRunImpl.mockResolvedValue(HAPPY_RESULT);

    const orchestrator = makeOrchestrator(deps, FENCE, () => 'a'.repeat(32_768 + 1));
    await orchestrator.submit();

    expect(createAndRunImpl).not.toHaveBeenCalled();
    const state = orchestrator.getState();
    expect(state.phase).toBe('recovery');
    if (state.phase !== 'recovery') {
      throw new Error('expected recovery');
    }
    expect(state.recovery.kind).toBe('non-retryable-prompt-too-long');
    expect(state.recovery.message).toBe(
      'Prompt must be 32,768 characters or fewer. Shorten the prompt and try again.'
    );
    expect(state.recovery.ctaLabel).toBeNull();
    expect(state.requestId).toBeNull();
  });
});
