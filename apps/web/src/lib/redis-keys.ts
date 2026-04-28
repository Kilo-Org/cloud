/**
 * Central registry of all Redis keys used in apps/web.
 *
 * Keep every key string here so they are easy to audit and avoid accidental
 * collisions when adding new features.
 */

import type { DirectUserByokInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';

declare const redisKeyBrand: unique symbol;

export type RedisKey = string & {
  readonly [redisKeyBrand]: true;
};

const redisKey = <const Key extends string>(key: Key): Key & RedisKey => key as Key & RedisKey;

export const BLACKLIST_DOMAINS_REDIS_KEY = redisKey('admin:blacklisted-domains');

export const VERCEL_ROUTING_REDIS_KEY = redisKey('ai-gateway:vercel-routing-percentage');

export const GATEWAY_METADATA_REDIS_KEYS = {
  allProviders: redisKey('ai-gateway.metadata:all-providers'),
  openrouterModels: redisKey('ai-gateway.metadata:openrouter-models'),
  vercelModels: redisKey('ai-gateway.metadata:vercel-models'),
  openrouterProviders: redisKey('ai-gateway.metadata:openrouter-providers'),
} as const;

export const directByokModelsRedisKey = (providerId: DirectUserByokInferenceProviderId) =>
  redisKey(`ai-gateway.metadata.direct-byok-models:${providerId}`);

export const posthogQueryRedisKey = (name: string) => redisKey(`posthog-query:${name}`);

export const requestLogRedisKey = (hash: string) => redisKey(`ai-gateway.request-log:${hash}`);

export const botIdentityRedisKey = (platform: string, teamId: string, userId: string) =>
  redisKey(`identity:${platform}:${teamId}:${userId}`);
