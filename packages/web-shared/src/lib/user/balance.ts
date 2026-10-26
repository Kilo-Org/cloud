import { createTimer } from '@kilocode/web-shared/lib/timer';
import { processLocalExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import type { UserForBalance } from '@kilocode/web-shared/lib/user/balance-types';
import { accountBalanceMicrodollars } from '@kilocode/worker-utils/account-access';
import { subHours } from 'date-fns';

export type BalanceForUser = Awaited<ReturnType<typeof getBalanceForUser>>;
export async function getBalanceForUser(
  user: UserForBalance,
  options: {
    forceRefresh?: boolean;
    quiet?: boolean;
    /** Instant the expiry cut-off is measured from. Defaults to the current time. */
    now?: Date;
    /** How many hours the cut-off trails `now` by. Defaults to no jitter. */
    expiryJitterHours?: number;
  } = {}
) {
  const { forceRefresh = false, quiet = false, now = new Date(), expiryJitterHours = 0 } = options;
  const expireBefore = subHours(now, expiryJitterHours);

  const needsExpirationComputation =
    forceRefresh ||
    (user.next_credit_expiration_at && expireBefore >= new Date(user.next_credit_expiration_at));

  if (needsExpirationComputation) {
    const timer = createTimer();
    const result = await processLocalExpirations(user, expireBefore);
    if (!quiet) timer.log(`processLocalExpirations for user ${user.id}`);
    user = { ...user, ...result };
  }

  const balance = accountBalanceMicrodollars(user) / 1_000_000;
  return { balance };
}
