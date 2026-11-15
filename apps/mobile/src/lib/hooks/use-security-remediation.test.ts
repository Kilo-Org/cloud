import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OrganizationsModule from '@kilocode/app-shared/organizations';
import type * as ReactI18nextModule from 'react-i18next';
import type * as SecurityAgentModule from '@kilocode/app-shared/security-agent';

import { useCancelSecurityRemediation } from './use-security-remediation';
import { REMEDIATION_UNAVAILABLE_COPY } from '@kilocode/app-shared/security-agent';
import { i18n } from '@/i18n';
import { getRemediationUnavailableKey } from '@/lib/security-agent-copy';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

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

vi.mock('@/lib/query/schedule-cache-maintenance', () => ({ scheduleCacheMaintenance: vi.fn() }));

// The remediation hooks read the reader's role and the step it offers through
// the organization query chain and `expo-router`, and the label through
// `useTranslation`; this pure project mounts no renderer and has no Expo
// build, so those three boundaries are stubbed. The boundary double applies
// the real `isMoneyRole` rule to whatever role a case sets.
const trialRole = vi.hoisted(() => ({ role: undefined as string | undefined }));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks/use-organization-queries', async () => {
  const { canManageOrganizationBilling } =
    await vi.importActual<typeof OrganizationsModule>('@kilocode/app-shared/organizations');
  return {
    isMoneyRole: canManageOrganizationBilling,
    useOrgBoundary: () => ({ role: trialRole.role }),
  };
});
vi.mock('react-i18next', async importOriginal => ({
  ...(await importOriginal<typeof ReactI18nextModule>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('sonner-native', () => ({
  toast: {
    error: (msg: string) => toastErrorMock(msg),
    success: (msg: string) => toastSuccessMock(msg),
  },
}));

// The adapter's own module reaches `react-native` for its accessibility
// announcement, which this pure project cannot parse; the double forwards the
// options the way the real adapter does, so a bare copy and a toast carrying a
// step stay distinguishable.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (msg: string, options?: unknown) =>
      options === undefined ? toastErrorMock(msg) : toastErrorMock(msg, options),
    success: (msg: string) => toastSuccessMock(msg),
    warning: vi.fn(),
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
    trialRole.role = undefined;
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

// The cancel hook reports through the same refusal toast as start/retry: the
// sentence comes from the catalog for this reader's role, and only the trial
// refusal for a billing role carries the step that ends it.
describe('useCancelSecurityRemediation (refusal copy follows the reader)', () => {
  const CANCEL_VARS = { attemptId: 'a1', findingId: 'f1' } as const;
  const BILLING_ACTION_LABEL = 'organization.hub.manageBilling';

  beforeEach(() => {
    lastCapturedOptions = null;
    trialRole.role = undefined;
    toastErrorMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('offers the plan step with the billing copy to a role that can change the plan', () => {
    trialRole.role = 'owner';
    useCancelSecurityRemediation(ORG_ID);

    lastCapturedOptions?.onError?.(
      new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE),
      CANCEL_VARS,
      undefined
    );

    expect(toastErrorMock).toHaveBeenCalledWith(i18n.t('common.organizationTrialEndedBilling'), {
      action: { label: BILLING_ACTION_LABEL, onClick: expect.any(Function) },
    });
    // The step's label is real catalog copy, not just a key a screen would
    // render raw.
    expect(i18n.t(BILLING_ACTION_LABEL)).not.toBe(BILLING_ACTION_LABEL);
  });

  it('names the owner and offers no step to a reader who cannot change the plan', () => {
    trialRole.role = 'member';
    useCancelSecurityRemediation(ORG_ID);

    lastCapturedOptions?.onError?.(
      new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE),
      CANCEL_VARS,
      undefined
    );

    expect(toastErrorMock).toHaveBeenCalledWith(i18n.t('common.organizationTrialEnded'));
  });

  it('keeps an unrelated failure its own copy and offers no step', () => {
    trialRole.role = 'owner';
    useCancelSecurityRemediation(ORG_ID);

    lastCapturedOptions?.onError?.(new Error('Cancel failed'), CANCEL_VARS, undefined);

    expect(toastErrorMock).toHaveBeenCalledWith('Cancel failed');
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
