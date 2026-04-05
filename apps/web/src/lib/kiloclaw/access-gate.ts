import 'server-only';

import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { kiloclaw_subscriptions, kiloclaw_earlybird_purchases } from '@kilocode/db/schema';
import { KILOCLAW_EARLYBIRD_EXPIRY_DATE } from '@/lib/kiloclaw/constants';
import { KILOCLAW_BILLING_ENFORCEMENT } from '@/lib/config.server';
import { baseProcedure } from '@/lib/trpc/init';

/**
 * Check whether a user has active KiloClaw access via subscription, trial, or earlybird.
 * Throws TRPCError FORBIDDEN if the user has no valid access.
 */
export async function requireKiloClawAccess(userId: string): Promise<void> {
  if (!KILOCLAW_BILLING_ENFORCEMENT) return;

  // 1. Active subscription
  const [sub] = await db
    .select({
      status: kiloclaw_subscriptions.status,
      trial_ends_at: kiloclaw_subscriptions.trial_ends_at,
      suspended_at: kiloclaw_subscriptions.suspended_at,
    })
    .from(kiloclaw_subscriptions)
    .where(eq(kiloclaw_subscriptions.user_id, userId))
    .limit(1);

  if (sub) {
    if (sub.status === 'active') return;
    // past_due retains access only until the billing lifecycle cron suspends the
    // account. Once suspended_at is set, the user must resolve payment first.
    if (sub.status === 'past_due' && !sub.suspended_at) return;
    if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at) > new Date())
      return;
  }

  // 2. Earlybird not expired
  const [earlybird] = await db
    .select({ id: kiloclaw_earlybird_purchases.id })
    .from(kiloclaw_earlybird_purchases)
    .where(eq(kiloclaw_earlybird_purchases.user_id, userId))
    .limit(1);

  if (earlybird && new Date(KILOCLAW_EARLYBIRD_EXPIRY_DATE) > new Date()) {
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
