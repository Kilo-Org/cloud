import type { User } from '@kilocode/db/schema';

/** Account availability: a block recorded in either column makes the account blocked. */
export function isBlockedAccount(user: Pick<User, 'blocked_at' | 'blocked_reason'>): boolean {
  return Boolean(user.blocked_at || user.blocked_reason);
}
