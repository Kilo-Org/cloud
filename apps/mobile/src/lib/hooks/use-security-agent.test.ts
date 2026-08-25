import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSecurityAgentCapability } from './use-security-agent';

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
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => queryState,
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      list: { queryOptions: () => ({}) },
    },
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
  queryState.refetch.mockReset();
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

  it('returns allowed for an org with a settled owner role', () => {
    queryState.data = [{ organizationId: 'org_123', role: 'owner' }];
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('allowed');
    expect(capability.canManage).toBe(true);
  });

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

  it('returns loading when the org role query is pending with no data', () => {
    queryState.data = undefined;
    queryState.isError = false;
    queryState.isPending = true;
    const capability = capabilityFor('org_123');

    expect(capability.status).toBe('loading');
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
