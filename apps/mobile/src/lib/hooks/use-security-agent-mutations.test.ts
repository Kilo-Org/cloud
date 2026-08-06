// P1-A-08e wiring tests for `useTriggerSecuritySync`.
//
// The dashboard owns the sync button and its toasts; these tests assert the
// HOOK WIRING: the `mutationFn` delegates to the matching
// `trpcClient.(organizations.)securityAgent.triggerSync.mutate`, the hoisted
// operation key is merged into the input, and the key rotation policy (real
// `isSecuritySyncRetryable` + `mapSecuritySyncOperationError`) runs inside
// `mutationFn`. Only `useHoistedOperationKey` is mocked (it holds React ref
// state that needs a mounted renderer).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PrOperationLedgerModule from '@/lib/pr-review/merge/pr-operation-ledger';
import {
  isSecuritySyncRetryable,
  mapSecuritySyncOperationError,
  securitySyncIntentFingerprint,
  useTriggerSecuritySync,
} from './use-security-agent-mutations';

const hoistedKeys = vi.hoisted(() => ({
  getKey: vi.fn(() => 'hoisted-op-key'),
  rotateKey: vi.fn(),
}));

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'not-used',
}));

vi.mock('@/lib/pr-review/merge/pr-operation-ledger', async importOriginal => {
  const actual = await importOriginal<typeof PrOperationLedgerModule>();
  return { ...actual, useHoistedOperationKey: () => hoistedKeys };
});

vi.mock('@kilocode/app-shared/security-agent', () => ({
  isPersonalSecurityScope: (scope: string) => scope === 'personal',
}));

vi.mock('@/lib/hooks/use-security-agent-commands', () => ({
  trackSecurityAgentCommand: trackCommandMock,
}));

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown) => void;
  onSuccess?: (result: unknown, vars: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
};

