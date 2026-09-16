import { after } from 'next/server';
import { maybePerformAutoTopUp } from '@/lib/autoTopUp';
import type { UserForBalance } from '@/lib/user/balance-types';

export type BalanceForUser = Awaited<ReturnType<typeof getBalanceForUser>>;
export async function getBalanceForUser(user: UserForBalance) {
  after(() => maybePerformAutoTopUp(user));
  const balance = (user.total_microdollars_acquired - user.microdollars_used) / 1_000_000;
  return { balance };
}
