import 'server-only';
import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import {
  blacklistedDomainsFromConfig,
  blockedSignupTldsFromConfig,
  refreshBlacklistDomainsConfig,
  type BlacklistDomainsConfig,
  type BlacklistDomainsConfigSnapshot,
} from '@kilocode/worker-utils/account-access';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export type { BlacklistDomainsConfig };

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

// Resolved once so an unchanged fallback keeps the domain index built for its array.
const envFallbackDomains = getEnvFallbackDomains();
const envFallbackSignupTlds = getEnvFallbackSignupTlds();

let snapshot: BlacklistDomainsConfigSnapshot | null = null;

/**
 * Reads the operator-maintained config from Redis. Throws when the read or the stored payload
 * is unusable, after reporting it: createCachedFetch then keeps serving the last config it read
 * successfully, and retries once the failure backoff window passes.
 */
async function readConfigSnapshot(): Promise<BlacklistDomainsConfigSnapshot> {
  try {
    snapshot = await refreshBlacklistDomainsConfig(
      key => redisClient.get<string>(key),
      snapshot,
      Date.now()
    );
    return snapshot;
  } catch (error) {
    errorExceptInTest('[blacklist-domains] Failed to read the blacklisted domains:', error);
    captureException(error, { tags: { source: 'blacklist_domains_config' } });
    throw error;
  }
}

// Cached in-process for 60 seconds to avoid hitting Redis on every auth check. Both lists
// below come from this one cached read.
const getConfigSnapshot = createCachedFetch<BlacklistDomainsConfigSnapshot | null>(
  readConfigSnapshot,
  60_000,
  null
);

/** Blacklisted domains from Redis, falling back to the BLACKLIST_DOMAINS env var. */
export async function getBlacklistedDomains(): Promise<string[]> {
  const current = await getConfigSnapshot();
  return blacklistedDomainsFromConfig(current?.config ?? null, envFallbackDomains);
}

/**
 * The admin-configured signup TLD blocklist from the same Redis entry. An absent field keeps
 * the deployment default (or BLOCKED_SIGNUP_TLDS); an explicit empty array disables TLD
 * blocking.
 */
export async function getBlockedSignupTlds(): Promise<string[]> {
  const current = await getConfigSnapshot();
  return normalizeSignupTlds(
    blockedSignupTldsFromConfig(current?.config ?? null, envFallbackSignupTlds)
  );
}
