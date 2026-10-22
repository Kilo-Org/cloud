import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  BlacklistDomainsInputSchema,
  DEFAULT_BLACKLIST_DOMAINS_CONFIG,
  getBlacklistedDomains,
} from '@kilocode/web-shared/lib/blacklist-domains-config';
import { BlacklistDomainsConfigSchema } from '@kilocode/worker-utils/account-access';
import { BLACKLIST_DOMAINS_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import type { BlacklistDomainsConfig } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, count, isNotNull, desc, min, max } from 'drizzle-orm';
import * as z from 'zod';
import { backfillBlockBlacklistedDomainsBatch } from '@/lib/abuse/block-blacklisted-domains';

const SuspiciousDomainsInputSchema = z
  .object({
    hideLegitimateProviders: z.boolean().default(true),
  })
  .optional();

// The admin table renders one row per entry. An imported blocklist can hold
// tens of thousands of entries, so the procedure returns only the domains that
// actually caught users, ordered by count.
const STATS_ROW_LIMIT = 200;

async function readConfigOrThrow(): Promise<BlacklistDomainsConfig> {
  const raw = await redisClient.get<string>(BLACKLIST_DOMAINS_REDIS_KEY);
  if (!raw) return DEFAULT_BLACKLIST_DOMAINS_CONFIG;
  return BlacklistDomainsConfigSchema.parse(JSON.parse(raw));
}

async function readConfig(): Promise<BlacklistDomainsConfig> {
  try {
    return await readConfigOrThrow();
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

    // Diff against the list the admin started from so only newly added domains
    // trigger a backfill. A failed read must not look like an empty list: that
    // would turn a one-domain save into a backfill of every listed domain. Skip
    // the automatic run in that case and let the manual backfill handle it.
    let addedDomains: string[] | null;
    try {
      const previous = await readConfigOrThrow();
      const previousDomains = new Set(previous.domains.map(d => d.toLowerCase().trim()));
      addedDomains = normalizedDomains.filter(domain => !previousDomains.has(domain));
    } catch (error) {
      captureException(error, { tags: { source: 'blacklist_domains_previous_config_read' } });
      addedDomains = null;
    }

    const config: BlacklistDomainsConfig = {
      domains: normalizedDomains,
      updated_at: new Date().toISOString(),
      updated_by: ctx.user.id,
      updated_by_email: ctx.user.google_user_email,
    };
    const written = await redisClient.set(BLACKLIST_DOMAINS_REDIS_KEY, JSON.stringify(config));
    if (!written) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Redis is not configured — cannot save blacklisted domains',
      });
    }

    // The list is already live for auth checks at this point, so a backfill
    // failure must not fail the save. Report it and point the admin at the
    // manual backfill instead.
    const backfill = { blocked: 0, remaining: false, failed: addedDomains === null };
    if (addedDomains && addedDomains.length > 0) {
      try {
        const result = await backfillBlockBlacklistedDomainsBatch({
          actorId: ctx.user.id,
          domains: addedDomains,
        });
        backfill.blocked = result.processed;
        backfill.remaining = result.remaining;
      } catch (error) {
        captureException(error, { tags: { source: 'blacklist_domains_auto_backfill' } });
        backfill.failed = true;
      }
    }

    return { ...config, backfill };
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

    return computeBlacklistStats(domains, emailDomainCounts, STATS_ROW_LIMIT);
  }),

  suspicious: adminProcedure.input(SuspiciousDomainsInputSchema).query(async ({ input }) => {
    const blacklistedDomains = await getBlacklistedDomains();
    const normalizedBlacklist = blacklistedDomains.map(d => d.toLowerCase());
    const hideLegitimateProviders = input?.hideLegitimateProviders ?? true;

    const blockedCountExpr = sql<number>`count(*) FILTER (WHERE ${kilocode_users.blocked_reason} IS NOT NULL)`;
    // Hide noise: require at least 30% of users on the domain to have been
    // blocked before surfacing it. Keeps large legitimate providers (gmail,
    // hotmail, etc.) from showing up.
    const minBlockedPercent = sql`${blockedCountExpr} * 100 >= count(*) * 30`;

    const query = db
      .select({
        email_domain: kilocode_users.email_domain,
        account_count: count(),
        blocked_account_count: blockedCountExpr.mapWith(Number),
        first_seen: min(kilocode_users.created_at),
        last_seen: max(kilocode_users.created_at),
      })
      .from(kilocode_users)
      .where(isNotNull(kilocode_users.email_domain))
      .groupBy(kilocode_users.email_domain);

    const rows = await (hideLegitimateProviders ? query.having(minBlockedPercent) : query)
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
 * Walks each email_domain once and credits every blacklist entry that is one of
 * its label-boundary suffixes. The entry-major alternative (test every entry
 * against every group) is quadratic and does not survive a large imported list.
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
