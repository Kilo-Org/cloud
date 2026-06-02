import { TRPCError } from '@trpc/server';
import { getMostRecentSeatPurchase } from './organization-seats';
import { getOrganizationById } from './organizations';
import { classifyOrganizationEntitlement } from './trial-utils';

async function getOrganizationEntitlementClassification(organizationId: string) {
  const organization = await getOrganizationById(organizationId);
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }

  const latestPurchase = await getMostRecentSeatPurchase(organizationId);
  return classifyOrganizationEntitlement({
    organization,
    latestSeatPurchaseStatus: latestPurchase?.subscription_status ?? null,
    now: new Date(),
  });
}

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
  const classification = await getOrganizationEntitlementClassification(organizationId);

  if (classification.isTrialExpiredForEnforcement) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Organization trial has expired.' });
  }

  return {
    isReadOnly: false,
    daysRemaining: classification.bypassReason == null ? classification.daysRemaining : Infinity,
  };
}

export async function requireOrganizationKiloClawComputeEntitlement(
  organizationId: string
): Promise<void> {
  const classification = await getOrganizationEntitlementClassification(organizationId);
  if (!classification.hasEntitlement) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Organization KiloClaw entitlement has expired.',
    });
  }
}
