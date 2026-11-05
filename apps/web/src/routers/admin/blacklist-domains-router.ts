import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  BlacklistDomainsInputSchema,
  DEFAULT_BLACKLIST_DOMAINS_CONFIG,
  getBlacklistedDomains,
  getBlockedSignupTlds,
  normalizeSignupTlds,
} from '@kilocode/web-shared/lib/blacklist-domains-config';
import {
  parseBlacklistDomainsConfig,
  type ParsedBlacklistDomainsConfig,
} from '@kilocode/worker-utils/account-access';
import {
  BLACKLIST_DOMAINS_REDIS_KEY,
  BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import type { BlacklistDomainsConfig } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { captureException } from '@sentry/nextjs';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, count, isNotNull, desc, min, max } from 'drizzle-orm';
import * as z from 'zod';
import { backfillBlockBlacklistedDomainsBatch } from '@/lib/abuse/block-blacklisted-domains';
import {
  BLACKLIST_STATS_ROW_LIMIT,
  computeBlacklistStats,
  countUsersByEmailHost,
} from '@/lib/abuse/blacklist-domain-stats';

const SuspiciousDomainsInputSchema = z
  .object({
    hideLegitimateProviders: z.boolean().default(true),
  })
  .optional();

async function readConfigOrThrow(): Promise<ParsedBlacklistDomainsConfig> {
  const raw = await redisClient.get<string>(BLACKLIST_DOMAINS_REDIS_KEY);
  if (!raw) return { config: DEFAULT_BLACKLIST_DOMAINS_CONFIG, droppedDomains: 0 };
  return parseBlacklistDomainsConfig(JSON.parse(raw));
}

async function readConfig(): Promise<ParsedBlacklistDomainsConfig> {
  try {
    return await readConfigOrThrow();
  } catch {
    return { config: DEFAULT_BLACKLIST_DOMAINS_CONFIG, droppedDomains: 0 };
  }
}

export const adminBlacklistDomainsRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const { config, droppedDomains } = await readConfig();
    return {
      ...config,
      // The editor always shows an editable list: the stored one, or the
      // effective fallback (env or built-in) when the stored config predates
      // the field.
      blocked_signup_tlds: config.blocked_signup_tlds ?? (await getBlockedSignupTlds()),
      // Entries the stored list held beyond MAX_BLACKLIST_DOMAINS. Nonzero means
      // the editor shows a prefix of the stored list.
      dropped_domains: droppedDomains,
    };
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
    let previous: BlacklistDomainsConfig | null = null;
    try {
      previous = (await readConfigOrThrow()).config;
    } catch (error) {
      captureException(error, { tags: { source: 'blacklist_domains_previous_config_read' } });
    }
    const previousDomains = new Set((previous?.domains ?? []).map(d => d.toLowerCase().trim()));
    const addedDomains = previous
      ? normalizedDomains.filter(domain => !previousDomains.has(domain))
      : null;

    // An omitted field keeps the stored list so a stale admin tab cannot
    // silently disable TLD blocking. A failed previous read falls back to the
    // cached effective list rather than overwriting with the built-in default.
    // A TLD never triggers a backfill: it only gates new signups.
    const blockedSignupTlds =
      input.blocked_tlds === undefined
        ? (previous?.blocked_signup_tlds ?? (await getBlockedSignupTlds()))
        : normalizeSignupTlds(input.blocked_tlds);

    const updatedAt = new Date().toISOString();
    const config: BlacklistDomainsConfig = {
      domains: normalizedDomains,
      blocked_signup_tlds: blockedSignupTlds,
      updated_at: updatedAt,
      updated_by: ctx.user.id,
      updated_by_email: ctx.user.google_user_email,
    };
    // Readers download the list only when the updated_at key changes, so both
    // keys must change together.
    await redisClient.mset({
      [BLACKLIST_DOMAINS_REDIS_KEY]: JSON.stringify(config),
      [BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY]: updatedAt,
    });

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

    // Read-only admin report: the grouped aggregate stays off the primary pool.
    const emailHostCounts = await countUsersByEmailHost(readDb);

    return computeBlacklistStats(domains, emailHostCounts, BLACKLIST_STATS_ROW_LIMIT);
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
