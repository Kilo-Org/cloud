import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  canResendInvite,
  emailStatusLabel,
  getInviteSuccessMessage,
  invitedMemberActionOptions,
  useResendInvite,
} from '@/components/organization/invited-member-row-state';

// The state module now imports the resend mutation hook, which pulls in
// `@/lib/trpc` (native modules) and `@tanstack/react-query`. Mock those so the
// pure `emailStatusLabel` tests and the hook wiring test both run in node.
const resendInviteMutateMock = vi.fn();

type MutationOptions = {
  mutationFn?: (vars: unknown) => Promise<unknown>;
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

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
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
  });

  it('delegates the mutation to members.resendInvite with the org id', async () => {
    useResendInvite('org-1');

    await capturedOptions?.mutationFn?.({ inviteId: 'inv-1' });

    expect(resendInviteMutateMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      inviteId: 'inv-1',
    });
  });
});
