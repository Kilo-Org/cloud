import { createTimer } from '@/lib/timer';
import { processLocalExpirations } from '@/lib/creditExpiration';
import { after } from 'next/server';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import type { UserForBalance } from '@/lib/UserForBalance';
import { subHours } from 'date-fns';

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

  after(() => maybePerformAutoTopUp(user));
  const balance = (user.total_microdollars_acquired - user.microdollars_used) / 1_000_000;
  return { balance };
}