let lastCapturedOptions: MutationOptions | null = null;
const personalTriggerSyncMutateMock = vi.fn();
const orgTriggerSyncMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const toastErrorMock = vi.fn();
const trackCommandMock = vi.hoisted(() => vi.fn());

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    lastCapturedOptions = opts;
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    securityAgent: { getConfig: { queryKey: () => ['securityAgent', 'getConfig'] } },
  }),
  trpcClient: {
    securityAgent: {
      triggerSync: { mutate: (vars: unknown) => personalTriggerSyncMutateMock(vars) },
    },
    organizations: {
      securityAgent: {
        triggerSync: { mutate: (vars: unknown) => orgTriggerSyncMutateMock(vars) },
      },
    },
  },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: {
    error: (msg: string) => toastErrorMock(msg),
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

const ORG_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('useTriggerSecuritySync (P1-A-08e wiring)', () => {
  beforeEach(() => {
    lastCapturedOptions = null;
    personalTriggerSyncMutateMock.mockReset();
    orgTriggerSyncMutateMock.mockReset();
    invalidateQueriesMock.mockReset();
    toastErrorMock.mockReset();
    trackCommandMock.mockClear();
    hoistedKeys.getKey.mockClear();
    hoistedKeys.rotateKey.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('mounts a useMutation with a custom mutationFn', () => {
    useTriggerSecuritySync('personal');
    expect(lastCapturedOptions?.mutationFn).toBeDefined();
  });

  it('delegates a personal sync to securityAgent.triggerSync.mutate with the hoisted key', async () => {
    const result = { success: true, accepted: true, commandId: 'cmd-1' };
    personalTriggerSyncMutateMock.mockResolvedValueOnce(result);
    useTriggerSecuritySync('personal');

    await expect(lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })).resolves.toEqual(
      result
    );

    expect(hoistedKeys.getKey).toHaveBeenCalled();
    expect(personalTriggerSyncMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoFullName: 'kilo/repo', operationKey: 'hoisted-op-key' })
    );
  });

  it('delegates an org sync to organizations.securityAgent.triggerSync.mutate with the key', async () => {
    orgTriggerSyncMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-2' });
    useTriggerSecuritySync(ORG_ID);

    await lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' });

    expect(orgTriggerSyncMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        repoFullName: 'kilo/repo',
        operationKey: 'hoisted-op-key',
      })
    );
  });

  it('regenerates the key after a successful sync (fresh intent next)', async () => {
    personalTriggerSyncMutateMock.mockResolvedValueOnce({ success: true, commandId: 'cmd-1' });
    useTriggerSecuritySync('personal');

    await lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' });

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT and maps it onto retryable copy', async () => {
    personalTriggerSyncMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({
      message: 'A security sync is already in progress. Please try again.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('keeps the key on the ambiguous outcome (same-key retry reconciles)', async () => {
    personalTriggerSyncMutateMock.mockRejectedValueOnce(
      new Error("Couldn't confirm — check the security review before retrying.")
    );
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({
      message: "Couldn't confirm — check the security review before retrying.",
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('keeps the key on a retryable network failure (the ledger owns the retry)', async () => {
    personalTriggerSyncMutateMock.mockRejectedValueOnce(new Error('Network request failed'));
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({ message: 'Network request failed' });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (replay-failed ends the intent)', async () => {
    const replayFailed = new Error('This action did not complete. Please try again.');
    Object.assign(replayFailed, { data: { code: 'BAD_REQUEST' } });
    personalTriggerSyncMutateMock.mockRejectedValueOnce(replayFailed);
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({ message: 'This action did not complete. Please try again.' });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('regenerates the key on the persistence-failure marker even though it is INTERNAL_SERVER_ERROR', async () => {
    const persistenceFailed = new Error('We could not record this action. Please try again later.');
    Object.assign(persistenceFailed, { data: { code: 'INTERNAL_SERVER_ERROR' } });
    personalTriggerSyncMutateMock.mockRejectedValueOnce(persistenceFailed);
    useTriggerSecuritySync('personal');

    await expect(
      lastCapturedOptions?.mutationFn?.({ repoFullName: 'kilo/repo' })
    ).rejects.toMatchObject({
      message: 'We could not record this action. Please try again later.',
    });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('onError toasts the mapped message through the existing toast path', () => {
    useTriggerSecuritySync('personal');
    lastCapturedOptions?.onError?.(
      mapSecuritySyncOperationError(new Error('operation_in_progress'))
    );
    expect(toastErrorMock).toHaveBeenCalledWith(
      'A security sync is already in progress. Please try again.'
    );
  });

  it('onSuccess tracks the accepted command', () => {
    useTriggerSecuritySync('personal');
    lastCapturedOptions?.onSuccess?.(
      { success: true, commandId: 'cmd-9' },
      { repoFullName: 'kilo/repo' }
    );
    expect(trackCommandMock).toHaveBeenCalled();
  });
});

describe('securitySyncIntentFingerprint (P1-A-08e changed-input)', () => {
  it('stays stable for a retry of the same scope+repo and rotates when the repo or scope changes', () => {
    const original = securitySyncIntentFingerprint(ORG_ID, 'kilo/repo');
    expect(securitySyncIntentFingerprint(ORG_ID, 'kilo/repo')).toBe(original);

    expect(securitySyncIntentFingerprint(ORG_ID, 'kilo/other')).not.toBe(original);
    expect(securitySyncIntentFingerprint(ORG_ID, undefined)).not.toBe(original);
    expect(securitySyncIntentFingerprint('personal', 'kilo/repo')).not.toBe(original);
  });
});

describe('isSecuritySyncRetryable (P1-A-08e key-rotation policy)', () => {
  it('keeps the key on retryable ledger outcomes (in-progress, ambiguous, settle-failed)', () => {
    expect(isSecuritySyncRetryable(new Error('operation_in_progress'))).toBe(true);
    expect(
      isSecuritySyncRetryable(
        new Error("Couldn't confirm — check the security review before retrying.")
      )
    ).toBe(true);
    expect(
      isSecuritySyncRetryable(
        new Error('The action completed, but we could not record the result. Please try again.')
      )
    ).toBe(true);
  });

  it('keeps the key on generic retryable failures', () => {
    expect(isSecuritySyncRetryable(new Error('Network request failed'))).toBe(true);
  });

  it('regenerates the key on non-retryable markers and typed rejections', () => {
    expect(
      isSecuritySyncRetryable(new Error('We could not record this action. Please try again later.'))
    ).toBe(false);
    expect(isSecuritySyncRetryable(new Error('operation_key_reuse_mismatch'))).toBe(false);
    const replayFailed = new Error('This action did not complete. Please try again.');
    Object.assign(replayFailed, { data: { code: 'BAD_REQUEST' } });
    expect(isSecuritySyncRetryable(replayFailed)).toBe(false);
    const forbidden = new Error('no permission');
    Object.assign(forbidden, { data: { code: 'FORBIDDEN' } });
    expect(isSecuritySyncRetryable(forbidden)).toBe(false);
    const repoUnknown = new Error('Repository not found in your GitHub integration');
    Object.assign(repoUnknown, { data: { code: 'PRECONDITION_FAILED' } });
    expect(isSecuritySyncRetryable(repoUnknown)).toBe(false);
  });
});
