// P1-A-08e wiring tests for `useDismissSecurityFinding`.
//
// The dismiss screen owns the inline error copy; these tests assert the HOOK
// WIRING: the `mutationFn` delegates to the matching
// `trpcClient.(organizations.)securityAgent.dismissFinding.mutate`, the
// hoisted operation key is merged into the input, and the key rotation policy
// (real `isSecuritySyncRetryable` — the dismiss and sync procedures share the
// same security ledger) runs inside `mutationFn`. Only
// `useHoistedOperationKey` is mocked (it holds React ref state that needs a
// mounted renderer).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as OperationKeyModule from '@/lib/operation-key';
import {
  dismissFindingIntentFingerprint,
  useDismissSecurityFinding,
} from './use-security-findings';

const hoistedKeys = vi.hoisted(() => ({
  getKey: vi.fn(() => 'hoisted-op-key'),
  rotateKey: vi.fn(),
}));

const trackCommandMock = vi.hoisted(() => vi.fn());
const toastErrorMock = vi.fn();

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/operation-key', async importOriginal => {
  const actual = await importOriginal<typeof OperationKeyModule>();
  return { ...actual, useHoistedOperationKey: () => hoistedKeys };
});

vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
  getNextSecurityFindingsOffset: () => undefined,
  getRemediationUnavailableCopy: () => undefined,
  isActiveRemediationStatus: () => false,
}));

vi.mock('@/lib/hooks/use-security-agent-commands', () => ({
  trackSecurityAgentCommand: trackCommandMock,
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (msg: string) => toastErrorMock(msg),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

vi.mock('sonner-native', () => ({
  toast: { error: (msg: string) => toastErrorMock(msg) },
}));

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown) => void;
  onSuccess?: (result: unknown, vars: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
  onMutate?: (vars: unknown) => unknown;
};

let lastCapturedOptions: MutationOptions | null = null;
const personalDismissMutateMock = vi.fn();
const orgDismissMutateMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, error: null };
  },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
    cancelQueries: vi.fn(),
  }),
  useInfiniteQuery: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    securityAgent: {
      getFinding: { queryKey: () => ['securityAgent', 'getFinding'] },
      getAnalysis: { queryKey: () => ['securityAgent', 'getAnalysis'] },
      listFindings: { queryKey: () => ['securityAgent', 'listFindings'] },
      getDashboardStats: { queryKey: () => ['securityAgent', 'getDashboardStats'] },
    },
    organizations: {
      securityAgent: {
        getFinding: { queryKey: () => ['securityAgent', 'getFinding'] },
        getAnalysis: { queryKey: () => ['securityAgent', 'getAnalysis'] },
        listFindings: { queryKey: () => ['securityAgent', 'listFindings'] },
        getDashboardStats: { queryKey: () => ['securityAgent', 'getDashboardStats'] },
      },
    },
  }),
  trpcClient: {
    securityAgent: {
      dismissFinding: { mutate: (vars: unknown) => personalDismissMutateMock(vars) },
    },
    organizations: {
      securityAgent: {
        dismissFinding: { mutate: (vars: unknown) => orgDismissMutateMock(vars) },
      },
    },
  },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FINDING_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DISMISS_VARS = {
  findingId: FINDING_ID,
  reason: 'not_used',
  comment: 'retired code',
} as const;

describe('useDismissSecurityFinding (P1-A-08e wiring)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    personalDismissMutateMock.mockReset();
    orgDismissMutateMock.mockReset();
    toastErrorMock.mockReset();
    trackCommandMock.mockClear();
    hoistedKeys.getKey.mockClear();
    hoistedKeys.rotateKey.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('delegates a personal dismissal to securityAgent.dismissFinding.mutate with the hoisted key', async () => {
    const result = { success: true, accepted: true, commandId: 'cmd-1' };
    personalDismissMutateMock.mockResolvedValueOnce(result);
    useDismissSecurityFinding('personal');

    await expect(lastCapturedOptions?.mutationFn?.(DISMISS_VARS)).resolves.toEqual(result);

    expect(hoistedKeys.getKey).toHaveBeenCalled();
    expect(personalDismissMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        findingId: FINDING_ID,
        reason: 'not_used',
        comment: 'retired code',
        operationKey: 'hoisted-op-key',
      })
    );
  });

  it('delegates an org dismissal to organizations.securityAgent.dismissFinding.mutate with the key', async () => {
    orgDismissMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-2' });
    useDismissSecurityFinding(ORG_ID);

    await lastCapturedOptions?.mutationFn?.(DISMISS_VARS);

    expect(orgDismissMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        findingId: FINDING_ID,
        operationKey: 'hoisted-op-key',
      })
    );
  });

  it('regenerates the key after a successful dismissal (fresh intent next)', async () => {
    personalDismissMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-1' });
    useDismissSecurityFinding('personal');

    await lastCapturedOptions?.mutationFn?.(DISMISS_VARS);

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto retryable copy', async () => {
    personalDismissMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useDismissSecurityFinding('personal');

    await expect(lastCapturedOptions?.mutationFn?.(DISMISS_VARS)).rejects.toMatchObject({
      message: 'This dismissal is already in progress. Please try again.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  // The rest of the retryability matrix belongs to `isSecuritySyncRetryable`
  // (tested in use-security-agent-mutations.test.ts); the hook only needs one
  // retryable and one terminal case.
  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('Invalid dismissal reason');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    personalDismissMutateMock.mockRejectedValueOnce(badRequest);
    useDismissSecurityFinding('personal');

    await expect(lastCapturedOptions?.mutationFn?.(DISMISS_VARS)).rejects.toMatchObject({
      message: 'Invalid dismissal reason',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('onSuccess tracks the accepted command', () => {
    useDismissSecurityFinding('personal');
    lastCapturedOptions?.onSuccess?.({ success: true, commandId: 'cmd-9' }, DISMISS_VARS);
    expect(trackCommandMock).toHaveBeenCalled();
  });
});

describe('dismissFindingIntentFingerprint (P1-A-08e changed-input)', () => {
  it('stays stable for a retry of the same scope+finding and rotates when any intent input changes', () => {
    const original = dismissFindingIntentFingerprint('personal', DISMISS_VARS);
    expect(dismissFindingIntentFingerprint('personal', DISMISS_VARS)).toBe(original);

    expect(
      dismissFindingIntentFingerprint('personal', { ...DISMISS_VARS, findingId: FINDING_ID })
    ).toBe(original);
    expect(
      dismissFindingIntentFingerprint('personal', { ...DISMISS_VARS, comment: 'edited' })
    ).not.toBe(original);
    expect(
      dismissFindingIntentFingerprint('personal', { ...DISMISS_VARS, reason: 'inaccurate' })
    ).not.toBe(original);
    expect(dismissFindingIntentFingerprint(ORG_ID, DISMISS_VARS)).not.toBe(original);
  });
});
