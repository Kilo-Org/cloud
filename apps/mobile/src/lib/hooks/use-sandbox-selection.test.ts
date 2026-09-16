import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SANDBOX_SLOW_LOAD_GRACE_MS, useSandboxSelection } from './use-sandbox-selection';

type CapturedOptions = { kind: 'personal' | 'org'; input: unknown };

const state = vi.hoisted(() => ({
  captured: null as CapturedOptions | null,
  effects: [] as { effect: () => void; deps: unknown[] }[],
  useStateCalls: 0,
  allocationValue: undefined as unknown,
  isSlowLoadingValue: false,
  setAllocation: vi.fn(),
  setIsSlowLoading: vi.fn(),
  refetch: vi.fn(),
  isError: false,
  isPending: false,
  isFetching: false,
  data: undefined as unknown,
}));

vi.mock('react', () => ({
  useState: () => {
    state.useStateCalls += 1;
    // Call order is the hook's declaration order: allocation, then the
    // loading reserve grace flag.
    if (state.useStateCalls === 1) {
      return [state.allocationValue, state.setAllocation];
    }
    return [state.isSlowLoadingValue, state.setIsSlowLoading];
  },
  useEffect: (effect: () => void, deps: unknown[]) => {
    state.effects.push({ effect, deps });
  },
  useCallback: <T>(fn: T) => fn,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: CapturedOptions) => {
    state.captured = options;
    return {
      data: state.data,
      isError: state.isError,
      isPending: state.isPending,
      isFetching: state.isFetching,
      refetch: state.refetch,
    };
  },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    cloudAgentNext: {
      getSandboxSelectionOptions: {
        queryOptions: (input: unknown) => ({ kind: 'personal', input }),
      },
    },
    organizations: {
      cloudAgentNext: {
        getSandboxSelectionOptions: {
          queryOptions: (input: unknown) => ({ kind: 'org', input }),
        },
      },
    },
  }),
}));

function callHook(organizationId: string | undefined) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the hook runs as a plain function with react mocked, matching the repo's pure hook tests
  return useSandboxSelection(organizationId);
}

beforeEach(() => {
  state.captured = null;
  state.effects = [];
  state.useStateCalls = 0;
  state.isError = false;
  state.isPending = false;
  state.isFetching = false;
  state.data = undefined;
  state.isSlowLoadingValue = false;
  state.setAllocation.mockReset();
  state.setIsSlowLoading.mockReset();
  state.refetch.mockReset();
});

describe('useSandboxSelection query selection', () => {
  it('queries the personal procedure without an organization', () => {
    callHook(undefined);
    expect(state.captured).toEqual({ kind: 'personal', input: {} });
  });

  it('queries the organization procedure with the route organization', () => {
    callHook('org-1');
    expect(state.captured).toEqual({ kind: 'org', input: { organizationId: 'org-1' } });
  });
});

describe('useSandboxSelection state', () => {
  it('maps a never-settled query to loading', () => {
    state.isPending = true;
    expect(callHook(undefined).status).toBe('loading');
  });

  it('maps a rejected query to error', () => {
    state.isError = true;
    expect(callHook(undefined).status).toBe('error');
  });

  it('maps a settled query to ready and surfaces its fetch progress', () => {
    state.data = { enabled: false, options: [] };
    state.isFetching = true;
    const selection = callHook(undefined);
    expect(selection.status).toBe('ready');
    expect(selection.isFetching).toBe(true);
    expect(selection.capabilities).toEqual({ enabled: false, options: [] });
  });

  it('returns the reserve-grace flag the hook state holds', () => {
    state.isSlowLoadingValue = true;
    expect(callHook(undefined).isSlowLoading).toBe(true);
    state.isSlowLoadingValue = false;
    expect(callHook(undefined).isSlowLoading).toBe(false);
  });

  it('discards the picked allocation when the organization scope changes', () => {
    callHook('org-1');
    const allocationEffect = state.effects[0];
    expect(allocationEffect?.deps).toEqual(['org-1']);
    expect(allocationEffect).not.toBeNull();
    allocationEffect?.effect();
    expect(state.setAllocation).toHaveBeenCalledWith(undefined);
  });

  it('refetches the capabilities query through the returned retry', () => {
    callHook(undefined).refetch();
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});

describe('useSandboxSelection loading reserve grace', () => {
  it('arms the reserve flag only after the grace while loading', () => {
    vi.useFakeTimers();
    try {
      state.isPending = true;
      callHook(undefined);
      const slowEffect = state.effects.at(-1);
      expect(slowEffect?.deps).toEqual(['loading']);
      slowEffect?.effect();
      expect(state.setIsSlowLoading).not.toHaveBeenCalled();
      vi.advanceTimersByTime(SANDBOX_SLOW_LOAD_GRACE_MS);
      expect(state.setIsSlowLoading).toHaveBeenCalledTimes(1);
      expect(state.setIsSlowLoading).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the reserve flag instead of arming a timer once the query settles', () => {
    vi.useFakeTimers();
    try {
      state.data = { enabled: true, options: [] };
      callHook(undefined);
      const slowEffect = state.effects.at(-1);
      expect(slowEffect?.deps).toEqual(['ready']);
      slowEffect?.effect();
      expect(state.setIsSlowLoading).toHaveBeenCalledWith(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms from zero when a settled query goes back to loading', () => {
    vi.useFakeTimers();
    try {
      state.isPending = true;
      callHook(undefined);
      // The armed effect returns its timer cleanup, as a real effect would.
      const armedCleanup = state.effects.at(-1)?.effect() as unknown as (() => void) | undefined;
      vi.advanceTimersByTime(SANDBOX_SLOW_LOAD_GRACE_MS - 1);
      // The query settles just before the grace expires.
      state.isPending = false;
      state.data = { enabled: true, options: [] };
      callHook(undefined);
      state.effects.at(-1)?.effect();
      armedCleanup?.();
      expect(state.setIsSlowLoading).toHaveBeenCalledWith(false);
      expect(vi.getTimerCount()).toBe(0);
      // A later cold load (cache dropped) starts the grace over: no flag
      // before the full grace, flag after it.
      state.data = undefined;
      state.isPending = true;
      callHook(undefined);
      state.effects.at(-1)?.effect();
      vi.advanceTimersByTime(SANDBOX_SLOW_LOAD_GRACE_MS - 1);
      expect(state.setIsSlowLoading).not.toHaveBeenCalledWith(true);
      vi.advanceTimersByTime(1);
      expect(state.setIsSlowLoading).toHaveBeenCalledWith(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
