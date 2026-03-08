import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';

const GASTOWN_ACCESS_FLAG = 'gastown-access';

/**
 * Check whether the current user has Gastown access.
 *
 * In non-production environments the flag is always enabled so local
 * development works without PostHog configuration. In production,
 * access is controlled by the `gastown-access` PostHog feature flag
 * (allowlists, percentage rollout, and kill-switch are managed in the
 * PostHog dashboard).
 *
 * See #901 for details.
 */
export async function isGastownEnabled(userId: string): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }
  return isFeatureFlagEnabled(GASTOWN_ACCESS_FLAG, userId);
}
