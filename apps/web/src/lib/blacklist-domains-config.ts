import 'server-only';
import * as z from 'zod';
import { redisGet } from '@/lib/redis';
import { getEnvVariable } from '@/lib/dotenvx';
import { createCachedFetch } from '@/lib/cached-fetch';

export const BLACKLIST_DOMAINS_REDIS_KEY = 'admin:blacklisted-domains';

export const BlacklistDomainsConfigSchema = z.object({
  domains: z.array(z.string()),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
});

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
 * Cached in-process for 10 seconds (stale-while-revalidate) to avoid hitting Redis on
 * every auth check.
 */
export const getBlacklistedDomains = createCachedFetch(
  async (): Promise<string[]> => {
    const raw = await redisGet(BLACKLIST_DOMAINS_REDIS_KEY);
    if (raw) {
      const parsed = BlacklistDomainsConfigSchema.parse(JSON.parse(raw));
      if (parsed.domains.length > 0) {
        return parsed.domains;
      }
    }
    return getEnvFallbackDomains();
  },
  10_000,
  getEnvFallbackDomains()
);
