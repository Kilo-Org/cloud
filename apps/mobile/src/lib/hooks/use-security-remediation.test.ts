import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCancelSecurityRemediation } from './use-security-remediation';

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

vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
  getRemediationUnavailableCopy: () => null,
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
