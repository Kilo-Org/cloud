import { useMutation, useQueryClient } from '@tanstack/react-query';

import { i18n } from '@/i18n';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { type InvitedOrgMember } from '@/lib/hooks/use-organization-queries';
import { trpcClient, useTRPC } from '@/lib/trpc';

/**
 * Success copy for the invite mutation (invite-member-sheet). The email is
 * sent asynchronously through the outbox, so the copy must say "created", not
 * "sent".
 */
export function getInviteSuccessMessage(): string {
  return i18n.t('organization.members.inviteCreated');
}

/**
 * Maps an invited member's outbox email status to the label shown in the row.
 * Delivered invitations show no label: the email is already out, so there is
 * nothing actionable to surface.
 */
export function emailStatusLabel(emailStatus: InvitedOrgMember['emailStatus']): string | null {
  switch (emailStatus) {
    case 'pending': {
      return i18n.t('organization.members.emailStatusPending');
    }
    case 'sending': {
      return i18n.t('organization.members.emailStatusPending');
    }
    case 'failed': {
      return i18n.t('organization.members.emailStatusFailed');
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
 * `Resend invite` option appears only for a failed invite. The `Share invite
 * link` option appears only when the caller has the invite URL: a member
 * caller's `withMembers` response omits `inviteUrl`, so the row must not offer
 * a share action it cannot perform.
 */
export function invitedMemberActionOptions(
  emailStatus: InvitedOrgMember['emailStatus'],
  hasInviteUrl: boolean
): string[] {
  return [
    ...(hasInviteUrl ? [i18n.t('organization.members.shareInviteLink')] : []),
    ...(canResendInvite(emailStatus) ? [i18n.t('organization.members.resendInvite')] : []),
    i18n.t('organization.members.revokeInvitation'),
    i18n.t('common.cancel'),
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
      announcingToast.error(error.message || i18n.t('common.somethingWentWrong'));
    },
  });
}
