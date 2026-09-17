import { createTimer } from '@/lib/timer';
import { processLocalExpirations } from '@/lib/creditExpiration';
import { after } from 'next/server';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import type { UserForBalance } from '@/lib/user/balance-types';

export type BalanceForUser = Awaited<ReturnType<typeof getBalanceForUser>>;
export async function getBalanceForUser(
  user: UserForBalance,
  options: {
    forceRefresh?: boolean;
    quiet?: boolean;
  } = {}
) {
  const { forceRefresh = false, quiet = false } = options;

  if (forceRefresh) {
    const timer = createTimer();
    const result = await processLocalExpirations(user, new Date());
    if (!quiet) timer.log(`processLocalExpirations for user ${user.id}`);
    user = { ...user, ...result };
  }

  after(() => maybePerformAutoTopUp(user));
  const balance = (user.total_microdollars_acquired - user.microdollars_used) / 1_000_000;
  return { balance };
}
