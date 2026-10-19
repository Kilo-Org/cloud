import { createTimer } from '@kilocode/web-shared/lib/timer';
import { processLocalExpirations } from '@kilocode/web-shared/lib/creditExpiration';
import type { UserForBalance } from '@kilocode/web-shared/lib/user/balance-types';
import { accountBalanceMicrodollars } from '@kilocode/worker-utils/account-access';

export type BalanceForUser = Awaited<ReturnType<typeof getBalanceForUser>>;
export async function getBalanceForUser(
  user: UserForBalance,
  options: {
    forceRefresh?: boolean;
    quiet?: boolean;
  } = {}
) {
  const { forceRefresh = false, quiet = false } = options;
  const expireBefore = new Date();

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
