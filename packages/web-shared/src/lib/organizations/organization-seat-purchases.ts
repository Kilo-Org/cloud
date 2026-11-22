import type { Organization, OrganizationSeatsPurchase } from '@kilocode/db/schema';
import { organization_seats_purchases, organizations } from '@kilocode/db/schema';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { and, desc, eq } from 'drizzle-orm';

/**
 * The rule for this table: it is append-only, so the most recently created row
 * is the organization's current subscription state. This is the rule expressed
 * as a correlated subquery. Lazily built: suites that mock the drizzle module
 * must not see the template evaluated at import time.
 */
export function latestSeatPurchaseStatusSql() {
  return sql<OrganizationSeatsPurchase['subscription_status'] | null>`(
    SELECT ${organization_seats_purchases.subscription_status}
    FROM ${organization_seats_purchases}
    WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
    ORDER BY ${organization_seats_purchases.created_at} DESC
    LIMIT 1
  )`;
}

/**
 * Returns the most recently created seat purchase for an organization.
 *
 * This expresses the same append-only rule as `latestSeatPurchaseStatusSql`:
 * one rule, two shapes, an entity read and a correlated subquery.
 */
export async function getMostRecentSeatPurchase(
  organizationId: Organization['id'],
  fromDb: typeof db = db
): Promise<OrganizationSeatsPurchase | null> {
  const [purchase] = await fromDb
    .select()
    .from(organization_seats_purchases)
    .where(eq(organization_seats_purchases.organization_id, organizationId))
    .orderBy(desc(organization_seats_purchases.created_at))
    .limit(1);

  return purchase || null;
}

/**
 * Returns the most recently ended seat purchase by period end. Used for resubscribe flow.
 * Like its sibling, it reads through the client the caller passes.
 */
export async function getMostRecentEndedSeatPurchase(
  organizationId: Organization['id'],
  fromDb: typeof db = db
): Promise<OrganizationSeatsPurchase | null> {
  const [purchase] = await fromDb
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
