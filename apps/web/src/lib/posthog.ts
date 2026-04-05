import { getEnvVariable } from '@/lib/dotenvx';
import { PostHog } from 'posthog-node';

let instance: PostHog | null = null;

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
  // Single shared PostHog client for the process.
  // Disabled outside production to avoid sending real events during tests/dev.
  instance = new PostHog(isProduction ? key : key || 'disabled', {
    host: 'https://us.i.posthog.com',
    flushAt: 1,
    flushInterval: 0,
    disabled: !isProduction,
  });

  // if (!isProduction) {
  //   // eslint-disable-next-line @typescript-eslint/no-explicit-any
  //   (instance as any).capture = function (...args: any[]) {
  //     console.log('POSTHOG CAPTURE', ...args);
  //   };
  // }

  return instance;
}

export async function shutdownPosthog(): Promise<void> {
  if (instance) {
    await instance.shutdown();
    instance = null;
  }
}
