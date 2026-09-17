import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSandboxSelection } from './use-sandbox-selection';

type CapturedOptions = { kind: 'personal' | 'org'; input: unknown };

const state = vi.hoisted(() => ({
  captured: null as CapturedOptions | null,
  effects: [] as { effect: () => void; deps: unknown[] }[],
  allocationValue: undefined as unknown,
  setAllocation: vi.fn(),
  refetch: vi.fn(),
  isError: false,
  isPending: false,
  isFetching: false,
  data: undefined as unknown,
}));

vi.mock('react', () => ({
  useState: () => [state.allocationValue, state.setAllocation],
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
  state.isError = false;
  state.isPending = false;
  state.isFetching = false;
  state.data = undefined;
  state.setAllocation.mockReset();
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

  it('discards the picked allocation when the organization scope changes', () => {
    callHook('org-1');
    const allocationEffect = state.effects[0];
    expect(allocationEffect?.deps).toEqual(['org-1']);
    expect(allocationEffect).toBeDefined();
    allocationEffect?.effect();
    expect(state.setAllocation).toHaveBeenCalledWith(undefined);
  });

  it('refetches the capabilities query through the returned retry', () => {
    callHook(undefined).refetch();
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });
});
