import 'server-only';

import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { kiloclaw_earlybird_purchases } from '@kilocode/db/schema';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import { getEffectiveKiloClawSubscriptionForUser } from '@/lib/kiloclaw/access-state';
import { baseProcedure } from '@/lib/trpc/init';

/**
 * Check whether a user has active KiloClaw access via subscription, trial, or earlybird.
 * Throws TRPCError FORBIDDEN if the user has no valid access.
 */
export async function requireKiloClawAccess(userId: string): Promise<void> {
  const now = new Date();

  // 1. Active subscription
  const { accessReason } = await getEffectiveKiloClawSubscriptionForUser(userId, now);
  if (accessReason) {
    return;
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
