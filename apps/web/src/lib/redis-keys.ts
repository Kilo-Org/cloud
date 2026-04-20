/**
 * Central registry of all Redis keys used in apps/web.
 *
 * Keep every key string here so they are easy to audit and avoid accidental
 * collisions when adding new features.
 */

export const BLACKLIST_DOMAINS_REDIS_KEY = 'admin:blacklisted-domains';

export const VERCEL_ROUTING_REDIS_KEY = 'ai-gateway:vercel-routing-percentage';

export const GATEWAY_METADATA_REDIS_KEYS = {
  allProviders: 'ai-gateway.metadata:all-providers',
  openrouterModels: 'ai-gateway.metadata:openrouter-models',
  vercelModels: 'ai-gateway.metadata:vercel-models',
  openrouterProviders: 'ai-gateway.metadata:openrouter-providers',
} as const;

export const posthogQueryRedisKey = (name: string) => `posthog-query:${name}` as const;

export const requestLogRedisKey = (hash: string) => `ai-gateway.request-log:${hash}` as const;

export const botIdentityRedisKey = (platform: string, teamId: string, userId: string) =>
  `identity:${platform}:${teamId}:${userId}` as const;
