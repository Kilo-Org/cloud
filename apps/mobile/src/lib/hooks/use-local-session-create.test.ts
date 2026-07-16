/* eslint-disable max-lines -- one cohesive TDD suite per React hook; the hook
   owns one concern (wire the orchestrator to tRPC + side effects) and its
   tests assert one concern (the wiring). Splitting would scatter closely
   related mock plumbing across files. */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IDLE_STATE, useLocalSessionCreate } from './use-local-session-create';
import { type LocalRuntimeCatalog, type LocalRuntimeFence } from './local-runtime-catalog-types';
import {
  type LocalSessionCreateOrchestrator,
  type LocalSessionCreateOrchestratorState,
} from './local-session-create-orchestrator-shared';

const mockedTrpc = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  mutate: vi.fn(),
  mutationOnError: null as null | ((error: { message: string }) => void),
  query: vi.fn(),
  trpcShape: null as unknown as {
    cliSessionsV2: {
      list: { pathFilter: () => { queryKey: readonly string[] } };
      recentRepositories: { pathFilter: () => { queryKey: readonly string[] } };
      search: { pathFilter: () => { queryKey: readonly string[] } };
    };
    activeSessions: {
      list: { pathFilter: () => { queryKey: readonly string[] } };
    };
    localRuntimeControl: {
      createAndRun: { mutationOptions: (opts: unknown) => unknown };
    };
  },
}));

const mockedReactQuery = vi.hoisted(() => ({
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  invalidationCalls: [] as unknown[][],
}));

const mockedToast = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
}));

const mockedHaptics = vi.hoisted(() => ({
  notificationAsync: vi.fn().mockResolvedValue(undefined),
}));

const mockedAnalytics = vi.hoisted(() => ({
  captureEvent: vi.fn(),
}));

const mockedCrypto = vi.hoisted(() => ({
  randomUUID: vi.fn(() => '00000000-0000-4000-8000-0000000000aa'),
}));

const mockedRouter = vi.hoisted(() => ({
  replace: vi.fn(),
}));

const pathFilters = {
  cliSessionsV2: {
    list: { pathFilter: () => ({ queryKey: ['cliSessionsV2', 'list'] }) },
    recentRepositories: {
      pathFilter: () => ({ queryKey: ['cliSessionsV2', 'recentRepositories'] }),
    },
    search: { pathFilter: () => ({ queryKey: ['cliSessionsV2', 'search'] }) },
    readiness: { query: (input: { session_id: string }) => mockedTrpc.query(input) },
  },
  activeSessions: {
    list: { pathFilter: () => ({ queryKey: ['activeSessions', 'list'] }) },
  },
};

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => mockedTrpc.trpcShape,
  trpcClient: {
    cliSessionsV2: {
      readiness: {
        query: (input: { session_id: string }) => mockedTrpc.query(input),
      },
    },
    localRuntimeControl: {
      createAndRun: {
        mutate: (...args: unknown[]) => mockedTrpc.mutate(...args),
        mutateAsync: (...args: unknown[]) => mockedTrpc.mutateAsync(...args),
      },
    },
  },
}));

vi.mock('@tanstack/react-query', () => ({
  useMutation: (options: {
    mutationFn?: (input: unknown) => Promise<unknown>;
    onError?: (error: { message: string }) => void;
  }) => {
    const onError = options.onError;
    return {
      mutateAsync: async (...args: unknown[]) => {
        try {
          return await mockedTrpc.mutateAsync(...args);
        } catch (error) {
          if (onError) {
            onError(error as { message: string });
          }
          throw error;
        }
      },
    };
  },
  useQueryClient: () => ({
    invalidateQueries: (input: unknown) => {
      mockedReactQuery.invalidationCalls.push([input]);
      return mockedReactQuery.invalidateQueries(input);
    },
  }),
}));

vi.mock('sonner-native', () => ({
  toast: mockedToast,
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: mockedHaptics.notificationAsync,
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: mockedAnalytics.captureEvent,
  SESSION_CREATED_EVENT: 'session_created',
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => mockedCrypto.randomUUID(),
}));

vi.mock('expo-router', () => ({
  useRouter: () => mockedRouter,
}));

// ── React dispatcher harness ────────────────────────────────────────

