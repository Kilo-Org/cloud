import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SecurityAgentModule from '@kilocode/app-shared/security-agent';

import { useCancelSecurityRemediation } from './use-security-remediation';
import { REMEDIATION_UNAVAILABLE_COPY } from '@kilocode/app-shared/security-agent';
import { i18n } from '@/i18n';
import { getRemediationUnavailableKey } from '@/lib/security-agent-copy';

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onMutate?: (vars: unknown) => Promise<unknown> | unknown;
  onError?: (error: unknown, vars: unknown, context: unknown) => void;
  onSuccess?: (result: unknown, vars: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
  scope?: { id: string };
};

let lastCapturedOptions: MutationOptions | null = null;
const cancelMutateMock = vi.fn();
const orgCancelMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const getQueryDataMock = vi.fn();
const setQueryDataMock = vi.fn();
const cancelQueriesMock = vi.fn();
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
    getQueryData: (...args: unknown[]) => getQueryDataMock(...args),
    setQueryData: (...args: unknown[]) => setQueryDataMock(...args),
    cancelQueries: (...args: unknown[]) => cancelQueriesMock(...args),
  }),
  hashKey: (key: unknown) => JSON.stringify(key),
}));

vi.mock('react-native', () => ({
  InteractionManager: { runAfterInteractions: vi.fn() },
}));

vi.mock('sonner-native', () => ({
  toast: {
    error: (msg: string) => toastErrorMock(msg),
    success: (msg: string) => toastSuccessMock(msg),
  },
}));

vi.mock('@kilocode/app-shared/security-agent', async importOriginal => ({
  ...(await importOriginal<typeof SecurityAgentModule>()),
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    securityAgent: {
      getAnalysis: {
        queryKey: ({ findingId }: { findingId: string }) => [
          'securityAgent',
          'getAnalysis',
          { findingId },
        ],
      },
      getFinding: { queryKey: () => ['securityAgent', 'getFinding'] },
      getDashboardStats: { queryKey: () => ['securityAgent', 'getDashboardStats'] },
      listFindings: { queryKey: () => ['securityAgent', 'listFindings'] },
    },
    organizations: {
      securityAgent: {
        getAnalysis: {
          queryKey: ({
            organizationId,
            findingId,
          }: {
            organizationId: string;
            findingId: string;
          }) => ['organizations', 'securityAgent', 'getAnalysis', { organizationId, findingId }],
        },
        getFinding: { queryKey: () => ['organizations', 'securityAgent', 'getFinding'] },
        getDashboardStats: {
          queryKey: () => ['organizations', 'securityAgent', 'getDashboardStats'],
        },
        listFindings: { queryKey: () => ['organizations', 'securityAgent', 'listFindings'] },
      },
    },
  }),
  trpcClient: {
    securityAgent: {
      cancelRemediation: { mutate: (vars: unknown) => cancelMutateMock(vars) },
    },
    organizations: {
      securityAgent: {
        cancelRemediation: { mutate: (vars: unknown) => orgCancelMutateMock(vars) },
      },
    },
  },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('useCancelSecurityRemediation (generation guard)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    cancelMutateMock.mockReset();
    orgCancelMutateMock.mockReset();
    invalidateQueriesMock.mockReset();
    getQueryDataMock.mockReset();
    setQueryDataMock.mockReset();
    cancelQueriesMock.mockReset();
    toastErrorMock.mockReset();
    toastSuccessMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('has no scope (rule 4: concurrent cancels write different findings)', () => {
    useCancelSecurityRemediation('personal');
    expect(lastCapturedOptions?.scope).toBeUndefined();
  });

  it('a failing older cancel does not roll back while a newer cancel owns the finding', async () => {
    getQueryDataMock.mockReturnValue({
      remediationAttempts: [{ id: 'a1', cancellationRequestedAt: null }],
    });
    useCancelSecurityRemediation('personal');
    const older = await lastCapturedOptions?.onMutate?.({ attemptId: 'a1', findingId: 'f1' });
    const newer = await lastCapturedOptions?.onMutate?.({ attemptId: 'a1', findingId: 'f1' });

    setQueryDataMock.mockClear();
    lastCapturedOptions?.onError?.(new Error('boom'), { attemptId: 'a1', findingId: 'f1' }, older);
    expect(setQueryDataMock).not.toHaveBeenCalled();

    lastCapturedOptions?.onError?.(new Error('boom'), { attemptId: 'a1', findingId: 'f1' }, newer);
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    // The toast fires regardless of which generation failed.
    expect(toastErrorMock).toHaveBeenCalledTimes(2);
  });

  it('a failing latest cancel rolls back its snapshot', async () => {
    getQueryDataMock.mockReturnValue({
      remediationAttempts: [{ id: 'a1', cancellationRequestedAt: null }],
    });
    useCancelSecurityRemediation('personal');
    const context = await lastCapturedOptions?.onMutate?.({ attemptId: 'a1', findingId: 'f1' });

    setQueryDataMock.mockClear();
    lastCapturedOptions?.onError?.(
      new Error('boom'),
      { attemptId: 'a1', findingId: 'f1' },
      context
    );
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith('boom');
  });

  it('keys the generation guard per finding', async () => {
    getQueryDataMock.mockReturnValue({ remediationAttempts: [] });
    useCancelSecurityRemediation('personal');
    // Different findings write different analysis query keys, so the first
    // finding's failure still rolls back after a second finding was written.
    const findingA = await lastCapturedOptions?.onMutate?.({ attemptId: 'a1', findingId: 'f1' });
    const findingB = await lastCapturedOptions?.onMutate?.({ attemptId: 'a2', findingId: 'f2' });
    void findingB;

    setQueryDataMock.mockClear();
    lastCapturedOptions?.onError?.(
      new Error('boom'),
      { attemptId: 'a1', findingId: 'f1' },
      findingA
    );
    expect(setQueryDataMock).toHaveBeenCalledTimes(1);
  });

  it('delegates an org cancel to organizations.securityAgent.cancelRemediation', async () => {
    orgCancelMutateMock.mockResolvedValueOnce({ status: 'cancelled' });
    useCancelSecurityRemediation(ORG_ID);

    await lastCapturedOptions?.mutationFn?.({ attemptId: 'a1', findingId: 'f1' });

    expect(orgCancelMutateMock).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      attemptId: 'a1',
    });
  });
});

