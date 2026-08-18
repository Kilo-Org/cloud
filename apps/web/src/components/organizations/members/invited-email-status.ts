/**
 * Maps an invited member's outbox email status to the badge label shown in the
 * members list (P2-B-11). Delivered invitations show no badge: the email is
 * already out, so there is nothing actionable to surface.
 */
export type InvitedEmailStatus = 'pending' | 'sending' | 'delivered' | 'failed' | null;

export function invitedEmailStatusLabel(
  emailStatus: InvitedEmailStatus
): 'Pending' | 'Email failed' | null {
  switch (emailStatus) {
    case 'pending':
    case 'sending':
      return 'Pending';
    case 'failed':
      return 'Email failed';
    case 'delivered':
    case null:
      return null;
  }
}