type DispatcherState = {
  hookIndex: number;
  hookState: unknown[];
  stateSlots: unknown[];
  stateSlotIndex: number;
  orchestratorStateSlotIndex: number;
  setStates: ((value: unknown) => void)[];
  effects: ({ effect: () => unknown; cleanup: unknown } | undefined)[];
  memos: Map<number, unknown>;
  refs: Map<number, { current: unknown }>;
};

function makeDispatcher(): { state: DispatcherState; setDispatcher: () => void } {
  const state: DispatcherState = {
    hookIndex: 0,
    hookState: [],
    stateSlots: [],
    stateSlotIndex: 0,
    orchestratorStateSlotIndex: -1,
    setStates: [],
    effects: [],
    memos: new Map(),
    refs: new Map(),
  };
  const previousDispatcher = (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = {
    useState: (initial: unknown) => {
      const slot = state.stateSlotIndex;
      state.stateSlotIndex += 1;
      if (state.stateSlots[slot] === undefined) {
        state.stateSlots[slot] = initial;
      }
      // The hook exposes its orchestrator state through a single useState.
      // Record which state slot it is so refresh reads the live state
      // regardless of where useState falls among refs, memos, and effects.
      if (initial === IDLE_STATE) {
        state.orchestratorStateSlotIndex = slot;
      }
      const setState = (value: unknown) => {
        state.stateSlots[slot] =
          typeof value === 'function'
            ? (value as (previous: unknown) => unknown)(state.stateSlots[slot])
            : value;
      };
      return [state.stateSlots[slot], setState] as [unknown, (v: unknown) => void];
    },
    useReducer: (reducer: (s: unknown, a: unknown) => unknown, initial: unknown) => {
      const idx = state.hookIndex;
      state.hookIndex += 1;
      if (state.hookState[idx] === undefined) {
        state.hookState[idx] = initial;
      }
      const dispatch = (action: unknown) => {
        state.hookState[idx] = reducer(state.hookState[idx], action);
      };
      return [state.hookState[idx], dispatch] as [unknown, (a: unknown) => void];
    },
    useRef: (initial: unknown) => {
      const idx = state.hookIndex;
      state.hookIndex += 1;
      if (!state.refs.has(idx)) {
        state.refs.set(idx, { current: initial });
      }
      return state.refs.get(idx) as { current: unknown };
    },
    useCallback: (callback: unknown, deps: unknown[]) => {
      const idx = state.hookIndex;
      state.hookIndex += 1;
      state.memos.set(idx, callback);
      void deps;
      return callback;
    },
    useMemo: (factory: () => unknown, deps: unknown[]) => {
      const idx = state.hookIndex;
      state.hookIndex += 1;
      void deps;
      if (!state.memos.has(idx)) {
        state.memos.set(idx, factory());
      }
      return state.memos.get(idx);
    },
    useEffect: (effect: () => unknown, _deps: unknown[]) => {
      const idx = state.hookIndex;
      state.hookIndex += 1;
      state.effects[idx] = { effect, cleanup: undefined };
      void _deps;
    },
    useLayoutEffect: (_effect: () => unknown, _deps: unknown[]) => {
      void _effect;
      void _deps;
    },
    useSyncExternalStore: (
      subscribe: (listener: () => void) => () => void,
      getSnapshot: () => unknown
    ) => {
      const idx = state.hookIndex;
      state.hookIndex += 1;
      state.memos.set(idx, { subscribe, getSnapshot });
      return getSnapshot();
    },
    useContext: (context: unknown) => {
      void context;
      return undefined;
    },
    useDebugValue: (_value: unknown) => {
      void _value;
    },
  };
  return {
    state,
    setDispatcher: () => {
      (
        React as unknown as {
          __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
        }
      ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = previousDispatcher;
    },
  };
}

function runEffects(dispatcherState: DispatcherState) {
  for (const entry of dispatcherState.effects) {
    if (entry !== undefined) {
      if (entry.cleanup) {
        const c = entry.cleanup as () => void;
        c();
      }
      const cleanup = entry.effect();
      entry.cleanup = cleanup;
    }
  }
}

function runCleanups(dispatcherState: DispatcherState) {
  for (const entry of dispatcherState.effects) {
    if (entry?.cleanup) {
      (entry.cleanup as () => void)();
    }
  }
}

function getActiveOrchestratorFromRefs(
  dispatcherState: DispatcherState
): LocalSessionCreateOrchestrator | null {
  for (const ref of dispatcherState.refs.values()) {
    const maybe = ref.current as {
      orchestrator?: LocalSessionCreateOrchestrator;
    } | null;
    if (maybe?.orchestrator) {
      return maybe.orchestrator;
    }
  }
  return null;
}

function assertDefined<T>(value: T | null | undefined): asserts value is T {
  expect(value).toBeDefined();
}

function callArgument(calls: unknown[][], index: number): unknown {
  const call = calls[index];
  assertDefined(call);
  return call[0];
}

// ── Domain fixtures ─────────────────────────────────────────────────

const FENCE_A: LocalRuntimeFence = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-a',
};
const FENCE_B: LocalRuntimeFence = {
  runtimeId: '11111111-1111-4111-8111-111111111111',
  connectionId: 'cli-b',
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
        models: [{ id: 'claude-opus-4-7', variants: ['max'] }],
      },
    ],
    truncated: false,
  },
};

