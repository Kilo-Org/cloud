import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { redisGet, redisSet } from '@/lib/redis';
import {
  BLACKLIST_DOMAINS_REDIS_KEY,
  BlacklistDomainsConfigSchema,
  BlacklistDomainsInputSchema,
  DEFAULT_BLACKLIST_DOMAINS_CONFIG,
} from '@/lib/blacklist-domains-config';
import type { BlacklistDomainsConfig } from '@/lib/blacklist-domains-config';
import { TRPCError } from '@trpc/server';

async function readConfig(): Promise<BlacklistDomainsConfig> {
  try {
    const raw = await redisGet(BLACKLIST_DOMAINS_REDIS_KEY);
    if (!raw) return DEFAULT_BLACKLIST_DOMAINS_CONFIG;
    return BlacklistDomainsConfigSchema.parse(JSON.parse(raw));
  } catch {
    return DEFAULT_BLACKLIST_DOMAINS_CONFIG;
  }
}

export const adminBlacklistDomainsRouter = createTRPCRouter({
  get: adminProcedure.query(async () => {
    return readConfig();
  }),

  set: adminProcedure.input(BlacklistDomainsInputSchema).mutation(async ({ input, ctx }) => {
    // Deduplicate and normalize domains
    const normalizedDomains = [
      ...new Set(input.domains.map(d => d.toLowerCase().trim()).filter(Boolean)),
    ];

    const config: BlacklistDomainsConfig = {
      domains: normalizedDomains,
      updated_at: new Date().toISOString(),
      updated_by: ctx.user.id,
      updated_by_email: ctx.user.google_user_email,
    };
    const written = await redisSet(BLACKLIST_DOMAINS_REDIS_KEY, JSON.stringify(config));
    if (!written) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Redis is not configured — cannot save blacklisted domains',
      });
    }
    return config;
  }),
});