const REMEDIATION_FALLBACK_KEY = 'securityAgent.remediation.unavailable';

// The expected reason → catalog-key mapping is read from the shared table in
// packages/app-shared instead of a hand-maintained fixture: a reason added
// there makes the lookup fall back to the generic copy and fails this test
// until the mobile map and its catalog key exist.
describe('getRemediationUnavailableKey', () => {
  it('returns null for an absent or eligible reason', () => {
    expect(getRemediationUnavailableKey(null)).toBeNull();
    expect(getRemediationUnavailableKey(undefined)).toBeNull();
    expect(getRemediationUnavailableKey('')).toBeNull();
    expect(getRemediationUnavailableKey('eligible')).toBeNull();
  });

  it.each(Object.entries(REMEDIATION_UNAVAILABLE_COPY))(
    'maps %s to a catalog key holding the shared copy',
    (reason, copy) => {
      // A reason missing from the mobile map resolves to the generic key,
      // which fails the assertion below.
      const catalogKey = getRemediationUnavailableKey(reason) ?? REMEDIATION_FALLBACK_KEY;
      expect(catalogKey).not.toBe(REMEDIATION_FALLBACK_KEY);
      expect(i18n.t(catalogKey)).toBe(copy);
    }
  );

  it('falls back to the generic key for an unknown or inherited name', () => {
    expect(getRemediationUnavailableKey('not_a_reason')).toBe(REMEDIATION_FALLBACK_KEY);
    // Object.hasOwn, not `in`: inherited prototype members must not leak.
    expect(getRemediationUnavailableKey('constructor')).toBe(REMEDIATION_FALLBACK_KEY);
    expect(getRemediationUnavailableKey('toString')).toBe(REMEDIATION_FALLBACK_KEY);
    expect(i18n.t(REMEDIATION_FALLBACK_KEY)).not.toBe(REMEDIATION_FALLBACK_KEY);
  });
});