const SESSION_ID = 'sess-abc';
const SESSION_DETAIL_PATH = `/(app)/agent-chat/${SESSION_ID}`;

type RenderInput = {
  fence: LocalRuntimeFence | null;
  catalog: LocalRuntimeCatalog | null;
  selectedAgentSlug: string | null;
  selectedModel: { providerID: string; modelID: string; variant: string } | null;
  prompt: string;
};

type HookReturn = ReturnType<typeof useLocalSessionCreate>;

type RenderResult = {
  state: HookReturn;
  refresh: () => void;
  rerender: (next: Partial<RenderInput>) => void;
  unmount: () => void;
  promptRef: { current: string };
  hasPromptRef: { current: boolean };
  dispatcherState: DispatcherState;
};

function renderHook(initial: RenderInput): RenderResult {
  const harness = makeDispatcher();
  const dispatcherState = harness.state;
  let current: RenderInput = initial;
  let lastState: HookReturn | null = null;

  const promptRef: { current: string } = { current: current.prompt };
  const hasPromptRef: { current: boolean } = { current: current.prompt.length > 0 };

  const run = () => {
    dispatcherState.hookIndex = 0;
    dispatcherState.effects = [];
    lastState = (useLocalSessionCreate as unknown as (input: unknown) => HookReturn)({
      fence: current.fence,
      catalog: current.catalog,
      selectedAgentSlug: current.selectedAgentSlug,
      selectedModel: current.selectedModel,
      promptRef,
      hasPromptRef,
    });
    runEffects(dispatcherState);
  };

  run();

  const refresh = () => {
    // The custom dispatcher does not re-render on state changes, so the
    // subscription effect is only established on re-render. After a lazy
    // submit we manually sync the orchestrator state into the React state
    // slot so `refresh` exposes the rendered hook result without a
    // hard-coded state index.
    let liveState: LocalSessionCreateOrchestratorState = IDLE_STATE;
    let foundOrchestrator = false;
    for (const ref of dispatcherState.refs.values()) {
      const maybe = ref.current as {
        orchestrator?: { getState: () => LocalSessionCreateOrchestratorState };
      } | null;
      if (maybe?.orchestrator?.getState) {
        liveState = maybe.orchestrator.getState();
        foundOrchestrator = true;
        break;
      }
    }
    if (!foundOrchestrator && dispatcherState.orchestratorStateSlotIndex >= 0) {
      liveState = dispatcherState.stateSlots[
        dispatcherState.orchestratorStateSlotIndex
      ] as LocalSessionCreateOrchestratorState;
    }
    if (dispatcherState.orchestratorStateSlotIndex >= 0) {
      dispatcherState.stateSlots[dispatcherState.orchestratorStateSlotIndex] = liveState;
    }
    assertDefined(lastState);
    const recovery = liveState.phase === 'recovery' ? liveState.recovery : null;
    const isSelectionComplete =
      current.fence !== null &&
      current.catalog !== null &&
      current.selectedAgentSlug !== null &&
      current.selectedModel !== null;
    const isSubmitting = liveState.phase === 'submitting';
    const canSubmit = isSelectionComplete && hasPromptRef.current && !isSubmitting;
    const canRetry = recovery?.ctaLabel === 'Retry';
    const canCheckAgain = recovery?.kind === 'readiness-timeout';
    const nextState: HookReturn = {
      ...lastState,
      phase: liveState.phase,
      recovery,
      isSubmitting,
      canSubmit,
      canRetry,
      canCheckAgain,
    };
    lastState = nextState;
  };

  return {
    get state() {
      assertDefined(lastState);
      return lastState;
    },
    refresh,
    rerender: (next: Partial<RenderInput>) => {
      current = { ...current, ...next };
      promptRef.current = current.prompt;
      hasPromptRef.current = current.prompt.length > 0;
      // Clean up existing subscriptions before re-running.
      runCleanups(dispatcherState);
      run();
    },
    unmount: () => {
      runCleanups(dispatcherState);
      harness.setDispatcher();
    },
    promptRef,
    hasPromptRef,
    dispatcherState,
  };
}

