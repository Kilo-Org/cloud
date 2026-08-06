// P1-A-08e wiring tests for `useOrganizationMutations`.
//
// The org surfaces (member-row action sheet, member-limit sheet) own their
// inline/toast error rendering; these tests assert the HOOK WIRING: the
// role-change and member-removal `mutationFn`s delegate to the matching
// `trpcClient.organizations.members.*.mutate`, the hoisted operation key is
// merged into the ledger-backed inputs (role change and removal only — a
// limit-only update carries no key), and the key rotation policy (real
// `isOrganizationMutationRetryable` + `mapOrganizationOperationError`) runs
// inside `mutationFn`. Only `useHoistedOperationKey` is mocked (it holds React
// ref state that needs a mounted renderer).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as PrOperationLedgerModule from '@/lib/pr-review/merge/pr-operation-ledger';
import {
  isOrganizationMutationRetryable,
  mapOrganizationOperationError,
  organizationRemoveMemberIntentFingerprint,
  organizationRoleChangeIntentFingerprint,
  useOrganizationMutations,
} from './use-organization-mutations';

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

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown) => void;
  onSettled?: (data?: unknown, error?: unknown, vars?: unknown) => Promise<void> | void;
};

// The hook body mounts six useMutation calls in a fixed order:
// rename, invite, updateMember, removeMember, deleteInvite, updateMinimumBalanceAlert.
let capturedOptions: MutationOptions[] = [];
const membersUpdateMutateMock = vi.fn();
const membersRemoveMutateMock = vi.fn();
const orgUpdateMutateMock = vi.fn();
const inviteMutateMock = vi.fn();
const deleteInviteMutateMock = vi.fn();
const updateMinimumBalanceAlertMutateMock = vi.fn();
const invalidateQueriesMock = vi.fn();
const setQueryDataMock = vi.fn();
const getQueryDataMock = vi.fn();
const cancelQueriesMock = vi.fn();
const toastErrorMock = vi.fn();

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    capturedOptions.push(opts);
    return {
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
      isError: false,
      error: undefined,
    };
  },
  useQueryClient: () => ({
    invalidateQueries: (...args: unknown[]) => {
      invalidateQueriesMock(...args);
    },
    setQueryData: (...args: unknown[]) => {
      setQueryDataMock(...args);
    },
    getQueryData: (...args: unknown[]) => {
      getQueryDataMock(...args);
    },
    cancelQueries: (...args: unknown[]) => {
      cancelQueriesMock(...args);
    },
  }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: {
      withMembers: { queryKey: () => ['organizations', 'withMembers'] },
      list: { queryKey: () => ['organizations', 'list'] },
    },
  }),
  trpcClient: {
    organizations: {
      update: { mutate: (vars: unknown) => orgUpdateMutateMock(vars) },
      members: {
        invite: { mutate: (vars: unknown) => inviteMutateMock(vars) },
        update: { mutate: (vars: unknown) => membersUpdateMutateMock(vars) },
        remove: { mutate: (vars: unknown) => membersRemoveMutateMock(vars) },
        deleteInvite: { mutate: (vars: unknown) => deleteInviteMutateMock(vars) },
      },
      settings: {
        updateMinimumBalanceAlert: {
          mutate: (vars: unknown) => updateMinimumBalanceAlertMutateMock(vars),
        },
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

const updateMemberOptions = () => capturedOptions[2];
const removeMemberOptions = () => capturedOptions[3];

beforeEach(() => {
  capturedOptions = [];
  membersUpdateMutateMock.mockReset();
  membersRemoveMutateMock.mockReset();
  invalidateQueriesMock.mockReset();
  toastErrorMock.mockReset();
  hoistedKeys.getKey.mockClear();
  hoistedKeys.rotateKey.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useOrganizationMutations updateMember (P1-A-08e role branch)', () => {
  it('mounts a useMutation with a custom mutationFn', () => {
    useOrganizationMutations(ORG_ID);
    expect(updateMemberOptions()?.mutationFn).toBeDefined();
  });

  it('delegates a role change to members.update.mutate and resolves the result', async () => {
    const result = { success: true, updated: 'role and limit' };
    membersUpdateMutateMock.mockResolvedValueOnce(result);
    useOrganizationMutations(ORG_ID);

    await expect(
      updateMemberOptions()?.mutationFn?.({ memberId: 'member-1', role: 'owner' })
    ).resolves.toEqual(result);
    expect(membersUpdateMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        memberId: 'member-1',
        role: 'owner',
      })
    );
  });

  it('merges the hoisted operation key into a role change (P1-A-08e)', async () => {
    membersUpdateMutateMock.mockResolvedValueOnce({ success: true, updated: 'role' });
    useOrganizationMutations(ORG_ID);

    await updateMemberOptions()?.mutationFn?.({ memberId: 'member-1', role: 'billing_manager' });

    expect(hoistedKeys.getKey).toHaveBeenCalled();
    expect(membersUpdateMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: 'hoisted-op-key' })
    );
  });

  it('does not attach an operation key or rotate the hoisted key on a limit-only update (success or failure)', async () => {
    const badRequest = new Error('limit update rejected');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    membersUpdateMutateMock
      .mockResolvedValueOnce({ success: true, updated: 'limit' })
      .mockRejectedValueOnce(badRequest);
    useOrganizationMutations(ORG_ID);

    await updateMemberOptions()?.mutationFn?.({ memberId: 'member-1', dailyUsageLimitUsd: 25 });
    await expect(
      updateMemberOptions()?.mutationFn?.({ memberId: 'member-1', dailyUsageLimitUsd: 30 })
    ).rejects.toMatchObject({ message: 'limit update rejected' });

    // A limit-only update never runs a keyed role mutation: it must not read
    // or rotate the hoisted key, even when it fails, so a pending role-change
    // key survives for another intent.
    expect(hoistedKeys.getKey).not.toHaveBeenCalled();
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
    expect(membersUpdateMutateMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ operationKey: expect.any(String) })
    );
  });

  it('regenerates the key after a successful role change (fresh intent next)', async () => {
    membersUpdateMutateMock.mockResolvedValueOnce({ success: true });
    useOrganizationMutations(ORG_ID);

    await updateMemberOptions()?.mutationFn?.({ memberId: 'member-1', role: 'owner' });

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on retryable failures (in-progress, network, settle-failed)', async () => {
    // Each scenario rejects the role change with a retryable outcome; the
    // ledger owns the same-key retry, so the hoisted key must survive. The
    // in-progress marker is mapped onto the retryable copy before surfacing.
    const retryable: [raw: string, expected: string][] = [
      ['operation_in_progress', 'This change is still being processed. Please try again.'],
      ['Network request failed', 'Network request failed'],
      [
        'The action completed, but we could not record the result. Please try again.',
        'The action completed, but we could not record the result. Please try again.',
      ],
    ];
    useOrganizationMutations(ORG_ID);
    await Promise.all(
      retryable.map(async ([raw, expected]) => {
        membersUpdateMutateMock.mockRejectedValueOnce(new Error(raw));
        await expect(
          updateMemberOptions()?.mutationFn?.({ memberId: 'member-1', role: 'owner' })
        ).rejects.toMatchObject({ message: expected });
      })
    );
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable failure (bad-request ends the intent)', async () => {
    const badRequest = new Error('This action did not complete. Please try again.');
    Object.assign(badRequest, { data: { code: 'BAD_REQUEST' } });
    membersUpdateMutateMock.mockRejectedValueOnce(badRequest);
    useOrganizationMutations(ORG_ID);

    await expect(
      updateMemberOptions()?.mutationFn?.({ memberId: 'member-1', role: 'owner' })
    ).rejects.toMatchObject({ message: 'This action did not complete. Please try again.' });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });
});

