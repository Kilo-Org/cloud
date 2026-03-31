import { TRPCError } from '@trpc/server';
import { getOrganizationById } from './organizations';
import { getDaysRemainingInTrial, getOrgTrialStatusFromDays } from './trial-utils';
import { getMostRecentSeatPurchase } from './organization-seats';

/**
 * Ensures organization has either active subscription or active trial
 * Throws error if trial has expired and no subscription exists
 *
 * @throws TRPCError with code FORBIDDEN if trial expired without subscription
 * @returns Object with isReadOnly flag and days remaining
 */
export async function requireActiveSubscriptionOrTrial(
  organizationId: string
): Promise<{ isReadOnly: boolean; daysRemaining: number }> {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }

  // Orgs that don't require seats bypass all trial/subscription enforcement
  if (!organization.require_seats) {
    return { isReadOnly: false, daysRemaining: Infinity };
  }

  // Check for active subscription by looking at organization_seats_purchases table
  const latestPurchase = await getMostRecentSeatPurchase(organizationId);
  const hasActiveSubscription = latestPurchase?.subscription_status === 'active';

  if (hasActiveSubscription) {
    return { isReadOnly: false, daysRemaining: Infinity };
  }

  // OSS sponsorship participants are exempt from trial expiration (Free Trial 9)
  if (organization.settings.oss_sponsorship_tier != null) {
    return { isReadOnly: false, daysRemaining: Infinity };
  }

  // Suppressed trial messaging orgs are treated as subscribed (Free Trial 10)
  if (organization.settings.suppress_trial_messaging) {
    return { isReadOnly: false, daysRemaining: Infinity };
  }

  const daysRemaining = getDaysRemainingInTrial(
    organization.free_trial_end_at ?? null,
    organization.created_at
  );
  const state = getOrgTrialStatusFromDays(daysRemaining);

  // Hard lock blocks all mutations
  if (state === 'trial_expired_hard') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Organization trial has expired.' });
  }

  return { isReadOnly: false, daysRemaining };
}
