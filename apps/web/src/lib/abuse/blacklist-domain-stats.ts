import type { DrizzleClient } from '@kilocode/db/client';
import { kilocode_users } from '@kilocode/db/schema';
import { count, sql } from 'drizzle-orm';

// Reports return only the domains with matching users, ordered by count, so the
// payload stays small for a large configured list.
export const BLACKLIST_STATS_ROW_LIMIT = 200;

export type EmailHostCount = {
  email_host: string | null;
  // False when the address holds no '@', which starts the entry walk one label
  // lower, exactly as isEmailBlacklistedByDomain reads it.
  has_local_part: boolean;
  count: number;
};

export type BlacklistStats = {
  domains: { domain: string; blockedCount: number }[];
  totalDomains: number;
  totalBlockedUsers: number;
};

const atSignCountSql = sql`length(${kilocode_users.google_user_email}) - length(replace(${kilocode_users.google_user_email}, '@', ''))`;
const hasLocalPartSql = sql<boolean>`${atSignCountSql} > 0`;

// The host part of the account email, lowercased. This is the text after the
// last '@', and the whole address when it holds none, because that is the host
// isEmailBlacklistedByDomain reads from a sign-in email. Blacklist entries
// match this host on label boundaries, so an entry below the registrable domain
// still reports the accounts it stops.
const emailHostSql = sql<string>`lower(split_part(${kilocode_users.google_user_email}, '@', ${atSignCountSql} + 1))`;

/**
 * Reads one grouped count of users per email host. A report builds its
 * per-entry totals from this single statement, whatever the configured list
 * size: the grouped rows are bounded by the distinct hosts in the table, not by
 * the list.
 *
 * Pass `readDb` for read-only reports. The caller owns the choice of pool.
 */
export async function countUsersByEmailHost(
  database: DrizzleClient['db']
): Promise<EmailHostCount[]> {
  return database
    .select({
      email_host: emailHostSql,
      has_local_part: hasLocalPartSql,
      count: count(),
    })
    .from(kilocode_users)
    .groupBy(emailHostSql, hasLocalPartSql);
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
    // An address without '@' reads as its own host and matches only through a
    // dotted suffix, so its whole text is never an exact entry.
    const firstLabel = row.has_local_part ? 0 : 1;
    for (let i = firstLabel; i < labels.length; i++) {
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