describe('useOrganizationMutations removeMember (P1-A-08e)', () => {
  it('delegates the removal to members.remove.mutate with the hoisted key', async () => {
    membersRemoveMutateMock.mockResolvedValueOnce({ success: true, updated: 'member-1' });
    useOrganizationMutations(ORG_ID);

    await expect(removeMemberOptions()?.mutationFn?.({ memberId: 'member-1' })).resolves.toEqual({
      success: true,
      updated: 'member-1',
    });
    expect(hoistedKeys.getKey).toHaveBeenCalled();
    expect(membersRemoveMutateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_ID,
        memberId: 'member-1',
        operationKey: 'hoisted-op-key',
      })
    );
  });

  it('regenerates the key after a successful removal', async () => {
    membersRemoveMutateMock.mockResolvedValueOnce({ success: true });
    useOrganizationMutations(ORG_ID);

    await removeMemberOptions()?.mutationFn?.({ memberId: 'member-1' });

    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('keeps the key on an in-progress CONFLICT (retryable) and maps the marker', async () => {
    membersRemoveMutateMock.mockRejectedValueOnce(new Error('operation_in_progress'));
    useOrganizationMutations(ORG_ID);

    await expect(
      removeMemberOptions()?.mutationFn?.({ memberId: 'member-1' })
    ).rejects.toMatchObject({
      message: 'This change is still being processed. Please try again.',
    });
    expect(hoistedKeys.rotateKey).not.toHaveBeenCalled();
  });

  it('regenerates the key on a non-retryable rejection', async () => {
    const forbidden = new Error('no permission');
    Object.assign(forbidden, { data: { code: 'FORBIDDEN' } });
    membersRemoveMutateMock.mockRejectedValueOnce(forbidden);
    useOrganizationMutations(ORG_ID);

    await expect(
      removeMemberOptions()?.mutationFn?.({ memberId: 'member-1' })
    ).rejects.toMatchObject({ message: 'no permission' });
    expect(hoistedKeys.rotateKey).toHaveBeenCalledTimes(1);
  });

  it('onError still surfaces the mapped message through the existing toast path', () => {
    useOrganizationMutations(ORG_ID);
    const mapped = mapOrganizationOperationError(new Error('operation_in_progress'));
    removeMemberOptions()?.onError?.(mapped);
    expect(toastErrorMock).toHaveBeenCalledWith(
      'This change is still being processed. Please try again.'
    );
  });
});

