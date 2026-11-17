import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  BlacklistDomainsInputSchema,
  DEFAULT_BLACKLIST_DOMAINS_SETTINGS,
  clearEmailBlacklistCache,
  envFallbackSignupTlds,
  listBlacklistedDomains,
  normalizeSignupTlds,
  readBlacklistDomainsSettings,
  type BlacklistDomainsSettings,
} from '@kilocode/web-shared/lib/blacklist-domains-config';
import {
  BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
  LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
  LEGACY_BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
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

const AdminBlacklistDomainsInputSchema = BlacklistDomainsInputSchema.extend({
  expected_version: z.string().length(64),
});

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// A save writes its settings before committing its domains. Reads therefore hold at least a
// SHARE lock, which waits for an in-flight save, so a version never pairs new settings with the
// old domains.
async function lockBlacklist(tx: Transaction, mode: 'SHARE' | 'EXCLUSIVE') {
  await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
  await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
  await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN ${sql.raw(mode)} MODE`);
}

async function readConfig(tx: Transaction) {
  const [domains, storedSettings] = await Promise.all([
    listBlacklistedDomains(tx),
    readBlacklistDomainsSettings(),
  ]);
  const settings = storedSettings ?? DEFAULT_BLACKLIST_DOMAINS_SETTINGS;
  return {
    domains,
    settings,
    version: createHash('sha256').update(JSON.stringify({ domains, settings })).digest('hex'),
  };
}

// Only after a committed save: its readConfig has already copied the legacy settings into the
// settings key, so deleting the legacy value loses nothing.
async function deleteLegacyBlacklist() {
  try {
    await redisClient.del(
      LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
      LEGACY_BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY
    );
  } catch (error) {
    captureException(error, { tags: { source: 'blacklist_domains_legacy_cleanup' } });
  }
}

export const adminBlacklistDomainsRouter = createTRPCRouter({
  get: adminProcedure.query(() =>
    db.transaction(async tx => {
      await lockBlacklist(tx, 'SHARE');
      const { domains, settings, version } = await readConfig(tx);
      return {
        ...settings,
        domains,
        version,
        // The editor always shows an editable list: the stored one, or the effective fallback
        // (env or built-in) before an admin first saves one.
        blocked_signup_tlds: settings.blocked_signup_tlds ?? envFallbackSignupTlds,
      };
    })
  ),

  set: adminProcedure.input(AdminBlacklistDomainsInputSchema).mutation(async ({ input, ctx }) => {
    const normalizedDomains = [
      ...new Set(input.domains.map(d => d.toLowerCase().trim()).filter(Boolean)),
    ];

    let saved;
    try {
      saved = await db.transaction(async tx => {
        // Serializes saves, including the previous-config read.
        await lockBlacklist(tx, 'EXCLUSIVE');
        const previous = await readConfig(tx);
        if (previous.version !== input.expected_version) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Blacklist changed. Reload the complete list before saving.',
          });
        }
        const previousDomains = new Set(previous.domains);
        const addedDomains = normalizedDomains.filter(domain => !previousDomains.has(domain));
        const settings: BlacklistDomainsSettings = {
          blocked_signup_tlds: normalizeSignupTlds(
            input.blocked_tlds ?? previous.settings.blocked_signup_tlds ?? envFallbackSignupTlds
          ),
          updated_at: new Date().toISOString(),
          updated_by: ctx.user.id,
          updated_by_email: ctx.user.google_user_email,
        };
        const deadline = Date.now() + 120_000;
        await tx.delete(blacklisted_domains);
        for (let offset = 0; offset < normalizedDomains.length; offset += 1000) {
          if (Date.now() > deadline) throw new Error('Blacklist save timed out');
          await tx
            .insert(blacklisted_domains)
            .values(normalizedDomains.slice(offset, offset + 1000).map(domain => ({ domain })));
        }
        // Redis and the commit cannot be atomic. Writing last keeps a failed statement from
        // applying the settings; only a failed commit can leave them ahead of the domains.
        await redisClient.set(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY, JSON.stringify(settings));
        return { settings, addedDomains };
      });
    } catch (error) {
      if (error instanceof TRPCError && error.code === 'CONFLICT') throw error;
      captureException(error, { tags: { source: 'blacklist_domains_save' } });
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message:
          'Blacklist save failed. Reload the list before retrying; the signup TLDs may have been saved.',
        cause: error,
      });
    }
    const { settings, addedDomains } = saved;
    clearEmailBlacklistCache();
    await deleteLegacyBlacklist();

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

    return { ...settings, domains: normalizedDomains, backfill };
  }),

  stats: adminProcedure.query(async () => {
    // Read-only admin report: the list and the grouped aggregate stay off the primary pool.
    const [domains, emailHostCounts] = await Promise.all([
      listBlacklistedDomains(readDb),
      countUsersByEmailHost(readDb),
    ]);

    return computeBlacklistStats(domains, emailHostCounts, BLACKLIST_STATS_ROW_LIMIT);
  }),

  suspicious: adminProcedure.input(SuspiciousDomainsInputSchema).query(async ({ input }) => {
    const normalizedBlacklist = await listBlacklistedDomains(readDb);
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

// Mirrors the suffix semantics of emailDomainSuffixes, but operates
// directly on a domain string (e.g. the value stored in email_domain). A
// blacklist entry matches a domain when the domain equals it or is a
// subdomain of it.
export function isDomainOnBlacklist(domain: string, normalizedBlacklist: string[]): boolean {
  const lower = domain.toLowerCase();
  return normalizedBlacklist.some(entry => lower === entry || lower.endsWith('.' + entry));
}
