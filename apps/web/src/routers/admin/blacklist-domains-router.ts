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
  BlacklistDomainsConfigSchema,
  MAX_BLACKLIST_DOMAINS,
} from '@kilocode/worker-utils/account-access';
import {
  BLACKLIST_DOMAINS_REDIS_KEY,
  BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import type { BlacklistDomainsConfig } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { captureException } from '@sentry/nextjs';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { blacklisted_domains, kilocode_users } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { sql, count, isNotNull, desc, min, max } from 'drizzle-orm';
import * as z from 'zod';
import { createHash } from 'node:crypto';
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

// Admin saves must round-trip the entire snapshot, not the access readers' capped prefix.
const AdminBlacklistDomainsConfigSchema = BlacklistDomainsConfigSchema.extend({
  domains: z.array(z.string()),
});
const AdminBlacklistDomainsInputSchema = BlacklistDomainsInputSchema.extend({
  domains: z.array(z.string().min(1).trim()),
  expected_version: z.string().length(64),
});

async function readConfigOrThrow() {
  const raw = await redisClient.get<string>(BLACKLIST_DOMAINS_REDIS_KEY);
  return {
    config:
      raw === null
        ? DEFAULT_BLACKLIST_DOMAINS_CONFIG
        : AdminBlacklistDomainsConfigSchema.parse(JSON.parse(raw)),
    version: createHash('sha256')
      .update(raw ?? '')
      .digest('hex'),
  };
}

export const adminBlacklistDomainsRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    const { config, version } = await readConfigOrThrow();
    return {
      ...config,
      version,
      // The editor always shows an editable list: the stored one, or the
      // effective fallback (env or built-in) when the stored config predates
      // the field.
      blocked_signup_tlds: config.blocked_signup_tlds ?? (await getBlockedSignupTlds()),
      dropped_domains: Math.max(0, config.domains.length - MAX_BLACKLIST_DOMAINS),
    };
  }),

  set: adminProcedure.input(AdminBlacklistDomainsInputSchema).mutation(async ({ input, ctx }) => {
    const normalizedDomains = [
      ...new Set(input.domains.map(d => d.toLowerCase().trim()).filter(Boolean)),
    ];

    let saved;
    try {
      saved = await db.transaction(async tx => {
        // Serialize both stores, including the previous-config read, across admin saves.
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
        await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE`);
        const { config: previous, version } = await readConfigOrThrow();
        if (version !== input.expected_version) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Blacklist changed. Reload the complete list before saving.',
          });
        }
        const previousDomains = new Set(previous.domains.map(d => d.toLowerCase().trim()));
        const addedDomains = normalizedDomains.filter(domain => !previousDomains.has(domain));
        const blockedSignupTlds =
          input.blocked_tlds === undefined
            ? (previous.blocked_signup_tlds ?? (await getBlockedSignupTlds()))
            : normalizeSignupTlds(input.blocked_tlds);

        const updatedAt = new Date().toISOString();
        const config: BlacklistDomainsConfig = {
          domains: normalizedDomains,
          blocked_signup_tlds: blockedSignupTlds,
          updated_at: updatedAt,
          updated_by: ctx.user.id,
          updated_by_email: ctx.user.google_user_email,
        };
        const deadline = Date.now() + 120_000;
        await tx.delete(blacklisted_domains);
        for (let offset = 0; offset < normalizedDomains.length; offset += 1000) {
          if (Date.now() > deadline) throw new Error('Blacklist synchronization timed out');
          await tx
            .insert(blacklisted_domains)
            .values(normalizedDomains.slice(offset, offset + 1000).map(domain => ({ domain })));
        }
        // Stage SQL first so failed batches leave Redis protection and the additions diff intact.
        // Redis and the commit cannot be atomic; never roll back Redis after an ambiguous failure.
        await redisClient.mset({
          [BLACKLIST_DOMAINS_REDIS_KEY]: JSON.stringify(config),
          [BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY]: updatedAt,
        });
        return { config, addedDomains };
      });
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'CONFLICT') throw error;
      captureException(error, { tags: { source: 'blacklist_domains_dual_write' } });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'Blacklist save failed. Redis may already be updated. Reload and retry to synchronize Postgres, then run the account backfill.',
        cause: error,
      });
    }
    const { config, addedDomains } = saved;

    // The list is already live for auth checks at this point, so a backfill
    // failure must not fail the save. Report it and point the admin at the
    // manual backfill instead.
    const backfill = { blocked: 0, remaining: false, failed: false };
    if (addedDomains.length > 0) {
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
