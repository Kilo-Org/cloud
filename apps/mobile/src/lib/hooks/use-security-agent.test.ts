import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useSecurityAgentCapability,
  useSecurityAnalysisCapacity,
} from './use-security-agent';
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

const queryState = vi.hoisted(() => ({
  data: undefined as OrgListEntry[] | undefined,
  isLoading: false,
  isError: false,
  isFetching: false,
  isPending: false,
  fetchStatus: 'idle' as 'idle' | 'fetching' | 'paused',
  refetch: vi.fn(),
  options: [] as { refetchInterval?: unknown }[],
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

  it('keeps a paused uncached org role unresolved and exposes its recovery state', () => {
    queryState.data = undefined;
    queryState.isError = false;
    queryState.isPending = true;
    queryState.fetchStatus = 'paused';
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('loading');
    expect(capability.fetchStatus).toBe('paused');
    expect(capability.canManage).toBe(false);
  });

  it.each([
    { fetchStatus: 'paused', isPending: true, isError: false },
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

  function pollFor(runningCount: number, concurrencyLimit: number) {
    const options = queryState.options.at(-1) as {
      refetchInterval: (query: {
        state: { data?: { runningCount?: number; concurrencyLimit?: number } };
      }) => unknown;
    };
    return options.refetchInterval({ state: { data: { runningCount, concurrencyLimit } } });
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
  });
});
