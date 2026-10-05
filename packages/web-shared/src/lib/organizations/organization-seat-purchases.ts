import type { Organization, OrganizationSeatsPurchase } from '@kilocode/db/schema';
import { organization_seats_purchases } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, desc, eq } from 'drizzle-orm';

/**
 * Returns the most recently created seat purchase for an organization.
 *
 * organization_seats_purchases is append-only: every subscription event
 * (creation, renewal, cancellation) inserts a new row.  The most recently
 * created row therefore always reflects the current subscription state.
 */
export async function getMostRecentSeatPurchase(
  organizationId: Organization['id']
): Promise<OrganizationSeatsPurchase | null> {
  const [purchase] = await db
    .select()
    .from(organization_seats_purchases)
    .where(eq(organization_seats_purchases.organization_id, organizationId))
    .orderBy(desc(organization_seats_purchases.created_at))
    .limit(1);

  return purchase || null;
}

/** Returns the most recently ended seat purchase by period end. Used for resubscribe flow. */
export async function getMostRecentEndedSeatPurchase(
  organizationId: Organization['id']
): Promise<OrganizationSeatsPurchase | null> {
  const [purchase] = await db
    .select()
    .from(organization_seats_purchases)
    .where(
      and(
        eq(organization_seats_purchases.organization_id, organizationId),
        eq(organization_seats_purchases.subscription_status, 'ended')
      )
    )
    .orderBy(desc(organization_seats_purchases.expires_at))
    .limit(1);

  return purchase || null;
}
