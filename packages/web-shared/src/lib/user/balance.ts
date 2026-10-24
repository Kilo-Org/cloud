import { createTimer } from '@kilocode/web-shared/lib/timer';
import { processLocalExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import { after } from 'next/server';
import { maybePerformAutoTopUp } from '@kilocode/web-shared/lib/autoTopUp';
import type { UserForBalance } from '@kilocode/web-shared/lib/user/balance-types';
import { subHours } from 'date-fns';
import { accountBalanceMicrodollars } from '@kilocode/worker-utils/account-access';

export type BalanceForUser = Awaited<ReturnType<typeof getBalanceForUser>>;
export async function getBalanceForUser(
  user: UserForBalance,
  options: {
    forceRefresh?: boolean;
    quiet?: boolean;
    /** Instant the expiry cut-off is measured from. Defaults to the current time. */
    now?: Date;
    /** How many hours the cut-off trails `now` by. Defaults to a random 0-1 draw. */
    expiryJitterHours?: number;
  } = {}
) {
  const {
    forceRefresh = false,
    quiet = false,
    now = new Date(),
    expiryJitterHours = Math.random(),
  } = options;
  // If we DO unfortunately coincidentally check a user in multiple threads,
  // reduce chance of optimistic concurrency issues by giving users a random
  // extra 0 - 1 extra  hours before expiration:
  const expireBefore = subHours(now, expiryJitterHours);

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
  const balance = accountBalanceMicrodollars(user) / 1_000_000;
  return { balance };
}
