import type { Organization } from '@kilocode/db/schema';
import { organization_seats_purchases, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { nonTrialEnterpriseRedisKey } from '@kilocode/web-shared/lib/redis-keys';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { classifyOrganizationEntitlement } from './trial-utils';

const CACHE_TTL_SECONDS = 60 * 60;

async function readCachedResult(organizationId: string): Promise<boolean | null> {
  try {
    const cached = await redisClient.get<string>(nonTrialEnterpriseRedisKey(organizationId));
    if (cached === 'true') return true;
    if (cached === 'false') return false;
  } catch (error) {
    console.warn('Non-trial enterprise cache read failed', { organizationId, error });
  }
  return null;
}

async function writeCachedResult(organizationId: string, result: boolean): Promise<void> {
  try {
    await redisClient.set(nonTrialEnterpriseRedisKey(organizationId), String(result), {
      ex: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.warn('Non-trial enterprise cache write failed', { organizationId, error });
  }
}

async function queryIsNonTrialEnterpriseOrganization(
  organizationId: Organization['id'],
  fromDb: typeof db
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

/**
 * Whether the organization is on the enterprise plan and past its trial: it has
 * a paid seat purchase or another trial bypass, so it is shown as subscribed.
 * Cached in Redis for an hour. Redis is only a cache, so its failures fall back
 * to the database.
 */
export async function isNonTrialEnterpriseOrganization(
  organizationId: Organization['id'],
  fromDb: typeof db = db
): Promise<boolean> {
  const cached = await readCachedResult(organizationId);
  if (cached !== null) return cached;

  const result = await queryIsNonTrialEnterpriseOrganization(organizationId, fromDb);
  await writeCachedResult(organizationId, result);
  return result;
}
