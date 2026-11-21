import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canResendInvite,
  emailStatusLabel,
  getInviteSuccessMessage,
  invitedMemberActionOptions,
  useResendInvite,
} from '@/components/organization/invited-member-row-state';
import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';

// The state module now imports the resend mutation hook, which pulls in
// `@/lib/trpc` (native modules) and `@tanstack/react-query`. Mock those so the
// pure `emailStatusLabel` tests and the hook wiring test both run in node.
const resendInviteMutateMock = vi.fn();
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
  onError?: (error: unknown) => void;
};
let capturedOptions: MutationOptions | null = null;

vi.mock('@tanstack/react-query', () => ({
  useMutation: (opts: MutationOptions) => {
    capturedOptions = opts;
    return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false };
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    organizations: { withMembers: { queryKey: () => ['withMembers'] } },
  }),
  trpcClient: {
    organizations: {
      members: {
        resendInvite: { mutate: (vars: unknown) => resendInviteMutateMock(vars) },
      },
    },
  },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({ announcingToast: toast }));

// The role read lives beside the refusal hooks; this suite drives the role
// directly so the toast's copy and step are the only things under test.
type BillingAction = { label: string; onPress: () => void };
type RoleState = { canManageBilling: boolean; action: BillingAction | undefined };

const role = vi.hoisted(() => {
  const state: RoleState = {
    canManageBilling: true,
    action: { label: 'Manage billing', onPress: vi.fn<() => void>() },
  };
  return state;
});

vi.mock('@/lib/trial-refusal', () => ({
  useCanManageBilling: () => role.canManageBilling,
  useBillingAction: () => role.action,
}));

describe('emailStatusLabel', () => {
  it('maps pending and sending to Pending', () => {
    expect(emailStatusLabel('pending')).toBe('Pending');
    expect(emailStatusLabel('sending')).toBe('Pending');
  });

  it('maps failed to Email failed', () => {
    expect(emailStatusLabel('failed')).toBe('Email failed');
  });

  it('shows no label for delivered', () => {
    expect(emailStatusLabel('delivered')).toBeNull();
  });

  it('shows no label for a null status', () => {
    expect(emailStatusLabel(null)).toBeNull();
  });
});

describe('getInviteSuccessMessage', () => {
  it('says the invite was created, not sent', () => {
    expect(getInviteSuccessMessage()).toBe('Invite created');
    expect(getInviteSuccessMessage().toLowerCase()).not.toContain('sent');
  });
});

describe('invitedMemberActionOptions', () => {
  it('offers a Resend invite option for a failed invite', () => {
    expect(canResendInvite('failed')).toBe(true);
    expect(invitedMemberActionOptions('failed', true)).toEqual([
      'Share invite link',
      'Resend invite',
      'Revoke invitation',
      'Cancel',
    ]);
  });

  it('omits the Resend invite option for non-failed statuses', () => {
    for (const status of ['pending', 'sending', 'delivered', null] as const) {
      expect(canResendInvite(status)).toBe(false);
      expect(invitedMemberActionOptions(status, true)).toEqual([
        'Share invite link',
        'Revoke invitation',
        'Cancel',
      ]);
    }
  });

  it('omits the Share invite link option when the caller has no invite URL', () => {
    expect(invitedMemberActionOptions('failed', false)).toEqual([
      'Resend invite',
      'Revoke invitation',
      'Cancel',
    ]);
    expect(invitedMemberActionOptions('delivered', false)).toEqual(['Revoke invitation', 'Cancel']);
  });
});

describe('useResendInvite', () => {
  beforeEach(() => {
    resendInviteMutateMock.mockClear();
    capturedOptions = null;
    role.canManageBilling = true;
    role.action = { label: i18n.t('organization.hub.manageBilling'), onPress: vi.fn<() => void>() };
  });

  it('delegates the mutation to members.resendInvite with the org id', async () => {
    useResendInvite('org-1');

    await capturedOptions?.mutationFn?.({ inviteId: 'inv-1' });

    expect(resendInviteMutateMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      inviteId: 'inv-1',
    });
  });

  it('names a missing invitation instead of claiming the resend failed', () => {
    toast.error.mockClear();
    useResendInvite('org-1');

    capturedOptions?.onError?.(new Error('Invitation not found'));

    expect(toast.error).toHaveBeenCalledWith(i18n.t('queryError.notFoundDescription'));
    expect(toast.error).not.toHaveBeenCalledWith('Invitation not found');
  });

  it('announces any other failed resend in catalog copy, not the server sentence', () => {
    toast.error.mockClear();
    useResendInvite('org-1');

    capturedOptions?.onError?.(new Error('Failed to fetch'));

    expect(toast.error).toHaveBeenCalledWith(i18n.t('organization.members.resendInviteError'));
    expect(toast.error).not.toHaveBeenCalledWith('Failed to fetch');
  });

  const trialRefusal = () =>
    Object.assign(new Error(ORGANIZATION_TRIAL_EXPIRED_MESSAGE), {
      data: { code: 'FORBIDDEN', message: ORGANIZATION_TRIAL_EXPIRED_MESSAGE },
    });

  it('offers a billing role the plan refusal and the toast step that ends it', () => {
    toast.error.mockClear();
    const onPress = vi.fn<() => void>();
    role.canManageBilling = true;
    role.action = { label: i18n.t('organization.hub.manageBilling'), onPress };
    useResendInvite('org-1');

    capturedOptions?.onError?.(trialRefusal());

    expect(toast.error).toHaveBeenCalledWith(i18n.t('common.organizationTrialEndedBilling'), {
      action: { label: i18n.t('organization.hub.manageBilling'), onClick: expect.any(Function) },
    });
    const options = toast.error.mock.calls[0]?.[1] as
      | { action: { onClick: () => void } }
      | undefined;
    if (!options) {
      throw new Error('the toast carried no step');
    }
    options.action.onClick();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('keeps a member on the owner-naming copy with no step', () => {
    toast.error.mockClear();
    role.canManageBilling = false;
    role.action = undefined;
    useResendInvite('org-1');

    capturedOptions?.onError?.(trialRefusal());

    // One argument: a reader who cannot end the refusal is offered nothing.
    expect(toast.error.mock.calls[0]).toEqual([i18n.t('common.organizationTrialEnded')]);
  });
});
