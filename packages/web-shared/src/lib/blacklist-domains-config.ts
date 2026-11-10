import 'server-only';
import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { after } from 'next/server';
import { asc, gt, sql } from 'drizzle-orm';
import { blacklisted_domains } from '@kilocode/db/schema';
import {
  blockedSignupTldsFromConfig,
  isEmailDomainBlacklisted,
  BlacklistDomainsConfigSchema,
  BLACKLISTED_DOMAINS_REDIS_KEY,
  BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY,
  type BlacklistDomainsConfig,
} from '@kilocode/worker-utils/account-access';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { db } from '@kilocode/web-shared/lib/drizzle';

export type { BlacklistDomainsConfig };

/**
 * TLDs refused for new signups until an admin changes the stored list. `.shop`
 * and `.top` are the long-standing defaults.
 */
export const DEFAULT_BLOCKED_SIGNUP_TLDS = ['shop', 'top'];

export const DEFAULT_BLACKLIST_DOMAINS_CONFIG: BlacklistDomainsConfig = {
  domains: [],
  // `blocked_signup_tlds` stays unset so a missing key resolves through
  // getBlockedSignupTlds(): the env fallback stays in effect and the editor
  // cannot show a list that auth does not enforce.
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
};

export const BlacklistDomainsInputSchema = z.object({
  domains: z.array(z.string().min(1).trim()),
  blocked_tlds: z.array(z.string().min(1).trim()).optional(),
});

/**
 * Accepts `asia`, `.asia` and `ASIA` alike, and stores the bare label: the
 * matcher walks the label suffixes of an email host, so `asia` matches every
 * `*.asia` address.
 */
export function normalizeSignupTlds(values: readonly string[]): string[] {
  const normalized = values
    .map(value => value.trim().toLowerCase().replace(/^\.+/, ''))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function getEnvFallbackDomains(): string[] {
  const envVal = getEnvVariable('BLACKLIST_DOMAINS');
  return envVal
    ? envVal
        .split('|')
        .map((d: string) => d.trim())
        .filter(Boolean)
    : [];
}

function getEnvFallbackSignupTlds(): string[] {
  const envVal = getEnvVariable('BLOCKED_SIGNUP_TLDS');
  return envVal ? normalizeSignupTlds(envVal.split('|')) : DEFAULT_BLOCKED_SIGNUP_TLDS;
}

// Resolved once so an unchanged fallback keeps the domain index built for its array.
export const envFallbackDomains = getEnvFallbackDomains();
export const envFallbackSignupTlds = getEnvFallbackSignupTlds();

const SmallSettingsSchema = BlacklistDomainsConfigSchema.extend({
  domains: z.array(z.string()).length(0),
});
const LegacySettingsSchema = BlacklistDomainsConfigSchema.omit({ domains: true });

export async function readBlacklistDomainsSettings(): Promise<BlacklistDomainsConfig> {
  const raw = await redisClient.get<string>(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
  if (raw !== null) return SmallSettingsSchema.parse(JSON.parse(raw));
  const legacy = await redisClient.get<string>(BLACKLISTED_DOMAINS_REDIS_KEY);
  if (legacy === null) return DEFAULT_BLACKLIST_DOMAINS_CONFIG;
  return { ...LegacySettingsSchema.parse(JSON.parse(legacy)), domains: [] };
}

/**
 * Reads the operator-maintained config from Redis. Throws when the read or the stored payload
 * is unusable, after reporting it: createCachedFetch then keeps serving the last config it read
 * successfully, and retries once the failure backoff window passes.
 */
async function readSettings(): Promise<BlacklistDomainsConfig> {
  try {
    return await readBlacklistDomainsSettings();
  } catch (error) {
    errorExceptInTest('[blacklist-domains] Failed to read signup settings:', error);
    captureException(error, { tags: { source: 'blacklist_domains_config' } });
    throw error;
  }
}

const getCachedSettings = createCachedFetch<BlacklistDomainsConfig | null>(
  readSettings,
  60_000,
  null,
  { name: 'blacklistDomainsSettings' }
);

export function isEmailBlacklisted(email: string, fromDb: Pick<typeof db, 'select'> = db) {
  return isEmailDomainBlacklisted(fromDb, email, envFallbackDomains, {
    get: key => redisClient.get<string>(key),
    set: (key, value, ttlSeconds) => redisClient.set(key, value, { ex: ttlSeconds }),
    defer: after,
    onError: error => captureException(error, { tags: { source: 'blacklist_domain_cache' } }),
  });
}

const DOMAIN_BATCH_SIZE = 1000;

export async function listStoredDomains(fromDb: Pick<typeof db, 'select'>): Promise<string[]> {
  const domains: string[] = [];
  let cursor: string | null = null;
  for (;;) {
    const rows = await fromDb
      .select({ domain: blacklisted_domains.domain })
      .from(blacklisted_domains)
      .where(cursor === null ? sql`true` : gt(blacklisted_domains.domain, cursor))
      .orderBy(asc(blacklisted_domains.domain))
      .limit(DOMAIN_BATCH_SIZE);
    domains.push(...rows.map(row => row.domain));
    if (rows.length < DOMAIN_BATCH_SIZE) return domains;
    cursor = rows[rows.length - 1].domain;
  }
}

/** Admin reports and account backfills only. Access checks must use isEmailBlacklisted. */
export async function getBlacklistedDomains(
  fromDb: Pick<typeof db, 'select'> = db
): Promise<string[]> {
  const domains = await listStoredDomains(fromDb);
  return domains.length === 0 ? envFallbackDomains : domains;
}

/**
 * The admin-configured signup TLD blocklist from the small settings entry. An absent field keeps
 * the deployment default (or BLOCKED_SIGNUP_TLDS); an explicit empty array disables TLD
 * blocking.
 */
export async function getBlockedSignupTlds(): Promise<string[]> {
  const current = await getCachedSettings();
  return normalizeSignupTlds(blockedSignupTldsFromConfig(current, envFallbackSignupTlds));
}
