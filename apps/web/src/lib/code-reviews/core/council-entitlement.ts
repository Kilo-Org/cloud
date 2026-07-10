import 'server-only';

import { TRPCError } from '@trpc/server';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { isLocalCodeReviewDevelopmentEnabled } from '@/lib/config.server';
import type { CodeReviewType } from '@kilocode/db/schema-types';
import type { Owner } from './schemas';

/**
 * Single source of truth for which plan grants council. Council is enterprise-only.
 * Every gate (backend enforcement, UI visibility) derives from this predicate.
 *
 * NOTE: this is the access/entitlement boundary (money). Staged rollout (which entitled
 * users see council yet) is a separate concern handled by a client-side PostHog flag —
 * see "Rollout gating" in the plan. This module does not implement the rollout flag.
 */
export function isCouncilEntitledPlan(plan: string | null | undefined): boolean {
  return plan === 'enterprise';
}

/**
 * Council reviews are an enterprise-only feature. Entitlement is owned by the
 * organization plan; personal owners are never entitled.
 */
export async function isCouncilEntitledForOrganization(
  organizationId: string | null | undefined
): Promise<boolean> {
  if (!organizationId) return false;
  const organization = await getOrganizationById(organizationId);
  return isCouncilEntitledPlan(organization?.plan);
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
