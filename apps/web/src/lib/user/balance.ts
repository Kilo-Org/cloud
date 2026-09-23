import { createTimer } from '@/lib/timer';
import { processLocalExpirations } from '@/lib/creditExpiration';
import { after } from 'next/server';
import { performReservedAutoTopUp, reserveAutoTopUp } from '@/lib/autoTopUp';
import type { UserForBalance } from '@/lib/user/balance-types';
import { subHours } from 'date-fns';
import { captureException } from '@sentry/nextjs';

export type BalanceForUser = Awaited<ReturnType<typeof getBalanceForUser>>;
export async function getBalanceForUser(
  user: UserForBalance,
  options: {
    forceRefresh?: boolean;
    quiet?: boolean;
  } = {}
) {
  const { forceRefresh = false, quiet = false } = options;
  // If we DO unfortunately coincidentally check a user in multiple threads,
  // reduce chance of optimistic concurrency issues by giving users a random
  // extra 0 - 1 extra  hours before expiration:
  const expireBefore = subHours(new Date(), Math.random());

  const needsExpirationComputation =
    forceRefresh ||
    (user.next_credit_expiration_at && expireBefore >= new Date(user.next_credit_expiration_at));

  if (needsExpirationComputation) {
    // Process local expirations for migrated users (also updates cache timestamp)
    const timer = createTimer();
    const result = await processLocalExpirations(user, expireBefore);
    if (!quiet) timer.log(`processLocalExpirations for user ${user.id}`);
    user = { ...user, ...result };
  }

  let autoTopUpReservationFailed = false;
  try {
    const autoTopUpReservation = await reserveAutoTopUp(user);
    if (autoTopUpReservation) {
      after(() => performReservedAutoTopUp(autoTopUpReservation));
    }
  } catch (error) {
    autoTopUpReservationFailed = true;
    captureException(error, {
      tags: { source: 'auto_top_up_reservation', entity_type: 'user' },
    });
  }
  const balance = (user.total_microdollars_acquired - user.microdollars_used) / 1_000_000;
  return { ...(autoTopUpReservationFailed && { autoTopUpReservationFailed: true }), balance };
}
