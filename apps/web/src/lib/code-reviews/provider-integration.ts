import type { CloudAgentCodeReview, PlatformIntegration } from '@kilocode/db/schema';
import { getIntegrationById } from '@/lib/integrations/db/platform-integrations';
import type { Owner } from './core';

export type ReviewOwner = Pick<Owner, 'type' | 'id'>;

export type ReviewOwnershipColumns = Pick<
  CloudAgentCodeReview,
  'platform' | 'owned_by_organization_id' | 'owned_by_user_id'
>;

type IntegrationOwnershipColumns = Pick<
  PlatformIntegration,
  'platform' | 'owned_by_organization_id' | 'owned_by_user_id'
>;

/**
 * The owner a review row belongs to, read from its own ownership columns. A row that
 * names both owners, or neither, has no owner.
 */
export function reviewOwnerScope(review: ReviewOwnershipColumns): ReviewOwner | null {
  if (review.owned_by_organization_id && review.owned_by_user_id) return null;
  if (review.owned_by_organization_id) return { type: 'org', id: review.owned_by_organization_id };
  if (review.owned_by_user_id) return { type: 'user', id: review.owned_by_user_id };
  return null;
}

/**
 * Exact ownership: the integration belongs to the review's owner through one owner
 * column only, and serves the review's platform. A review job may use the provider
 * credential of an integration only when this holds, so a review row that points at
 * another tenant's integration never reaches a token mint.
 */
export function isProviderIntegrationOwnedByReview(
  integration: IntegrationOwnershipColumns,
  review: ReviewOwnershipColumns,
  owner: ReviewOwner
): boolean {
  if (integration.platform !== review.platform) return false;
  if (owner.type === 'org') {
    return (
      review.owned_by_organization_id === owner.id &&
      review.owned_by_user_id === null &&
      integration.owned_by_organization_id === owner.id &&
      integration.owned_by_user_id === null
    );
  }
  return (
    review.owned_by_user_id === owner.id &&
    review.owned_by_organization_id === null &&
    integration.owned_by_user_id === owner.id &&
    integration.owned_by_organization_id === null
  );
}

/**
 * Resolve the integration a review's provider work may use. Returns null when the
 * review has no integration, when the row does not belong to the review's owner, or
 * when it serves another platform, so every caller fails closed instead of using a
 * credential that is not the review owner's.
 */
export async function resolveReviewProviderIntegration(
  review: ReviewOwnershipColumns & Pick<CloudAgentCodeReview, 'platform_integration_id'>,
  owner: ReviewOwner
): Promise<PlatformIntegration | null> {
  if (!review.platform_integration_id) return null;
  const integration = await getIntegrationById(
    review.platform_integration_id,
    owner.type === 'org' ? owner.id : undefined
  );
  if (!integration) return null;
  return isProviderIntegrationOwnedByReview(integration, review, owner) ? integration : null;
}
