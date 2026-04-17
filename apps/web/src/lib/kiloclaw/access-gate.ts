import 'server-only';

import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { kiloclaw_earlybird_purchases } from '@kilocode/db/schema';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import {
  getCurrentPersonalKiloClawSubscriptionForUser,
  CurrentPersonalSubscriptionResolutionError,
} from '@/lib/kiloclaw/access-state';
import { baseProcedure } from '@/lib/trpc/init';

/**
 * Check whether a user has active KiloClaw access via subscription, trial, or earlybird.
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

  // 2. Earlybird not expired
  const [earlybird] = await db
    .select({ id: kiloclaw_earlybird_purchases.id })
    .from(kiloclaw_earlybird_purchases)
    .where(eq(kiloclaw_earlybird_purchases.user_id, userId))
    .limit(1);

  if (earlybird && new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE) > now) {
    return;
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
      earlybirdFound: !!earlybird,
    })
  );

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'KiloClaw access requires an active subscription, trial, or earlybird purchase.',
  });
}

/**
 * tRPC procedure that gates KiloClaw operations behind billing access.
 */
export const clawAccessProcedure = baseProcedure.use(async ({ ctx, next }) => {
  await requireKiloClawAccess(ctx.user.id);
  return next();
});
