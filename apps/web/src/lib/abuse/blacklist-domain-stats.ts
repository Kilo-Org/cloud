import type { DrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { count, isNotNull } from 'drizzle-orm';

// Reports return only the domains with matching users, ordered by count, so the
// payload stays small for a large configured list.
export const BLACKLIST_STATS_ROW_LIMIT = 200;

export type EmailDomainCount = { email_domain: string | null; count: number };

export type BlacklistStats = {
  domains: { domain: string; blockedCount: number }[];
  totalDomains: number;
  totalBlockedUsers: number;
};

/**
 * Reads one grouped count of users per stored email_domain. A report builds its
 * per-entry totals from this single statement, whatever the configured list
 * size.
 *
 * Pass `readDb` for read-only reports. The caller owns the choice of pool.
 */
export async function countUsersByEmailDomain(
  database: DrizzleClient['db']
): Promise<EmailDomainCount[]> {
  return database
    .select({ email_domain: kilocode_users.email_domain, count: count() })
    .from(kilocode_users)
    .where(isNotNull(kilocode_users.email_domain))
    .groupBy(kilocode_users.email_domain);
}

/**
 * Aggregates per-email_domain counts into per-blacklist-entry blocked counts.
 *
 * Walks each email_domain once and credits every blacklist entry that is one of
 * its label-boundary suffixes, so the work grows with the number of distinct
 * email domains.
 *
 * `limit` caps the returned rows after sorting; `totalDomains` and
 * `totalBlockedUsers` still describe the whole list so the caller can say what
 * it is not showing.
 */
export function computeBlacklistStats(
  blacklistedDomains: string[],
  emailDomainCounts: readonly EmailDomainCount[],
  limit?: number
): BlacklistStats {
  const lookup = new Set(blacklistedDomains.map(domain => domain.toLowerCase()));
  const counts = new Map<string, number>();

  for (const row of emailDomainCounts) {
    if (row.email_domain === null) continue;

    const labels = row.email_domain.toLowerCase().split('.');
    for (let i = 0; i < labels.length; i++) {
      const candidate = labels.slice(i).join('.');
      if (!lookup.has(candidate)) continue;

      counts.set(candidate, (counts.get(candidate) ?? 0) + row.count);
    }
  }

  const domainCounts = blacklistedDomains.map(domain => ({
    domain,
    blockedCount: counts.get(domain.toLowerCase()) ?? 0,
  }));

  domainCounts.sort((a, b) => b.blockedCount - a.blockedCount);

  return {
    domains: limit === undefined ? domainCounts : domainCounts.slice(0, limit),
    totalDomains: blacklistedDomains.length,
    totalBlockedUsers: domainCounts.reduce((sum, d) => sum + d.blockedCount, 0),
  };
}
