import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { TRIAL_ENDED_COPY_KEY } from '@/lib/trial-refusal-copy';

/**
 * The sentence `ensureOrganizationAccess` (`packages/web-shared/src/routers/
 * organizations/utils.ts`) throws with code `UNAUTHORIZED` when the caller's
 * role is narrower than `ORGANIZATION_MANAGE_ROLES` — the write gate every
 * organization profile mutation passes through after the plan gate.
 */
export const ORGANIZATION_ROLE_DENIED_MESSAGE =
  'You do not have the required organizational role to access this feature';

/**
 * The toast text for a rejected profile write. The server's sentences are
 * English, so a recognized refusal gets the app's own sentence in the active
 * language, the way `manualReviewStartFailure` explains a refused code-review
 * start; every other message reaches the screen unchanged.
 *
 * Two refusals have their own sentence here. The role denial names who may act
 * in the organization. The plan gate (`requireActiveSubscriptionOrTrial`) names
 * the lapsed plan, and its copy is the one the organization hub shows for the
 * same verdict, so a refused save and the hub agree on the cause.
 */
export function agentProfileMutationErrorMessage(message: string): string {
  if (message === ORGANIZATION_ROLE_DENIED_MESSAGE) {
    return i18n.t('profiles.organizationRoleRequired');
  }
  if (message === ORGANIZATION_TRIAL_EXPIRED_MESSAGE) {
    return i18n.t(TRIAL_ENDED_COPY_KEY);
  }
  return message;
}
