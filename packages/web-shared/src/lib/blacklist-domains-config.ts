import 'server-only';
import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { asc } from 'drizzle-orm';
import { blacklisted_domains } from '@kilocode/db/schema';
import { createEmailDomainBlacklistCache } from '@kilocode/worker-utils/account-access';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import {
  BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
  LEGACY_BLACKLIST_DOMAINS_REDIS_KEY,
} from '@kilocode/web-shared/lib/redis-keys';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * TLDs refused for new signups until an admin changes the stored list. `.shop`
 * and `.top` are the long-standing defaults.
 */
export const DEFAULT_BLOCKED_SIGNUP_TLDS = ['shop', 'top'];

export const BlacklistDomainsSettingsSchema = z.object({
  // TLDs whose new signups are refused. Absent until an admin saves a list, so readers fall
  // back to the deployment default. An empty array means "no TLD blocked".
  blocked_signup_tlds: z.array(z.string()).optional(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
});

export type BlacklistDomainsSettings = z.infer<typeof BlacklistDomainsSettingsSchema>;

export const DEFAULT_BLACKLIST_DOMAINS_SETTINGS: BlacklistDomainsSettings = {
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

function getEnvFallbackSignupTlds(): string[] {
  const envVal = getEnvVariable('BLOCKED_SIGNUP_TLDS');
  return envVal ? normalizeSignupTlds(envVal.split('|')) : DEFAULT_BLOCKED_SIGNUP_TLDS;
}

export const envFallbackSignupTlds = getEnvFallbackSignupTlds();

function parseSettings(raw: string): BlacklistDomainsSettings {
  return BlacklistDomainsSettingsSchema.parse(JSON.parse(raw));
}

/**
 * The settings used to share one Redis value with the complete domain list. Copies them into
 * their own key once, without overwriting a newer admin save; once that key exists, this never
 * runs. The next admin save migrates through here and then deletes the legacy value. A
 * concurrent save can do both after the caller found no settings, so the settings key is re-read
 * even when the legacy value is gone.
 */
async function migrateLegacySettings(): Promise<BlacklistDomainsSettings | null> {
  const legacy = await redisClient.get<string>(LEGACY_BLACKLIST_DOMAINS_REDIS_KEY);
  if (legacy !== null) {
    await redisClient.set(
      BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY,
      JSON.stringify(parseSettings(legacy)),
      { nx: true }
    );
  }
  const raw = await redisClient.get<string>(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY);
  return raw === null ? null : parseSettings(raw);
}

export async function readBlacklistDomainsSettings(): Promise<BlacklistDomainsSettings | null> {
  const raw = await redisClient.get<string>(BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY);
  return raw === null ? migrateLegacySettings() : parseSettings(raw);
}

/**
 * Throws when the read or the stored payload is unusable, after reporting it: createCachedFetch
 * then keeps serving the last settings it read successfully, and retries once the failure
 * backoff window passes.
 */
async function readSettingsOrReport(): Promise<BlacklistDomainsSettings | null> {
  try {
    return await readBlacklistDomainsSettings();
  } catch (error) {
    errorExceptInTest('[blacklist-domains] Failed to read the blacklist settings:', error);
    captureException(error, { tags: { source: 'blacklist_domains_config' } });
    throw error;
  }
}

const getCachedSettings = createCachedFetch<BlacklistDomainsSettings | null>(
  readSettingsOrReport,
  60_000,
  null,
  { name: 'blacklistDomainsSettings' }
);

/**
 * The admin-configured signup TLD blocklist. An absent field keeps the deployment default (or
 * BLOCKED_SIGNUP_TLDS); an explicit empty array disables TLD blocking.
 */
export async function getBlockedSignupTlds(): Promise<string[]> {
  const settings = await getCachedSettings();
  return normalizeSignupTlds(settings?.blocked_signup_tlds ?? envFallbackSignupTlds);
}

const emailDomainBlacklist = createEmailDomainBlacklistCache();

/**
 * Whether the address's domain, or a parent domain, is blacklisted. Answers are cached in
 * process for a minute, so an admin change can take that long to apply.
 */
export function isEmailBlacklisted(
  email: string,
  fromDb: Pick<typeof db, 'select'> = db
): Promise<boolean> {
  return emailDomainBlacklist.isBlacklisted(fromDb, email);
}

export function clearEmailBlacklistCache(): void {
  emailDomainBlacklist.clear();
}

/** The complete blacklist, for admin reports and backfills. Access checks use isEmailBlacklisted. */
export async function listBlacklistedDomains(
  fromDb: Pick<typeof db, 'select'> = db
): Promise<string[]> {
  const rows = await fromDb
    .select({ domain: blacklisted_domains.domain })
    .from(blacklisted_domains)
    .orderBy(asc(blacklisted_domains.domain));
  return rows.map(row => row.domain);
}
