import 'server-only';

import type Stripe from 'stripe';

export const ORGANIZATION_KILO_PASS_METADATA_TYPE = 'kilo-pass-org';

export type OrganizationKiloPassMetadata = {
  type: typeof ORGANIZATION_KILO_PASS_METADATA_TYPE;
  organizationId: string;
  kiloUserId: string;
  tier: 'tier_19' | 'tier_49' | 'tier_199';
  cadence: 'monthly' | 'yearly';
};

export function getOrganizationKiloPassMetadata(
  metadata: Stripe.Metadata | null | undefined
): OrganizationKiloPassMetadata | null {
  if (metadata?.type !== ORGANIZATION_KILO_PASS_METADATA_TYPE) return null;
  const { organizationId, kiloUserId, tier, cadence } = metadata;
  if (
    !organizationId ||
    !kiloUserId ||
    (tier !== 'tier_19' && tier !== 'tier_49' && tier !== 'tier_199') ||
    (cadence !== 'monthly' && cadence !== 'yearly')
  )
    return null;
  return { type: ORGANIZATION_KILO_PASS_METADATA_TYPE, organizationId, kiloUserId, tier, cadence };
}
