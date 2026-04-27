import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

const WASTELAND_ACCESS_FLAG = 'wasteland-access';

/**
 * Check whether the current user has Wasteland access.
 *
 * In non-production environments the flag is always enabled so local
 * development works without PostHog configuration. In production,
 * access is controlled by the `wasteland-access` PostHog feature flag.
 *
 * Kilo admins always have access regardless of the feature flag.
 */
export async function isWastelandEnabled(
  userId: string,
  opts?: { isAdmin?: boolean }
): Promise<boolean> {
  if (opts?.isAdmin) return true;
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }
  return isFeatureFlagEnabled(WASTELAND_ACCESS_FLAG, userId);
}
