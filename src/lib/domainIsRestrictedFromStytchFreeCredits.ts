import type { User } from '@kilocode/db/schema';
import { kilocode_users } from '@kilocode/db/schema';
import { hosted_domain_specials } from '@/lib/auth/constants';
import { db } from '@/lib/drizzle';
import { logExceptInTest } from '@/lib/utils.server';
import { count, eq } from 'drizzle-orm';

export const domainIsRestrictedFromStytchFreeCredits = async (user: User): Promise<boolean> => {
  if (
    user.hosted_domain === hosted_domain_specials.non_workspace_google_account ||
    user.hosted_domain === hosted_domain_specials.github ||
    user.hosted_domain === hosted_domain_specials.fake_devonly
  ) {
    return false; //we're not sure this is wise, but... let's find out.
  } else if (!user.hosted_domain) {
    return true; //shouldn't be possible; we auto-backfill hosted_domain on legacy accounts upon login.  Also, none of the new accounts have hosted_domain missing.
  }

  const userCount = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(eq(kilocode_users.hosted_domain, user.hosted_domain));
  logExceptInTest(`Domain: ${user.hosted_domain}, User Count: ${userCount[0]?.count}`);
  return userCount[0]?.count > 5;
};
