import { i18n } from '@/i18n';
import { ORGANIZATION_TRIAL_EXPIRED_MESSAGE } from '@/lib/server-error-copy';
import { trialRefusalCopyKey } from '@/lib/trial-refusal-copy';

/**
 * The sentence `ensureOrganizationAccess` (`packages/web-shared/src/routers/
 * organizations/utils.ts`) throws with code `UNAUTHORIZED` when the caller's
 * role is narrower than `ORGANIZATION_MANAGE_ROLES`. Shared with the plan gate
 * by every organization profile write: the role check runs first, so a member
 * always reads this sentence and never the plan one.
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
 * in the organization. The plan gate (`requireActiveSubscriptionOrTrial`) is
 * reached only by a caller who already passed the role check, and that role is
 * owner or admin, which can change the plan: the copy is therefore the one for
 * a reader who can act, resolved through the shared key table with no billing
 * step on these screens. A role a refusal cannot reach does not need its own
 * branch here, and reading the role inside the profile mutation hooks would pull
 * the organization query chain (and with it the native runtime) into test
 * projects that load those hooks without it.
 */
export function agentProfileMutationErrorMessage(message: string): string {
  if (message === ORGANIZATION_ROLE_DENIED_MESSAGE) {
    return i18n.t('profiles.organizationRoleRequired');
  }
  if (message === ORGANIZATION_TRIAL_EXPIRED_MESSAGE) {
    return i18n.t(trialRefusalCopyKey(true, 'absent'));
  }
  return message;
}
