import { db } from '@/lib/drizzle';
import { auto_top_up_configs } from '@kilocode/db/schema';
import { and, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { AUTO_TOP_UP_ATTEMPT_LOCK_TIMEOUT_SECONDS } from '@/lib/autoTopUpConstants';

/**
 * Reports whether an auto-top-up is currently in flight for the billing entity.
 *
 * The `attempt_started_at` lock is held from the moment a top-up is triggered
 * until the `invoice.paid` webhook posts credits (or the attempt fails and
 * releases it). While it is held the balance can cross zero before credits
 * land, so callers must not treat that window as a terminal no-credits state.
 *
 * The read uses the primary database because a stale lock (older than the
 * reclaim window) is not a reliable in-flight signal.
 */
export async function isAutoTopUpInFlight(params: {
  userId?: string;
  organizationId?: string;
}): Promise<boolean> {
  const ownerMatch = params.organizationId
    ? eq(auto_top_up_configs.owned_by_organization_id, params.organizationId)
    : params.userId
      ? eq(auto_top_up_configs.owned_by_user_id, params.userId)
      : undefined;
  if (!ownerMatch) return false;

  const [config] = await db
    .select({ id: auto_top_up_configs.id })
    .from(auto_top_up_configs)
    .where(
      and(
        ownerMatch,
        isNotNull(auto_top_up_configs.attempt_started_at),
        gt(
          auto_top_up_configs.attempt_started_at,
          sql`NOW() - INTERVAL '${sql.raw(String(AUTO_TOP_UP_ATTEMPT_LOCK_TIMEOUT_SECONDS))} second'`
        )
      )
    )
    .limit(1);

  return config !== undefined;
}
