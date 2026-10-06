import type { Organization } from '@kilocode/db/schema';
import { organization_seats_purchases, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { classifyOrganizationEntitlement } from './trial-utils';

/**
 * Whether the organization is on the enterprise plan and past its trial: it has
 * a paid seat purchase or another trial bypass, so it is shown as subscribed.
 */
export async function isNonTrialEnterpriseOrganization(
  organizationId: Organization['id'],
  fromDb: typeof db = db
): Promise<boolean> {
  const [[organization], [latestSeatPurchase]] = await Promise.all([
    fromDb
      .select({
        plan: organizations.plan,
        created_at: organizations.created_at,
        free_trial_end_at: organizations.free_trial_end_at,
        require_seats: organizations.require_seats,
        settings: organizations.settings,
      })
      .from(organizations)
      .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
      .limit(1),
    fromDb
      .select({ subscription_status: organization_seats_purchases.subscription_status })
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.organization_id, organizationId))
      .orderBy(desc(organization_seats_purchases.created_at))
      .limit(1),
  ]);

  if (organization?.plan !== 'enterprise') return false;

  return (
    classifyOrganizationEntitlement({
      organization,
      latestSeatPurchaseStatus: latestSeatPurchase?.subscription_status ?? null,
      now: new Date(),
    }).displayStatus === 'subscribed'
  );
}
