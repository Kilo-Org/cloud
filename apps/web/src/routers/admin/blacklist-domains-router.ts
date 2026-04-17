import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { redisGet, redisSet } from '@/lib/redis';
import {
  BLACKLIST_DOMAINS_REDIS_KEY,
  BlacklistDomainsConfigSchema,
  BlacklistDomainsInputSchema,
  DEFAULT_BLACKLIST_DOMAINS_CONFIG,
  getBlacklistedDomains,
} from '@/lib/blacklist-domains-config';
import type { BlacklistDomainsConfig } from '@/lib/blacklist-domains-config';
import { TRPCError } from '@trpc/server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, count, isNotNull, or, desc, min, max } from 'drizzle-orm';

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

    const domainCounts = await Promise.all(
      domains.map(async domain => {
        const conditions = or(
          sql`lower(${kilocode_users.google_user_email}) LIKE ${`%@${domain.toLowerCase()}`}`,
          sql`lower(${kilocode_users.google_user_email}) LIKE ${`%.${domain.toLowerCase()}`}`
        );

        const result = await db.select({ count: count() }).from(kilocode_users).where(conditions);

        return {
          domain,
          blockedCount: result[0]?.count ?? 0,
        };
      })
    );

    domainCounts.sort((a, b) => b.blockedCount - a.blockedCount);

    return {
      domains: domainCounts,
      totalDomains: domains.length,
      totalBlockedUsers: domainCounts.reduce((sum, d) => sum + d.blockedCount, 0),
    };
  }),

  suspicious: adminProcedure.query(async () => {
    const blacklistedDomains = await getBlacklistedDomains();
    const normalizedBlacklist = blacklistedDomains.map(d => d.toLowerCase());

    const blockedCountExpr = sql<number>`count(*) FILTER (WHERE ${kilocode_users.blocked_reason} IS NOT NULL)`;

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
