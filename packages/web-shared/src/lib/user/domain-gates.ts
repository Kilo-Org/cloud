import 'server-only';
import { isEmailBlacklistedByDomain } from '@kilocode/worker-utils/account-access';
import {
  getBlockedSignupTlds,
  isEmailBlacklisted,
} from '@kilocode/web-shared/lib/blacklist-domains-config';
import { db } from '@kilocode/web-shared/lib/drizzle';
import type { User } from '@kilocode/db/schema';

export function isUserBlacklistedByDomain(
  existingUser: Pick<User, 'google_user_email'>,
  fromDb: typeof db = db
): Promise<boolean> {
  return isEmailBlacklisted(existingUser.google_user_email, fromDb);
}

/**
 * Pure TLD gate used by the async {@link isBlockedTLD}. Entries are bare
 * labels (`asia`), so an entry matches every address on that TLD.
 */
export function isEmailOnBlockedTld(email: string, blockedTlds: readonly string[]): boolean {
  return isEmailBlacklistedByDomain(email, blockedTlds);
}

/**
 * New-signup TLD gate. The TLD list is admin-configurable in Postgres, so a cheap
 * TLD can be blocked without a deploy. Only new accounts are refused; an
 * existing account on a blocked TLD keeps signing in.
 */
export const isBlockedTLD = async (email: string): Promise<boolean> =>
  isEmailOnBlockedTld(email, await getBlockedSignupTlds());
