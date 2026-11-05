import type { DrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { count, sql } from 'drizzle-orm';

// Reports return only the domains with matching users, ordered by count, so the
// payload stays small for a large configured list.
export const BLACKLIST_STATS_ROW_LIMIT = 200;

export type EmailHostCount = { email_host: string | null; count: number };

export type BlacklistStats = {
  domains: { domain: string; blockedCount: number }[];
  totalDomains: number;
  totalBlockedUsers: number;
};

// The host part of the account email, lowercased. Blacklist entries match this
// host on label boundaries, the same way sign-in matches them, so an entry below
// the registrable domain still reports the accounts it stops.
const emailHostSql = sql<
  string | null
>`lower(split_part(${kilocode_users.google_user_email}, '@', 2))`;

/**
 * Reads one grouped count of users per email host. A report builds its
 * per-entry totals from this single statement, whatever the configured list
 * size.
 *
 * Pass `readDb` for read-only reports. The caller owns the choice of pool.
 */
export async function countUsersByEmailHost(
  database: DrizzleClient['db']
): Promise<EmailHostCount[]> {
  return database
    .select({ email_host: emailHostSql, count: count() })
    .from(kilocode_users)
    .groupBy(emailHostSql);
}

/**
 * Aggregates per-host counts into per-blacklist-entry blocked counts.
 *
 * Walks each host once and credits every blacklist entry that is one of its
 * label-boundary suffixes, so the work grows with the number of distinct email
 * hosts.
 *
 * `limit` caps the returned rows after sorting; `totalDomains` and
 * `totalBlockedUsers` still describe the whole list so the caller can say what
 * it is not showing.
 */
export function computeBlacklistStats(
  blacklistedDomains: string[],
  emailHostCounts: readonly EmailHostCount[],
  limit?: number
): BlacklistStats {
  const lookup = new Set(blacklistedDomains.map(domain => domain.toLowerCase()));
  const counts = new Map<string, number>();

  for (const row of emailHostCounts) {
    if (row.email_host === null) continue;

    const labels = row.email_host.toLowerCase().split('.');
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
