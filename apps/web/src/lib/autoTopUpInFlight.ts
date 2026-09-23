import { db } from '@/lib/drizzle';
import { auto_top_up_configs, kilocode_users, organizations } from '@kilocode/db/schema';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { AUTO_TOP_UP_IN_FLIGHT_WINDOW_SECONDS } from '@/lib/autoTopUpConstants';

/**
 * Reports whether an auto-top-up is currently in flight for the billing entity.
 *
 * The `attempt_started_at` lock is held from the moment a top-up is triggered
 * until the `invoice.paid` webhook posts credits (or the attempt fails and
 * releases it). While it is held the balance can cross zero before credits
 * land, so callers must not treat that window as a terminal no-credits state.
 *
 * The read uses the primary database because a replica-stale lock is not a
 * reliable in-flight signal. Locks older than the in-flight window are ignored:
 * a lost webhook must not suppress the terminal no-credits response for long.
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
  const ownerEnabled = params.organizationId
    ? sql`EXISTS (
        SELECT 1 FROM ${organizations}
        WHERE ${organizations.id} = ${params.organizationId}
          AND ${organizations.auto_top_up_enabled} = TRUE
      )`
    : sql`EXISTS (
        SELECT 1 FROM ${kilocode_users}
        WHERE ${kilocode_users.id} = ${params.userId}
          AND ${kilocode_users.auto_top_up_enabled} = TRUE
      )`;

  const [config] = await db
    .select({ id: auto_top_up_configs.id })
    .from(auto_top_up_configs)
    .where(
      and(
        ownerMatch,
        ownerEnabled,
        isNull(auto_top_up_configs.disabled_reason),
        isNotNull(auto_top_up_configs.attempt_started_at),
        gt(
          auto_top_up_configs.attempt_started_at,
          sql`NOW() - INTERVAL '${sql.raw(String(AUTO_TOP_UP_IN_FLIGHT_WINDOW_SECONDS))} second'`
        )
      )
    )
    .limit(1);

  return config !== undefined;
}
