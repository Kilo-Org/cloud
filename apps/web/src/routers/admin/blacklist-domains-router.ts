import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { redisGet, redisSet } from '@/lib/redis';
import {
  BlacklistDomainsConfigSchema,
  BlacklistDomainsInputSchema,
  DEFAULT_BLACKLIST_DOMAINS_CONFIG,
  getBlacklistedDomains,
} from '@/lib/blacklist-domains-config';
import { BLACKLIST_DOMAINS_REDIS_KEY } from '@/lib/redis-keys';
import type { BlacklistDomainsConfig } from '@/lib/blacklist-domains-config';
import { TRPCError } from '@trpc/server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, count, isNotNull, desc, min, max } from 'drizzle-orm';

async function readConfig(): Promise<BlacklistDomainsConfig> {
  try {
    const raw = await redisGet(BLACKLIST_DOMAINS_REDIS_KEY);
    if (!raw) return DEFAULT_BLACKLIST_DOMAINS_CONFIG;
    return BlacklistDomainsConfigSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_BLACKLIST_DOMAINS_CONFIG;
  }
}

export const adminBlacklistDomainsRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    return readConfig();
  }),

  set: adminProcedure.input(BlacklistDomainsInputSchema).mutation(async ({ input, ctx }) => {
    // Deduplicate and normalize domains
    const normalizedDomains = [
      ...new Set(input.domains.map(d => d.toLowerCase().trim()).filter(Boolean)),
    ];

    const config: BlacklistDomainsConfig = {
      domains: normalizedDomains,
      updated_at: new Date().toISOString(),
      updated_by: ctx.user.id,
      updated_by_email: ctx.user.google_user_email,
    };
    const written = await redisSet(BLACKLIST_DOMAINS_REDIS_KEY, JSON.stringify(config));
    if (!written) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Redis is not configured — cannot save blacklisted domains',
      });
    }
    return config;
  }),

  stats: adminProcedure.query(async () => {
    const domains = await getBlacklistedDomains();

    // One grouped query against the indexed email_domain column rather than
    // an N+1 LIKE scan of google_user_email per blacklist entry.
    const emailDomainCounts = await db
      .select({
        email_domain: kilocode_users.email_domain,
        count: count(),
      })
      .from(kilocode_users)
      .where(isNotNull(kilocode_users.email_domain))
      .groupBy(kilocode_users.email_domain);

    return computeBlacklistStats(domains, emailDomainCounts);
  }),

  suspicious: adminProcedure.query(async () => {
    const blacklistedDomains = await getBlacklistedDomains();
    const normalizedBlacklist = blacklistedDomains.map(d => d.toLowerCase());

    const blockedCountExpr = sql<number>`count(*) FILTER (WHERE ${kilocode_users.blocked_reason} IS NOT NULL)`;
    // Hide noise: require at least 1% of users on the domain to have been
    // blocked before surfacing it. Computed against count(*) so a one-off
    // block on a huge domain doesn't appear here.
    const minBlockedPercent = sql`${blockedCountExpr} * 100 >= count(*)`;

    const rows = await db
      .select({
        email_domain: kilocode_users.email_domain,
        account_count: count(),
        blocked_account_count: blockedCountExpr.mapWith(Number),
        first_seen: min(kilocode_users.created_at),
        last_seen: max(kilocode_users.created_at),
      })
      .from(kilocode_users)
      .where(isNotNull(kilocode_users.email_domain))
      .groupBy(kilocode_users.email_domain)
      .having(minBlockedPercent)
      .orderBy(desc(blockedCountExpr), desc(count()))
      .limit(100);

    const domains = rows.map(row => ({
      domain: row.email_domain ?? '',
      accountCount: row.account_count,
      blockedAccountCount: row.blocked_account_count,
      blockedAccountPercent:
        row.account_count === 0
          ? 0
          : Math.round((10000 * row.blocked_account_count) / row.account_count) / 100,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      isBlacklisted: isDomainOnBlacklist(row.email_domain ?? '', normalizedBlacklist),
    }));

    return { domains };
  }),
});

// Mirrors the suffix semantics of isEmailBlacklistedByDomain, but operates
// directly on a domain string (e.g. the value stored in email_domain). A
// blacklist entry matches a domain when the domain equals it or is a
// subdomain of it.
export function isDomainOnBlacklist(domain: string, normalizedBlacklist: string[]): boolean {
  const lower = domain.toLowerCase();
  return normalizedBlacklist.some(entry => lower === entry || lower.endsWith('.' + entry));
}

export type EmailDomainCount = { email_domain: string | null; count: number };

export type BlacklistStats = {
  domains: { domain: string; blockedCount: number }[];
  totalDomains: number;
  totalBlockedUsers: number;
};

/**
 * Aggregates per-email_domain counts into per-blacklist-entry blocked counts.
 *
 * For each blacklist entry, sums the counts of email_domain groups that match
 * it via isDomainOnBlacklist (equality or strict subdomain). This preserves
 * the original suffix-match semantics of the old google_user_email LIKE query
 * while scanning only the grouped result set.
 */
export function computeBlacklistStats(
  blacklistedDomains: string[],
  emailDomainCounts: readonly EmailDomainCount[]
): BlacklistStats {
  const domainCounts = blacklistedDomains.map(domain => {
    const entry = domain.toLowerCase();
    let blockedCount = 0;
    for (const row of emailDomainCounts) {
      if (row.email_domain !== null && isDomainOnBlacklist(row.email_domain, [entry])) {
        blockedCount += row.count;
      }
    }
    return { domain, blockedCount };
  });

  domainCounts.sort((a, b) => b.blockedCount - a.blockedCount);

  return {
    domains: domainCounts,
    totalDomains: blacklistedDomains.length,
    totalBlockedUsers: domainCounts.reduce((sum, d) => sum + d.blockedCount, 0),
  };
}
