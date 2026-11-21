import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSecurityAgentCapability, useSecurityAnalysisCapacity } from './use-security-agent';
import { SECURITY_ANALYSIS_CAPACITY_POLL_MS } from '@/lib/security-analysis-capacity';

// use-security-agent.ts re-exports the mutation hooks from
// use-security-agent-mutations.ts; stub that module so loading this file in
// node does not pull in the mutation graph (expo-router, outbox, etc.).
vi.mock('@/lib/hooks/use-security-agent-mutations', () => ({
  useSaveSecurityAgentConfig: () => ({}),
  useSetSecurityAgentEnabled: () => ({}),
  useTrackSecurityAgentInteraction: () => ({}),
  useTriggerSecuritySync: () => ({}),
}));

type OrgListEntry = { organizationId: string; role: string };

/** The `listFindings` counters the analysis-capacity hook reads. */
type CapacityCounts = { runningCount?: number; concurrencyLimit?: number };

const queryState = vi.hoisted(() => ({
  data: undefined as OrgListEntry[] | CapacityCounts | undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  isPending: false,
  fetchStatus: 'idle' as 'idle' | 'fetching' | 'paused',
  error: undefined as unknown,
  refetch: vi.fn(),
  options: [] as {
    refetchInterval?: unknown;
    networkMode?: unknown;
    enabled?: unknown;
  }[],
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: (options: { refetchInterval?: unknown }) => {
    queryState.options.push(options);
    return queryState;
  },
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({}) },
      securityAgent: { listFindings: { queryOptions: () => ({}) } },
    },
    securityAgent: { listFindings: { queryOptions: () => ({}) } },
  }),
}));

// The role read observes `organizations.list` through the hook that owns that
// entry's options, and that hook reads the auth token. Only the token matters
// here, so the auth module stays out of this node project.
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));

function capabilityFor(scope: string) {
  // eslint-disable-next-line react-hooks/rules-of-hooks -- the mocked hooks have no React state; this mirrors use-code-reviewer.test.ts
  return useSecurityAgentCapability(scope);
}

