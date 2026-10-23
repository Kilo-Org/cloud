import 'server-only';
import * as z from 'zod';
import {
  blacklistedDomainsFromConfig,
  blockedSignupTldsFromConfig,
  type BlacklistDomainsConfigSchema,
} from '@kilocode/worker-utils/account-access';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { BLACKLIST_DOMAINS_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';

export type BlacklistDomainsConfig = z.infer<typeof BlacklistDomainsConfigSchema>;

/**
 * TLDs refused for new signups until an admin changes the stored list. `.top`
 * and `.shop` are the long-standing defaults; `.asia` is one of the cheap TLDs
 * signup farms rotate through.
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

/**
 * Reads blacklisted domains from Redis, falling back to the BLACKLIST_DOMAINS env var.
 * Cached in-process for 60 seconds to avoid hitting Redis on every auth check.
 */
export const getBlacklistedDomains = createCachedFetch(
  async (): Promise<string[]> =>
    blacklistedDomainsFromConfig(
      await redisClient.get<string>(BLACKLIST_DOMAINS_REDIS_KEY),
      getEnvFallbackDomains()
    ),
  60_000,
  getEnvFallbackDomains()
);

/**
 * Reads the admin-configured signup TLD blocklist from the same Redis entry.
 * An absent field keeps the deployment default (or BLOCKED_SIGNUP_TLDS); an
 * explicit empty array disables TLD blocking. Cached like the domain list.
 */
export const getBlockedSignupTlds = createCachedFetch(
  async (): Promise<string[]> =>
    normalizeSignupTlds(
      blockedSignupTldsFromConfig(
        await redisClient.get<string>(BLACKLIST_DOMAINS_REDIS_KEY),
        getEnvFallbackSignupTlds()
      )
    ),
  60_000,
  getEnvFallbackSignupTlds()
);
