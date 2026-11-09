import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  BlacklistDomainsInputSchema,
  envFallbackSignupTlds,
  getBlacklistedDomains,
  listStoredDomains,
  readBlacklistDomainsSettings,
  normalizeSignupTlds,
} from '@kilocode/web-shared/lib/blacklist-domains-config';
import { BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY } from '@kilocode/worker-utils/account-access';
import {
  BLACKLIST_DOMAINS_REDIS_KEY,
  BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import type { BlacklistDomainsConfig } from '@kilocode/web-shared/lib/blacklist-domains-config';
import { captureException } from '@sentry/nextjs';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { blacklisted_domains, domain_blacklist_state, kilocode_users } from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { sql, count, isNotNull, desc, min, max, eq } from 'drizzle-orm';
import * as z from 'zod';
import { createHash, randomUUID } from 'node:crypto';
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

const AdminBlacklistDomainsInputSchema = BlacklistDomainsInputSchema.extend({
  domains: z.array(z.string().min(1).trim()),
  expected_version: z.string().length(64),
});

async function readConfigOrThrow(fromDb: Pick<typeof db, 'select'>) {
  const [state] = await fromDb
    .select({ revision: domain_blacklist_state.revision })
    .from(domain_blacklist_state)
    .where(eq(domain_blacklist_state.id, 1))
    .limit(1)
    .for('share');
  if (!state) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Domain blacklist initialization has not completed.',
    });
  }
  const settings = await readBlacklistDomainsSettings();
  return {
    config: { ...settings, domains: await listStoredDomains(fromDb) },
    version: createHash('sha256').update(`postgres:${state.revision}`).digest('hex'),
  };
}

export const adminBlacklistDomainsRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    return db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
      const { config, version } = await readConfigOrThrow(tx);
      return {
        ...config,
        version,
        blocked_signup_tlds: normalizeSignupTlds(
          config.blocked_signup_tlds ?? envFallbackSignupTlds
        ),
        dropped_domains: 0,
      };
    });
  }),

  set: adminProcedure.input(AdminBlacklistDomainsInputSchema).mutation(async ({ input, ctx }) => {
    const normalizedDomains = [
      ...new Set(input.domains.map(d => d.toLowerCase().trim()).filter(Boolean)),
    ];

    let saved;
    try {
      saved = await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
        await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE`);
        const { config: previous, version } = await readConfigOrThrow(tx);
        if (version !== input.expected_version) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Blacklist changed. Reload the complete list before saving.',
          });
        }
        const previousDomains = new Set(previous.domains.map(d => d.toLowerCase().trim()));
        const addedDomains = normalizedDomains.filter(domain => !previousDomains.has(domain));
        const blockedSignupTlds = normalizeSignupTlds(
          input.blocked_tlds ?? previous.blocked_signup_tlds ?? envFallbackSignupTlds
        );

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
        await tx
          .update(domain_blacklist_state)
          .set({ revision: randomUUID(), use_env_fallback: normalizedDomains.length === 0 })
          .where(eq(domain_blacklist_state.id, 1));
        await redisClient.mset({
          [BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY]: JSON.stringify({ ...config, domains: [] }),
          [BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY]: updatedAt,
        });
        return { config, addedDomains };
      });
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      captureException(error, { tags: { source: 'blacklist_domains_save' } });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'Blacklist save failed. Settings or the database commit may already have applied. Reload the Postgres list before retrying, then run the account backfill.',
        cause: error,
      });
    }
    const { config, addedDomains } = saved;

    let legacyCleanupFailed = false;
    try {
      await redisClient.eval(
        `if redis.call('TTL', KEYS[1]) == -1 then
          return redis.call('DEL', KEYS[1])
        end
        return 0`,
        [BLACKLIST_DOMAINS_REDIS_KEY],
        []
      );
    } catch (error) {
      captureException(error, { tags: { source: 'blacklist_domains_legacy_cleanup' } });
      legacyCleanupFailed = true;
    }

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

    return { ...config, backfill, legacy_cleanup_failed: legacyCleanupFailed };
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
