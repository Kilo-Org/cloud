import { z } from 'zod';

import { i18n } from '@/i18n';
import { readTrpcErrorField } from '@/lib/trpc-error';

/**
 * The procedure's own address rule (`z.email('Invalid email address')` on
 * `InviteMemberSchema` in `organization-members-router.ts`). Mirroring it here
 * means the field can never enable Send for an entry the server rejects, so a
 * malformed address is reported where it was typed instead of after a round
 * trip.
 */
const EMAIL_SCHEMA = z.email();

export function inviteEmailError(value: string): string | null {
  return EMAIL_SCHEMA.safeParse(value.trim()).success
    ? null
    : i18n.t('organization.inviteMember.emailError');
}

/** Where a failed invite belongs and what it says, both localized. */
export type InviteErrorCopy = Readonly<{
  field: 'email' | 'form';
  message: string;
}>;

/**
 * A rejected invite is never shown as the server wrote it: a schema rejection
 * carries a JSON array of zod issues (internal code, raw pattern, untranslated
 * message), not a sentence. The email field's own rule covers a malformed
 * address, so a validation rejection belongs on that field; a taken address
 * belongs next to the form; every other failure — transport, permission, an
 * SSO-only join rule — gets the generic line.
 */
export function inviteErrorCopy(error: unknown): InviteErrorCopy {
  const code = readTrpcErrorField(error, 'code');
  if (code === 'BAD_REQUEST') {
    return { field: 'email', message: i18n.t('organization.inviteMember.emailError') };
  }
  if (code === 'CONFLICT') {
    return { field: 'form', message: i18n.t('organization.inviteMember.alreadyInvited') };
  }
  return { field: 'form', message: i18n.t('organization.inviteMember.sendError') };
}
