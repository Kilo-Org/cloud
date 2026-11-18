import { i18n } from '@/i18n';

/**
 * The sentence `ensureOrganizationAccess` (`packages/web-shared/src/routers/
 * organizations/utils.ts`) throws with code `UNAUTHORIZED` when the caller's
 * role is narrower than `ORGANIZATION_MANAGE_ROLES` — the write gate every
 * organization profile mutation passes through.
 */
export const ORGANIZATION_ROLE_DENIED_MESSAGE =
  'You do not have the required organizational role to access this feature';

/**
 * The toast text for a rejected profile write. The server's sentences are
 * English, so the organization-role denial gets the app's own sentence in the
 * active language, the way `manualReviewStartFailure` explains a refused
 * code-review start; every other message reaches the screen unchanged.
 */
export function agentProfileMutationErrorMessage(message: string): string {
  return message === ORGANIZATION_ROLE_DENIED_MESSAGE
    ? i18n.t('profiles.organizationRoleRequired')
    : message;
}
