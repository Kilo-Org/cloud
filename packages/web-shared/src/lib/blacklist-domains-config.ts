import 'server-only';
import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import { asc } from 'drizzle-orm';
import { blacklisted_domains, blacklisted_domains_settings } from '@kilocode/db/schema';
import { createEmailDomainBlacklistCache } from '@kilocode/worker-utils/account-access';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

/**
 * TLDs refused for new signups until an admin changes the stored list. These are
 * the long-standing defaults.
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
/** A settings row that exists: the admin saved a list, possibly explicitly empty. */
type StoredBlacklistDomainsSettings = z.infer<typeof StoredBlacklistDomainsSettingsSchema>;

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
 * Accepts `asia`, `.asia`, `ASIA` and `asia.` alike, strips the leading and
 * trailing dots, and stores only the bare label: the matcher walks the label
 * suffixes of an email host, so `asia` matches every `*.asia` address.
 */
export function normalizeSignupTlds(values: readonly string[]): string[] {
  const normalized = values
    .map(value =>
      value
        .trim()
        .toLowerCase()
        .replace(/^\.+|\.+$/g, '')
    )
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
): Promise<StoredBlacklistDomainsSettings | null> {
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
 * One outage reports at most once per window per instance. The retired cache negatively cached a
 * failure for its 30 s backoff window, which capped reporting at this rate; reading without a
 * cache would otherwise spend the Sentry quota on one event per signup attempt.
 */
const SIGNUP_TLD_REPORT_INTERVAL_MS = 30_000;
let lastSignupTldReportAt = Number.NEGATIVE_INFINITY;

/**
 * The last settings a read in this process returned, so a failed read can serve them. `read`
 * with `settings: null` is a successful read of an absent row, which is itself last-known-good;
 * `none` means no read has succeeded yet, where the deployment list applies instead.
 */
type SignupTldSnapshot =
  | { state: 'none' }
  | { state: 'read'; settings: StoredBlacklistDomainsSettings | null };
let lastSignupTldSnapshot: SignupTldSnapshot = { state: 'none' };

/** Tests clear the failure window and the remembered settings; production keeps both. */
export function resetSignupTldStateForTest(): void {
  lastSignupTldReportAt = Number.NEGATIVE_INFINITY;
  lastSignupTldSnapshot = { state: 'none' };
}

/**
 * Reads the signup TLD settings, reporting a failure and serving the last-known-good value.
 * Before #11609 the read sat behind `createCachedFetch`, which caught the same reported error and
 * returned `cached?.value ?? defaultValue`: the settings of the last successful read, or its
 * `null` default when no read had succeeded yet. This keeps that behaviour, so an outage leaves
 * the admin's saved TLDs in force instead of relaxing the gate to the deployment list; only a
 * failure before any successful read falls back to the deployment list (or BLOCKED_SIGNUP_TLDS).
 *
 * Remembering the value does not delay an update: every check still reads Postgres, and the
 * remembered settings are used only once a read has failed. That keeps an admin save immediate,
 * which is what #11609 wanted.
 */
async function readSignupTldSettingsOrReport(): Promise<StoredBlacklistDomainsSettings | null> {
  try {
    const settings = await readBlacklistDomainsSettings();
    lastSignupTldSnapshot = { state: 'read', settings };
    return settings;
  } catch (error) {
    const now = Date.now();
    if (now - lastSignupTldReportAt >= SIGNUP_TLD_REPORT_INTERVAL_MS) {
      lastSignupTldReportAt = now;
      // The log line and the Sentry event describe one failure, so they share the window;
      // leaving the log outside it would emit a line per signup attempt during an outage.
      errorExceptInTest('[blacklist-domains] Failed to read the signup TLD settings:', error);
      captureException(error, { tags: { source: 'blacklist_domains_config' } });
    }
    return lastSignupTldSnapshot.state === 'read' ? lastSignupTldSnapshot.settings : null;
  }
}

/**
 * The admin-configured signup TLD blocklist. An absent row keeps the deployment default (or
 * BLOCKED_SIGNUP_TLDS); an explicit empty array disables TLD blocking.
 *
 * The read happens on every check, so an admin save is immediate. When a read fails, the gate
 * reports and keeps the settings the last successful read returned, so an outage does not change
 * which TLDs are blocked.
 */
export async function getBlockedSignupTlds(): Promise<string[]> {
  const settings = await readSignupTldSettingsOrReport();
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
