import 'server-only';

import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { kiloclaw_instances } from '@kilocode/db/schema';
import {
  getCurrentPersonalKiloClawSubscriptionForUser,
  getKiloClawSubscriptionAccessReason,
  CurrentPersonalSubscriptionResolutionError,
} from '@/lib/kiloclaw/access-state';
import { resolveCurrentPersonalSubscriptionRow } from '@/lib/kiloclaw/current-personal-subscription';
import { baseProcedure } from '@/lib/trpc/init';

/**
 * Check whether a user has active KiloClaw access via subscription or trial.
 * Throws TRPCError FORBIDDEN if the user has no valid access.
 */
export async function requireKiloClawAccess(userId: string): Promise<void> {
  const now = new Date();

  // 1. Active subscription
  let subscription = null;
  let accessReason = null;
  try {
    const resolved = await getCurrentPersonalKiloClawSubscriptionForUser(userId, now);
    subscription = resolved.subscription;
    accessReason = resolved.accessReason;
    if (accessReason) {
      return;
    }
  } catch (error) {
    if (error instanceof CurrentPersonalSubscriptionResolutionError) {
      console.warn(
        JSON.stringify({
          event: 'kiloclaw_access_quarantined_multiple_current_rows',
          userId,
          instanceId: error.instanceId,
          message: error.message,
        })
      );
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'KiloClaw billing state needs support review before access can be restored.',
      });
    }
    throw error;
  }

  console.warn(
    JSON.stringify({
      event: 'kiloclaw_access_denied',
      userId,
      effectiveSubscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            plan: subscription.plan,
            suspended_at: subscription.suspended_at,
            instance_id: subscription.instance_id,
          }
        : 'none',
      accessReason,
    })
  );

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'KiloClaw access requires an active subscription or trial.',
  });
}

export async function requireKiloClawAccessAtInstance(
  userId: string,
  instanceId: string
): Promise<void> {
  const [instance] = await db
    .select({ id: kiloclaw_instances.id })
    .from(kiloclaw_instances)
    .where(
      and(
        eq(kiloclaw_instances.id, instanceId),
        eq(kiloclaw_instances.user_id, userId),
        isNull(kiloclaw_instances.organization_id),
        isNull(kiloclaw_instances.destroyed_at)
      )
    )
    .limit(1);

  if (!instance) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'No active KiloClaw instance found',
    });
  }

  const now = new Date();

  try {
    const row = await resolveCurrentPersonalSubscriptionRow({
      userId,
      instanceId,
      dbOrTx: db,
    });
    if (getKiloClawSubscriptionAccessReason(row?.subscription, now)) {
      return;
    }
  } catch (error) {
    if (error instanceof CurrentPersonalSubscriptionResolutionError) {
      console.warn(
        JSON.stringify({
          event: 'kiloclaw_access_quarantined_multiple_current_rows',
          userId,
          instanceId: error.instanceId ?? instanceId,
          message: error.message,
        })
      );
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'KiloClaw billing state needs support review before access can be restored.',
      });
    }
    throw error;
  }

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'KiloClaw access requires an active subscription or trial.',
  });
}

/**
 * tRPC procedure that gates KiloClaw operations behind billing access.
 */
export const clawAccessProcedure = baseProcedure.use(async ({ ctx, next }) => {
  await requireKiloClawAccess(ctx.user.id);
  return next();
});
