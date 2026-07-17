import 'server-only';

import { TRPCError } from '@trpc/server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getMostRecentSeatPurchase } from '@/lib/organizations/organization-seats';
import { classifyOrganizationEntitlement } from '@/lib/organizations/trial-utils';
import { isLocalCodeReviewDevelopmentEnabled } from '@/lib/config.server';
import type { CodeReviewType } from '@kilocode/db/schema-types';
import type { Owner } from './schemas';

/**
 * Which plan tier grants council. Council is enterprise-only.
 *
 * NOTE: this is only the tier label. `organizations.plan` stays `'enterprise'` even
 * after an enterprise subscription ends (it is not downgraded on cancellation), so plan
 * alone is NOT proof of active entitlement. Active-subscription/trial status is layered
 * on separately in `isCouncilEntitledForOrganization`. Staged rollout (which entitled
 * users see council yet) is a separate client-side PostHog concern handled elsewhere.
 */
export function isCouncilEntitledPlan(plan: string | null | undefined): boolean {
  return plan === 'enterprise';
}

/**
 * Council reviews are an enterprise-only paid feature. An organization is entitled only
 * when it is on the enterprise tier AND currently has active entitlement (active paid
 * subscription or non-expired trial). This mirrors the canonical entitlement check used
 * by `requireActiveSubscriptionOrTrial`, so a lapsed enterprise org (plan still
 * `'enterprise'`, seat purchase `ended`, trial hard-expired) cannot create paid council
 * reviews. Personal owners are never entitled.
 */
export async function isCouncilEntitledForOrganization(
  organizationId: string | null | undefined
): Promise<boolean> {
  if (!organizationId) return false;
  const organization = await getOrganizationById(organizationId);
  if (!organization || !isCouncilEntitledPlan(organization.plan)) return false;

  const latestPurchase = await getMostRecentSeatPurchase(organizationId);
  const classification = classifyOrganizationEntitlement({
    organization,
    latestSeatPurchaseStatus: latestPurchase?.subscription_status ?? null,
    now: new Date(),
  });
  return classification.hasEntitlement;
}

export async function isCouncilEntitledForOwner(owner: Owner): Promise<boolean> {
  return owner.type === 'org' ? isCouncilEntitledForOrganization(owner.id) : false;
}

/**
 * Single enforcement point for council entitlement, invoked at the review-creation
 * boundary. Any path that persists a `council` review (manual or automated) passes
 * through here, so a non-entitled owner can never create one. Local dev bypasses so
 * the feature can be exercised without an enterprise org.
 *
 * Throws FORBIDDEN when a council review is requested without entitlement.
 */
export async function assertCouncilCreationAllowed(params: {
  owner: Owner;
  reviewType?: CodeReviewType;
}): Promise<void> {
  if (params.reviewType !== 'council') return;
  if (isLocalCodeReviewDevelopmentEnabled()) return;
  if (await isCouncilEntitledForOwner(params.owner)) return;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'Council reviews require an Enterprise plan.',
  });
}

// NOTE: a config-save guard (`assertCouncilConfigAllowed`) will be added alongside the
// council config-save path (PR #5) that actually accepts a `council` config, so it lands
// with its first caller rather than as an unreferenced export. The creation-boundary
// guard above already prevents a non-entitled owner from *running* a council review.
