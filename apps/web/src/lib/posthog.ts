import { getEnvVariable } from '@/lib/dotenvx';
import { PostHog } from 'posthog-node';
import type { FlagDefinitionCacheProvider } from 'posthog-node/experimental';
import { createPostHogFlagCache } from '@/lib/posthog-flag-cache';

let instance: PostHog | null = null;
let flagCache: FlagDefinitionCacheProvider | null = null;

export default function PostHogClient(): Pick<
  PostHog,
  'capture' | 'isFeatureEnabled' | 'getFeatureFlag' | 'debug' | 'getFeatureFlagPayload' | 'alias'
> {
  if (instance) return instance;

  const key = getEnvVariable('NEXT_PUBLIC_POSTHOG_KEY') ?? '';
  const isProduction = process.env.NODE_ENV === 'production';
  if (!isProduction) {
    return {
      capture: () => {},
      isFeatureEnabled: async () => false,
      getFeatureFlag: async () => undefined,
      debug: () => {},
      getFeatureFlagPayload: async () => undefined,
      alias: () => {},
    };
  }

  // Local evaluation requires a personal API key. When present, flag checks are
  // evaluated in-process against cached flag definitions instead of making a
  // network call to PostHog on every request.
  const personalApiKey = process.env.POSTHOG_PERSONAL_API_KEY;

  if (personalApiKey && !flagCache) {
    // Create the Redis-backed cache for sharing flag definitions across processes.
    // Falls back gracefully to per-instance in-memory state when Redis is absent.
    flagCache = createPostHogFlagCache();
  }

  // Single shared PostHog client for the process.
  // Disabled outside production to avoid sending real events during tests/dev.
  instance = new PostHog(key, {
    host: 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
    ...(personalApiKey
      ? {
          personalApiKey,
          enableLocalEvaluation: true,
          flagDefinitionCacheProvider: flagCache ?? undefined,
        }
      : {}),
  });

  return instance;
}

export async function shutdownPosthog(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
    flagCache = null;
  }
}
