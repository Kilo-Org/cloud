import * as z from 'zod';
import { redisGet } from '@/lib/redis';
import { getEnvVariable } from '@/lib/dotenvx';

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

/**
 * Reads blacklisted domains from Redis, falling back to the BLACKLIST_DOMAINS env var.
 * Returns a plain string array of domains.
 */
export async function getBlacklistedDomains(): Promise<string[]> {
  try {
    const raw = await redisGet(BLACKLIST_DOMAINS_REDIS_KEY);
    if (raw) {
      const parsed = BlacklistDomainsConfigSchema.parse(JSON.parse(raw));
      if (parsed.domains.length > 0) {
        return parsed.domains;
      }
    }
  } catch {
    // Fall through to env var
  }

  // Fallback to env var
  const envVal = getEnvVariable('BLACKLIST_DOMAINS');
  return envVal
    ? envVal
        .split('|')
        .map((d: string) => d.trim())
        .filter(Boolean)
    : [];
}
