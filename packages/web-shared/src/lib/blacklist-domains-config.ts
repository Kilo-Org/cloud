import 'server-only';
import * as z from 'zod';
import { asc } from 'drizzle-orm';
import { blacklisted_domains, blacklisted_domains_settings } from '@kilocode/db/schema';
import { createEmailDomainBlacklistCache } from '@kilocode/worker-utils/account-access';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

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
const StoredBlacklistDomainsSettingsSchema = BlacklistDomainsSettingsSchema.required({
  blocked_signup_tlds: true,
});

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

export async function readBlacklistDomainsSettings(
  fromDb: Pick<typeof db, 'select'> = db
): Promise<(BlacklistDomainsSettings & { blocked_signup_tlds: string[] }) | null> {
  const [row] = await fromDb.select().from(blacklisted_domains_settings).limit(1);
  if (!row) return null;

  return StoredBlacklistDomainsSettingsSchema.parse({
    blocked_signup_tlds: row.blocked_signup_tlds,
    updated_at: new Date(row.updated_at).toISOString(),
    updated_by: row.updated_by,
    updated_by_email: row.updated_by_email,
  });
}

/**
 * The admin-configured signup TLD blocklist. An absent row keeps the deployment default (or
 * BLOCKED_SIGNUP_TLDS); an explicit empty array disables TLD blocking.
 */
export async function getBlockedSignupTlds(): Promise<string[]> {
  const settings = await readBlacklistDomainsSettings();
  return normalizeSignupTlds(settings ? settings.blocked_signup_tlds : envFallbackSignupTlds);
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