describe('organizationRoleChangeIntentFingerprint (P1-A-08e changed-input)', () => {
  it('stays stable for a retry of the same target+role and rotates when any intent input changes', () => {
    const original = organizationRoleChangeIntentFingerprint(ORG_ID, 'member-1', 'owner');
    expect(organizationRoleChangeIntentFingerprint(ORG_ID, 'member-1', 'owner')).toBe(original);

    expect(organizationRoleChangeIntentFingerprint(ORG_ID, 'member-1', 'member')).not.toBe(
      original
    );
    expect(organizationRoleChangeIntentFingerprint(ORG_ID, 'member-2', 'owner')).not.toBe(original);
    expect(organizationRoleChangeIntentFingerprint('other-org', 'member-1', 'owner')).not.toBe(
      original
    );
  });
});

describe('organizationRemoveMemberIntentFingerprint (P1-A-08e changed-input)', () => {
  it('stays stable for a retry of the same member and rotates when the member or org changes', () => {
    const original = organizationRemoveMemberIntentFingerprint(ORG_ID, 'member-1');
    expect(organizationRemoveMemberIntentFingerprint(ORG_ID, 'member-1')).toBe(original);

    expect(organizationRemoveMemberIntentFingerprint(ORG_ID, 'member-2')).not.toBe(original);
    expect(organizationRemoveMemberIntentFingerprint('other-org', 'member-1')).not.toBe(original);
  });
});

describe('isOrganizationMutationRetryable (P1-A-08e key-rotation policy)', () => {
  it('keeps the key on retryable ledger outcomes (in-progress, settle-failed)', () => {
    expect(isOrganizationMutationRetryable(new Error('operation_in_progress'))).toBe(true);
    expect(
      isOrganizationMutationRetryable(
        new Error('The action completed, but we could not record the result. Please try again.')
      )
    ).toBe(true);
  });

  it('keeps the key on generic retryable failures', () => {
    expect(isOrganizationMutationRetryable(new Error('Network request failed'))).toBe(true);
    const server = new Error('boom');
    Object.assign(server, { data: { code: 'INTERNAL_SERVER_ERROR' } });
    expect(isOrganizationMutationRetryable(server)).toBe(true);
  });

  it('regenerates the key on non-retryable markers and typed rejections', () => {
    const replayFailed = new Error('This action did not complete. Please try again.');
    Object.assign(replayFailed, { data: { code: 'BAD_REQUEST' } });
    expect(isOrganizationMutationRetryable(replayFailed)).toBe(false);
    expect(isOrganizationMutationRetryable(new Error('operation_key_reuse_mismatch'))).toBe(false);

    const forbidden = new Error('no permission');
    Object.assign(forbidden, { data: { code: 'FORBIDDEN' } });
    expect(isOrganizationMutationRetryable(forbidden)).toBe(false);
  });

  it('keeps the key on NOT_FOUND (same-key retry replays the typed rejection and then rotates)', () => {
    // Mirrors the PR ledger policy: NOT_FOUND is a generic retryable code, so
    // the key survives; the next same-key retry hits the settled-failed row
    // and rotates on the replay-failed BAD_REQUEST instead.
    const notFound = new Error('User is not a member of this organization');
    Object.assign(notFound, { data: { code: 'NOT_FOUND' } });
    expect(isOrganizationMutationRetryable(notFound)).toBe(true);
  });
});