beforeEach(() => {
  mockedTrpc.mutateAsync.mockReset();
  mockedTrpc.mutateAsync.mockImplementation(async (input: unknown) => await input);
  mockedTrpc.mutate.mockReset();
  mockedTrpc.mutationOnError = null;
  mockedTrpc.query.mockReset();
  mockedTrpc.trpcShape = {
    cliSessionsV2: {
      ...pathFilters.cliSessionsV2,
    },
    activeSessions: pathFilters.activeSessions,
    localRuntimeControl: {
      createAndRun: {
        mutationOptions: (opts: unknown) => {
          const typedOpts = opts as { onError?: (error: { message: string }) => void };
          mockedTrpc.mutationOnError = typedOpts.onError ?? null;
          return { __mutation: 'createAndRun', onError: typedOpts.onError };
        },
      },
    },
  };
  mockedReactQuery.invalidateQueries.mockClear();
  mockedReactQuery.invalidationCalls = [];
  mockedToast.error.mockReset();
  mockedToast.info.mockReset();
  mockedToast.success.mockReset();
  mockedHaptics.notificationAsync.mockReset();
  mockedAnalytics.captureEvent.mockReset();
  mockedCrypto.randomUUID.mockReset();
  mockedCrypto.randomUUID.mockReturnValue('00000000-0000-4000-8000-0000000000aa');
  mockedRouter.replace.mockReset();
});

afterEach(() => {
  // Reset the dispatcher to a clean state.
  (
    React as unknown as {
      __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
    }
  ).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = null;
});

// ── Tests ───────────────────────────────────────────────────────────

describe('useLocalSessionCreate — wiring', () => {
  it('registers the mutation onError toast handler at construction', () => {
    renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });
    expect(mockedTrpc.mutationOnError).toBeTypeOf('function');
  });

  it('exposes canSubmit=false while prompt is blank and =true once a nonblank prompt is captured', () => {
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: '',
    });
    expect(result.state.canSubmit).toBe(false);
    result.rerender({ prompt: 'hello' });
    expect(result.state.canSubmit).toBe(true);
  });

  it('exposes canSubmit=false when selection is incomplete (fence null)', () => {
    const result = renderHook({
      fence: null,
      catalog: null,
      selectedAgentSlug: null,
      selectedModel: null,
      prompt: 'orphan prompt',
    });
    expect(result.state.canSubmit).toBe(false);
  });
});

describe('useLocalSessionCreate — submit happy path', () => {
  it('passes exact built {fence,request} to mutateAsync, fires success haptic, captures analytics, invalidates once, and routes to detail', async () => {
    mockedTrpc.mutateAsync.mockResolvedValueOnce({
      status: 'ready',
      result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
    });
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });

    await result.state.submit();

    expect(mockedTrpc.mutateAsync).toHaveBeenCalledTimes(1);
    const call = callArgument(mockedTrpc.mutateAsync.mock.calls, 0) as {
      fence: LocalRuntimeFence;
      request: {
        protocolVersion: 1;
        requestId: string;
        prompt: string;
        model: { providerID: string; modelID: string };
        agent: string;
        variant?: string;
      };
    };
    expect(call.fence).toEqual(FENCE_A);
    expect(call.request.protocolVersion).toBe(1);
    expect(call.request.requestId).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(call.request.prompt).toBe('Build me a thing');
    expect(call.request.model).toEqual({ providerID: 'kilo', modelID: 'claude-opus-4-7' });
    expect(call.request.variant).toBe('max');
    expect(call.request.agent).toBe('build');

    expect(mockedReactQuery.invalidationCalls).toHaveLength(4);
    const queryKeys = (
      mockedReactQuery.invalidationCalls as [{ queryKey: readonly string[] }][]
    ).map(([c]) => c.queryKey[1] ?? c.queryKey[0]);
    expect(queryKeys).toEqual(['list', 'recentRepositories', 'search', 'list']);

    expect(mockedAnalytics.captureEvent).toHaveBeenCalledWith('session_created', {
      surface: 'remote-session',
    });
    expect(mockedHaptics.notificationAsync).toHaveBeenCalledWith('success');
    expect(mockedRouter.replace).toHaveBeenCalledWith(SESSION_DETAIL_PATH);
    expect(mockedToast.info).not.toHaveBeenCalled();
    expect(mockedToast.error).not.toHaveBeenCalled();
  });

  it('prompt-partial: fires one info toast and routes to detail, no analytics, no haptic', async () => {
    mockedTrpc.mutateAsync.mockResolvedValueOnce({
      status: 'ready',
      result: {
        protocolVersion: 1,
        sessionId: SESSION_ID,
        promptStarted: false,
        error: { code: 'PROMPT_START_FAILED', message: 'prompt did not start' },
      },
    });
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });

    await result.state.submit();

    expect(mockedToast.info).toHaveBeenCalledTimes(1);
    expect(mockedToast.error).not.toHaveBeenCalled();
    expect(mockedAnalytics.captureEvent).not.toHaveBeenCalled();
    expect(mockedHaptics.notificationAsync).not.toHaveBeenCalled();
    expect(mockedRouter.replace).toHaveBeenCalledWith(SESSION_DETAIL_PATH);
  });
});

