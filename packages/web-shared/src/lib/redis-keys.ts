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

/** Signup TLD blocklist and audit fields; the domains themselves live in Postgres. */
export const BLACKLIST_DOMAINS_SETTINGS_REDIS_KEY = redisKey('admin:blacklisted-domains:settings');
/**
 * The former combined settings and domain list. Read once to migrate its settings, and deleted
 * with its companion key by the next admin save.
 */
export const LEGACY_BLACKLIST_DOMAINS_REDIS_KEY = redisKey('admin:blacklisted-domains');
export const LEGACY_BLACKLIST_DOMAINS_UPDATED_AT_REDIS_KEY = redisKey(
  'admin:blacklisted-domains:updated-at'
);

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

/** `digest` is a hex SHA-256 over the envelope and its KMS context; see `data-key-cache.ts`. */
export const byokDataKeyRedisKey = (digest: string) => redisKey(`byok-data-key:v1:${digest}`);

export const SAFETY_IDENTIFIER_BACKFILL_STATE_KEY = redisKey(
  'safety-identifiers:regeneration:v1:state'
);
export const SAFETY_IDENTIFIER_BACKFILL_LOCK_KEY = redisKey(
  'safety-identifiers:regeneration:v1:lock'
);

export const LEADERBOARD_MODEL_PROVIDER_USAGE_REDIS_KEY = redisKey(
  'public-api:leaderboard-model-provider-usage'
);
export const LEADERBOARD_MODEL_USAGE_REDIS_KEY = redisKey('public-api:leaderboard-model-usage');
export const LEADERBOARD_PROVIDER_RACE_REDIS_KEY = redisKey('public-api:leaderboard-provider-race');

export const nonTrialEnterpriseRedisKey = (organizationId: string) =>
  redisKey(`organization:non-trial-enterprise:${organizationId}`);

export const botIdentityRedisKey = (platform: string, teamId: string, userId: string) =>
  redisKey(`identity:${platform}:${teamId}:${userId}`);

export const discordGatewayMessageRedisKey = (botUserId: string, messageId: string) =>
  redisKey(`discord:gateway-message:${botUserId}:${messageId}`);

export const gitLabOAuthCredentialsRedisKey = (credentialRef: string) =>
  redisKey(`auth-credentials:gitlab:${credentialRef}`);

export const githubUserAuthorizationPkceRedisKey = (verifierRef: string) =>
  redisKey(`auth-pkce:github-user:${verifierRef}`);

export const githubConnectionPkceRedisKey = (verifierRef: string) =>
  redisKey(`auth-pkce:github-connection:${verifierRef}`);

export const watchPrCiInboxRedisKey = (input: {
  installationId: string;
  appType: 'standard' | 'lite';
  repositoryId: string;
}) => redisKey(`watch-pr-ci:v1:${input.installationId}:${input.appType}:${input.repositoryId}`);
