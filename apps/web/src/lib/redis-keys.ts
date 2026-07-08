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
  // Lightweight lists of language model ids, mirrored alongside the full
  // catalogs above so existence checks don't need to load every model's
  // metadata and endpoints.
  openrouterModelIds: redisKey('ai-gateway.metadata:openrouter-model-ids'),
  vercelModelIds: redisKey('ai-gateway.metadata:vercel-model-ids'),
  openrouterProviders: redisKey('ai-gateway.metadata:openrouter-providers'),
} as const;

export const vercelInferenceProvidersRedisKey = (modelId: string) =>
  redisKey(`ai-gateway.metadata:vercel-inference-providers:${modelId}`);

export const directByokModelsRedisKey = (providerId: DirectUserByokInferenceProviderId) =>
  redisKey(`ai-gateway.metadata.direct-byok-models:${providerId}`);

export const posthogQueryRedisKey = (name: string) => redisKey(`posthog-query:${name}`);

/**
 * Per-user list of BYOK provider ids a user has used, written daily by the
 * `sync-byok-provider-notifications` cron and read when notifications are polled.
 * Storing one entry per user keeps the read tiny instead of fetching the whole
 * dataset on every poll.
 */
export const byokProvidersNotificationRedisKey = (userId: string) =>
  redisKey(`notification:byok-providers:${userId}`);

export const LEADERBOARD_MODEL_PROVIDER_USAGE_REDIS_KEY = redisKey(
  'public-api:leaderboard-model-provider-usage'
);
export const LEADERBOARD_MODEL_USAGE_REDIS_KEY = redisKey('public-api:leaderboard-model-usage');

export const requestLogRedisKey = (hash: string) => redisKey(`ai-gateway.request-log:${hash}`);

export const abuseRulesClassificationRedisKey = (identityKey: string) =>
  redisKey(`ai-gateway.abuse-rules:last-classification:${identityKey}`);

export const botIdentityRedisKey = (platform: string, teamId: string, userId: string) =>
  redisKey(`identity:${platform}:${teamId}:${userId}`);

/**
 * Set of public_model_ids that have a routing-relevant model_experiment row
 * (status IN 'active' | 'paused'). Used by `getProvider` as a fast pre-check
 * before fetching the per-public-id experiment payload.
 *
 * Stored as a JSON array string. Recomputed and rewritten on every status
 * transition into or out of (active, paused).
 */
export const EXPERIMENTED_PUBLIC_IDS_REDIS_KEY = redisKey(
  'ai-gateway.model-experiments:experimented-public-ids'
);

export const gitLabOAuthCredentialsRedisKey = (credentialRef: string) =>
  redisKey(`auth-credentials:gitlab:${credentialRef}`);

export const githubUserAuthorizationPkceRedisKey = (verifierRef: string) =>
  redisKey(`auth-pkce:github-user:${verifierRef}`);