describe('useLocalSessionCreate — error and recovery wiring', () => {
  it('fires the mutation onError toast exactly once for a thrown mutation error', async () => {
    const err = Object.assign(new Error('mutation rejected'), {
      data: { upstreamCode: 'COMMAND_EXPIRED' },
    });
    mockedTrpc.mutateAsync.mockRejectedValueOnce(err);
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });

    await result.state.submit();
    result.refresh();

    expect(mockedToast.error).toHaveBeenCalledTimes(1);
    expect(mockedToast.error).toHaveBeenCalledWith('mutation rejected');
    // Recovery state is exposed so the screen can render a CTA below the prompt.
    expect(result.state.recovery).not.toBeNull();
    const recovery = result.state.recovery;
    assertDefined(recovery);
    expect(recovery.kind).toBe('transient');
  });

  it('retry reuses the same requestId across the original submit and the retry', async () => {
    mockedTrpc.mutateAsync
      .mockRejectedValueOnce(
        Object.assign(new Error('expired'), {
          data: { upstreamCode: 'COMMAND_EXPIRED' },
        })
      )
      .mockResolvedValueOnce({
        status: 'ready',
        result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
      });
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });

    await result.state.submit();
    await result.state.retry();

    const first = (
      callArgument(mockedTrpc.mutateAsync.mock.calls, 0) as {
        request: { requestId: string };
      }
    ).request.requestId;
    const second = (
      callArgument(mockedTrpc.mutateAsync.mock.calls, 1) as {
        request: { requestId: string };
      }
    ).request.requestId;
    expect(first).toBe(second);
  });

  it('fence change clears the requestId and the next attempt allocates a new UUID', async () => {
    mockedCrypto.randomUUID
      .mockReturnValueOnce('00000000-0000-4000-8000-0000000000aa')
      .mockReturnValueOnce('00000000-0000-4000-8000-0000000000bb');
    mockedTrpc.mutateAsync.mockResolvedValue({
      status: 'ready',
      result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
    });
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });
    await result.state.submit();

    result.rerender({ fence: FENCE_B });
    await result.state.submit();

    const first = (
      callArgument(mockedTrpc.mutateAsync.mock.calls, 0) as {
        request: { requestId: string };
      }
    ).request.requestId;
    const second = (
      callArgument(mockedTrpc.mutateAsync.mock.calls, 1) as {
        request: { requestId: string };
      }
    ).request.requestId;
    expect(first).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(second).toBe('00000000-0000-4000-8000-0000000000bb');
  });

  it('passes the typed SESSION_DETAIL_PATH to router.replace (a real string, not null)', async () => {
    mockedTrpc.mutateAsync.mockResolvedValueOnce({
      status: 'ready',
      result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
    });
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });

    await result.state.submit();

    expect(mockedRouter.replace).toHaveBeenCalledTimes(1);
    const replaceArg = mockedRouter.replace.mock.calls[0]?.[0];
    expect(typeof replaceArg).toBe('string');
    expect(replaceArg).toBe(SESSION_DETAIL_PATH);
  });

  it('sets isSubmitting true and disables Start before the mutation resolves', () => {
    const pending = new Promise<unknown>(() => {
      // Intentionally never resolves so the test can observe the submitting state.
    });
    mockedTrpc.mutateAsync.mockReturnValue(pending);
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });
    expect(result.state.isSubmitting).toBe(false);
    expect(result.state.canSubmit).toBe(true);

    const submitPromise = result.state.submit();
    result.rerender({});
    result.refresh();

    expect(result.state.isSubmitting).toBe(true);
    expect(result.state.canSubmit).toBe(false);
    expect(result.state.phase).toBe('submitting');
    void submitPromise;
  });

  it('uses the readiness query for check-again reads (no new create)', async () => {
    vi.useFakeTimers();
    try {
      // Force a readiness-timeout: not-ready happy + pending pollReadiness.
      mockedTrpc.mutateAsync.mockResolvedValueOnce({
        status: 'session_not_ready',
        code: 'SESSION_NOT_READY',
        result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
      });
      mockedTrpc.query.mockResolvedValue({ status: 'pending' });
      const result = renderHook({
        fence: FENCE_A,
        catalog: CATALOG,
        selectedAgentSlug: 'build',
        selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
        prompt: 'Build me a thing',
      });

      // Advance timers while the submit's poll loop runs.
      const submitPromise = result.state.submit();
      await vi.runAllTimersAsync();
      await submitPromise;
      result.refresh();

      const createCountBefore = mockedTrpc.mutateAsync.mock.calls.length;
      const checkAgainPromise = result.state.checkAgain();
      await vi.runAllTimersAsync();
      await checkAgainPromise;
      const createCountAfter = mockedTrpc.mutateAsync.mock.calls.length;
      expect(createCountAfter).toBe(createCountBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the submitting state across a rerender that does not change the orchestrator identity', () => {
    const pending = new Promise<unknown>(() => {
      // Intentionally never resolves so the test can observe the submitting state.
    });
    mockedTrpc.mutateAsync.mockReturnValue(pending);
    const result = renderHook({
      fence: FENCE_A,
      catalog: CATALOG,
      selectedAgentSlug: 'build',
      selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
      prompt: 'Build me a thing',
    });

    const submitPromise = result.state.submit();
    result.rerender({ prompt: 'Build me a different thing' });
    result.refresh();

    expect(result.state.phase).toBe('submitting');
    expect(result.state.isSubmitting).toBe(true);
    void submitPromise;
  });

  it('unsubscribes from the old orchestrator when the catalog identity changes', async () => {
    vi.useFakeTimers();
    try {
      // Force a readiness-timeout so the orchestrator lands in recovery and we
      // can capture a reference to it before changing the catalog identity.
      mockedTrpc.mutateAsync.mockResolvedValueOnce({
        status: 'session_not_ready',
        code: 'SESSION_NOT_READY',
        result: { protocolVersion: 1, sessionId: SESSION_ID, promptStarted: true },
      });
      mockedTrpc.query.mockResolvedValue({ status: 'pending' });

      const result = renderHook({
        fence: FENCE_A,
        catalog: CATALOG,
        selectedAgentSlug: 'build',
        selectedModel: { providerID: 'kilo', modelID: 'claude-opus-4-7', variant: 'max' },
        prompt: 'Build me a thing',
      });

      const submitPromise = result.state.submit();
      await vi.runAllTimersAsync();
      await submitPromise;
      result.refresh();

      expect(result.state.phase).toBe('recovery');
      const oldOrchestrator = getActiveOrchestratorFromRefs(result.dispatcherState);
      expect(oldOrchestrator).not.toBeNull();

      const CATALOG_B: LocalRuntimeCatalog = {
        ...CATALOG,
        agents: [{ slug: 'review', name: 'Review' }],
      };
      result.rerender({ catalog: CATALOG_B });
      result.refresh();

      expect(result.state.phase).toBe('idle');
      expect(result.state.recovery).toBeNull();

      // Trigger a state change on the old orchestrator. If the subscription
      // cleanup did not run, the hook state would leak back to recovery.
      mockedTrpc.query.mockResolvedValueOnce({ status: 'pending' });
      await oldOrchestrator?.checkAgain();
      result.refresh();

      expect(result.state.phase).toBe('idle');
      expect(result.state.recovery).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
