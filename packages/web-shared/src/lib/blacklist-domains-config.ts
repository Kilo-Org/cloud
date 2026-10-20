import 'server-only';
import * as z from 'zod';
import { captureException } from '@sentry/nextjs';
import {
  blacklistedDomainsFromConfig,
  type BlacklistDomainsConfigSchema,
} from '@kilocode/worker-utils/account-access';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { BLACKLIST_DOMAINS_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';

export type BlacklistDomainsConfig = z.infer<typeof BlacklistDomainsConfigSchema>;

export const DEFAULT_BLACKLIST_DOMAINS_CONFIG: BlacklistDomainsConfig = {
  domains: [],
  updated_at: null,
  updated_by: null,
  updated_by_email: null,
};

export const BlacklistDomainsInputSchema = z.object({
  domains: z.array(z.string().min(1).trim()),
});

function getEnvFallbackDomains(): string[] {
  const envVal = getEnvVariable('BLACKLIST_DOMAINS');
  return envVal
    ? envVal
        .split('|')
        .map((d: string) => d.trim())
        .filter(Boolean)
    : [];
}

/**
 * Reads the operator-maintained list from Redis. Throws when the read or the stored payload
 * is unusable, after reporting it: createCachedFetch then keeps serving the last list it read
 * successfully, and retries once the failure backoff window passes.
 */
async function readBlacklistedDomains(): Promise<string[]> {
  try {
    return blacklistedDomainsFromConfig(
      await redisClient.get<string>(BLACKLIST_DOMAINS_REDIS_KEY),
      getEnvFallbackDomains()
    );
  } catch (error) {
    errorExceptInTest('[blacklist-domains] Failed to read the blacklisted domains:', error);
    captureException(error, { tags: { source: 'blacklist_domains_config' } });
    throw error;
  }
}

/**
 * Reads blacklisted domains from Redis, falling back to the BLACKLIST_DOMAINS env var.
 * Cached in-process for 60 seconds (stale-while-revalidate) to avoid hitting Redis on
 * every auth check.
 */
export const getBlacklistedDomains = createCachedFetch(
  readBlacklistedDomains,
  60_000,
  getEnvFallbackDomains()
);
