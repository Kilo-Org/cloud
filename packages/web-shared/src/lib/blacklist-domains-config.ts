import 'server-only';
import * as z from 'zod';
import {
  blacklistedDomainsFromConfig,
  type BlacklistDomainsConfigSchema,
} from '@kilocode/worker-utils/account-access';
import { redisClient } from '@kilocode/web-shared/lib/redis';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { BLACKLIST_DOMAINS_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';

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
