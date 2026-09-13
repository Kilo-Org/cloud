/**
 * Central registry of all Redis keys used in apps/web.
 *
 * Keep every key string here so they are easy to audit and avoid accidental
 * collisions when adding new features.
 */

declare const redisKeyBrand: unique symbol;

export type RedisKey = string & {
  readonly [redisKeyBrand]: true;
};

const redisKey = <const Key extends string>(key: Key): Key & RedisKey => key as Key & RedisKey;

export const BLACKLIST_DOMAINS_REDIS_KEY = redisKey('admin:blacklisted-domains');

export const posthogQueryRedisKey = (name: string) => redisKey(`posthog-query:${name}`);

export const codingPlanUsageRedisKey = (input: {
  userId: string;
  subscriptionId: string;
  planId: string;
  providerId: string;
  inventoryId: string;
}) =>
  redisKey(
    `coding-plan-usage:v1:${input.userId}:${input.subscriptionId}:${input.planId}:${input.providerId}:${input.inventoryId}`
  );

export const LEADERBOARD_MODEL_PROVIDER_USAGE_REDIS_KEY = redisKey(
  'public-api:leaderboard-model-provider-usage'
);
export const LEADERBOARD_MODEL_USAGE_REDIS_KEY = redisKey('public-api:leaderboard-model-usage');
export const LEADERBOARD_PROVIDER_RACE_REDIS_KEY = redisKey('public-api:leaderboard-provider-race');

export const abuseRulesClassificationRedisKey = (identityKey: string) =>
  redisKey(`ai-gateway.abuse-rules:last-classification:${identityKey}`);

export const botIdentityRedisKey = (platform: string, teamId: string, userId: string) =>
  redisKey(`identity:${platform}:${teamId}:${userId}`);

export const gitLabOAuthCredentialsRedisKey = (credentialRef: string) =>
  redisKey(`auth-credentials:gitlab:${credentialRef}`);

export const githubUserAuthorizationPkceRedisKey = (verifierRef: string) =>
  redisKey(`auth-pkce:github-user:${verifierRef}`);

export const githubConnectionPkceRedisKey = (verifierRef: string) =>
  redisKey(`auth-pkce:github-connection:${verifierRef}`);
