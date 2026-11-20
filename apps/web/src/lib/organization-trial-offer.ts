import { TRIAL_DURATION_DAYS } from '@kilocode/web-shared/lib/constants';
import { isInternalAccountEmail } from '@kilocode/web-shared/lib/organizations/organization-creation-limit';
import type { User } from '@kilocode/db/schema';

/**
 * The trial the organization-creation procedure grants. It covers the first
 * organization a creator makes, so every surface that offers it names that
 * scope instead of promising a window to each creation. The duration comes
 * from the shared constant the creation path reads, so the copy cannot drift
 * from the grant.
 */
export const FIRST_ORGANIZATION_TRIAL_OFFER = `Your first organization includes a ${TRIAL_DURATION_DAYS}-day Enterprise trial.`;

/**
 * Whether the viewer still receives the first-organization trial offer.
 *
 * It applies the same rule as the creation path: an internal account keeps the
 * trial on every organization, and every other account has it until its stored
 * consumption timestamp is set. Surfaces that offer the trial call this so the
 * copy and the grant cannot disagree.
 */
export function hasFirstOrganizationTrialOffer(
  user: Pick<User, 'google_user_email' | 'organization_trial_consumed_at'>
): boolean {
  if (isInternalAccountEmail(user.google_user_email)) return true;
  return user.organization_trial_consumed_at == null;
}