beforeEach(() => {
  queryState.data = undefined;
  queryState.isLoading = false;
  queryState.isError = false;
  queryState.isFetching = false;
  queryState.isPending = false;
  queryState.fetchStatus = 'idle';
  queryState.error = undefined;
  queryState.refetch.mockReset();
  queryState.options.length = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSecurityAgentCapability status derivation', () => {
  it('returns allowed for the personal scope', () => {
    const capability = capabilityFor('personal');

    expect(capability.status).toBe('allowed');
    expect(capability.canManage).toBe(true);
  });

  it.each(['owner', 'admin', 'billing_manager'])(
    'returns allowed for an org with a settled %s role',
    role => {
      queryState.data = [{ organizationId: 'org_123', role }];
      const capability = capabilityFor('org_123');

      expect(capability.status).toBe('allowed');
      expect(capability.canManage).toBe(true);
    }
  );

  it('returns denied for an org with a settled member role', () => {
    queryState.data = [{ organizationId: 'org_123', role: 'member' }];
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('denied');
    expect(capability.canManage).toBe(false);
  });

  it('returns error when the org role query fails with no data', () => {
    queryState.data = undefined;
    queryState.isError = true;
    queryState.isPending = false;
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('error');
  });

  it('settles an offline uncached org role read into the error state', () => {
    // The read comes through the hook that owns the shared options, which ask
    // for `networkMode: 'always'`: an offline read fails once its request
    // deadline lands instead of pausing with no data, so the surface gets a
    // settled failure with a cause to name.
    const failure = new Error('Network request failed');
    queryState.data = undefined;
    queryState.isError = true;
    queryState.isPending = false;
    queryState.fetchStatus = 'idle';
    queryState.error = failure;
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('error');
    expect(capability.isError).toBe(true);
    expect(capability.error).toBe(failure);
    expect(capability.isPending).toBe(false);
    expect(capability.fetchStatus).toBe('idle');
    expect(capability.canManage).toBe(false);
  });

  it('observes the org role through the options that own the shared entry', () => {
    capabilityFor('org_123');

    // One cache entry serves every consumer, and React Query keeps the last
    // observer's options for all of them. An observer with defaulted options
    // would strip the offline settle for every other consumer, so this read
    // must pass the owning options.
    const sharedOptions = queryState.options.filter(options => 'networkMode' in options);
    expect(sharedOptions).not.toHaveLength(0);
    for (const options of sharedOptions) {
      expect(options.networkMode).toBe('always');
      expect(options.enabled).toBe(true);
    }
  });

  it('keeps the personal scope off the shared entry while still reading its options', () => {
    queryState.data = undefined;
    queryState.isError = false;
    queryState.isPending = true;
    queryState.fetchStatus = 'fetching';
    const capability = capabilityFor('personal');

    expect(capability.status).toBe('allowed');
    expect(capability.fetchStatus).toBe('idle');
    expect(capability.error).toBeUndefined();
    const sharedOptions = queryState.options.filter(options => 'networkMode' in options);
    expect(sharedOptions.at(-1)).toMatchObject({ networkMode: 'always', enabled: false });
  });

  it.each([
    { fetchStatus: 'fetching', isPending: true, isError: false },
    { fetchStatus: 'idle', isPending: false, isError: true },
  ] as const)('ignores an unavailable shared org query in personal scope: %j', state => {
    Object.assign(queryState, state);
    const capability = capabilityFor('personal');

    expect(capability.status).toBe('allowed');
    expect(capability.canManage).toBe(true);
    expect(capability.fetchStatus).toBe('idle');
  });

  it('falls back to loading for any other unresolved combination', () => {
    queryState.data = undefined;
    queryState.isError = false;
    queryState.isPending = false;
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('loading');
  });

  it('keeps a settled owner role authoritative when a background refetch fails', () => {
    queryState.data = [{ organizationId: 'org_123', role: 'owner' }];
    queryState.isError = true;
    queryState.isPending = false;
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('allowed');
    expect(capability.canManage).toBe(true);
  });

  it('keeps a settled member role denied when a background refetch fails', () => {
    queryState.data = [{ organizationId: 'org_123', role: 'member' }];
    queryState.isError = true;
    queryState.isPending = false;
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('denied');
    expect(capability.canManage).toBe(false);
  });
});

describe('useSecurityAnalysisCapacity', () => {
  function capacityFor(scope: string) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- the mocked hooks have no React state; this mirrors capabilityFor above
    return useSecurityAnalysisCapacity(scope);
  }

  function pollFor(runningCount: number, concurrencyLimit: number, failed = false) {
    const options = queryState.options.at(-1) as {
      refetchInterval: (query: {
        state: {
          data?: { runningCount?: number; concurrencyLimit?: number };
          error?: unknown;
        };
      }) => unknown;
    };
    return options.refetchInterval({
      state: { data: { runningCount, concurrencyLimit }, error: failed ? new Error('read') : null },
    });
  }

  it('exposes the derived state next to the raw counters', () => {
    queryState.data = { runningCount: 1, concurrencyLimit: 3 };
    expect(capacityFor('personal').state).toBe('available');

    queryState.data = { runningCount: 3, concurrencyLimit: 3 };
    expect(capacityFor('personal').state).toBe('full');

    queryState.data = undefined;
    queryState.isLoading = true;
    expect(capacityFor('personal').state).toBe('loading');

    queryState.isError = true;
    expect(capacityFor('personal').state).toBe('error');
  });

  it('re-reads the counters only while the owner is at the limit', () => {
    queryState.data = { runningCount: 3, concurrencyLimit: 3 };
    capacityFor('personal');
    // A blocked list has nothing that changes on its own when a running
    // analysis finishes, so the read repeats until a slot frees.
    expect(pollFor(3, 3)).toBe(SECURITY_ANALYSIS_CAPACITY_POLL_MS);
    expect(pollFor(2, 3)).toBe(false);
    // A failed read keeps the last counts; the notice's retry owns recovery, so
    // the silent poll must stop rather than re-read every few seconds.
    expect(pollFor(3, 3, true)).toBe(false);
  });
});
