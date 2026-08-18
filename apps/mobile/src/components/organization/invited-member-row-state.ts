import { useMutation, useQueryClient } from '@tanstack/react-query';

import { announcingToast } from '@/lib/a11y/announcing-toast';
import { type InvitedOrgMember } from '@/lib/hooks/use-organization-queries';
import { trpcClient, useTRPC } from '@/lib/trpc';

/**
 * Success copy for the invite mutation (invite-member-sheet). The email is
 * sent asynchronously through the outbox, so the copy must say "created", not
 * "sent".
 */
export const INVITE_SUCCESS_MESSAGE = 'Invite created';

/**
 * Maps an invited member's outbox email status to the label shown in the row.
 * Delivered invitations show no label: the email is already out, so there is
 * nothing actionable to surface.
 */
export function emailStatusLabel(emailStatus: InvitedOrgMember['emailStatus']): string | null {
  switch (emailStatus) {
    case 'pending': {
      return 'Pending';
    }
    case 'sending': {
      return 'Pending';
    }
    case 'failed': {
      return 'Email failed';
    }
    case 'delivered': {
      return null;
    }
    case null: {
      return null;
    }
    default: {
      return null;
    }
  }
}

/**
 * A failed invite is resendable; a revoked/expired/accepted invite is not (the
 * backend refuses `resendInvite` for those, so the row must not offer it).
 */
export function canResendInvite(emailStatus: InvitedOrgMember['emailStatus']): boolean {
  return emailStatus === 'failed';
}

/**
 * Action-sheet options for an invited member row, in display order. The
 * `Resend invite` option appears only for a failed invite.
 */
export function invitedMemberActionOptions(emailStatus: InvitedOrgMember['emailStatus']): string[] {
  return [
    'Share invite link',
    ...(canResendInvite(emailStatus) ? ['Resend invite'] : []),
    'Revoke invitation',
    'Cancel',
  ];
}

/**
 * Resend mutation for a failed invite. Delegates to
 * `trpcClient.organizations.members.resendInvite` and re-fetches the member
 * list on success.
 */
export function useResendInvite(organizationId: string) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation({
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    mutationFn: (input: { inviteId: string }) =>
      trpcClient.organizations.members.resendInvite.mutate({ organizationId, ...input }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: trpc.organizations.withMembers.queryKey({ organizationId }),
      });
    },
    onError: (error: { message: string }) => {
      announcingToast.error(error.message || 'Something went wrong');
    },
  });
}
