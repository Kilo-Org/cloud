'use server';

import PostHogClient from '@/lib/posthog';
import { z } from 'zod';

import { captureException, startSpan } from '@sentry/nextjs';

const posthogClient = PostHogClient();

const IsolateReviewOrganizationsSchema = z
  .object({ organizationIds: z.array(z.uuid()).max(10_000) })
  .strict();

export async function isOrganizationAllowlistedForIsolateReviews(
  organizationId: string
): Promise<boolean> {
  if (!z.uuid().safeParse(organizationId).success) return false;

  const flagName = 'code-review-isolate-organizations';
  try {
    return await startSpan({ name: flagName, op: 'posthog-feature-flag-boolean' }, async () => {
      if ((await posthogClient.getFeatureFlag(flagName, organizationId)) !== true) return false;
      const payload = IsolateReviewOrganizationsSchema.safeParse(
        await posthogClient.getFeatureFlagPayload(flagName, organizationId, true)
      );
      return payload.success && payload.data.organizationIds.includes(organizationId);
    });
  } catch {
    captureException(new Error('Isolate review rollout lookup failed'), {
      tags: { source: 'posthog_feature_flag_boolean_enabled' },
      extra: { flagName },
    });
    return false;
  }
}

/**
 * Generic server action to check if a PostHog feature flag is enabled (boolean flags)
 * @param flagName - The name of the PostHog feature flag to check
 * @param distinctId - Optional distinct ID for the feature flag request (defaults to 'server-config-fetch')
 * @returns Boolean indicating if the flag is enabled, or false if not found/error
 */
export async function isFeatureFlagEnabled(
  flagName: string,
  distinctId: string = 'server-config-fetch'
): Promise<boolean> {
  try {
    const isEnabled = await startSpan({ name: flagName, op: 'posthog-feature-flag' }, async () => {
      return await posthogClient.getFeatureFlag(flagName, distinctId);
    });
    return Boolean(isEnabled);
  } catch (error) {
    console.error("Error checking feature flag '%s':", flagName, error);
    captureException(error, {
      tags: { source: 'posthog_feature_flag_enabled' },
      extra: { flagName, distinctId },
    });
    return false;
  }
}

export async function isFeatureFlagEnabledOrDevelopment(
  flagName: string,
  distinctId: string = 'server-config-fetch'
): Promise<boolean> {
  return (
    process.env.NODE_ENV === 'development' || (await isFeatureFlagEnabled(flagName, distinctId))
  );
}

/**
 * Strict boolean-only release toggle check.
 * Intended for authorization decisions where multivariate feature flag variants must not grant access.
 * @param flagName - The name of the PostHog feature flag to check
 * @param distinctId - Optional distinct ID for the feature flag request (defaults to 'server-config-fetch')
 * @returns true only when PostHog returns the boolean value true; false for all other values/errors
 */
export async function isReleaseToggleEnabled(
  flagName: string,
  distinctId: string = 'server-config-fetch'
): Promise<boolean> {
  try {
    const flagValue = await startSpan(
      { name: flagName, op: 'posthog-feature-flag-boolean' },
      async () => {
        return await posthogClient.getFeatureFlag(flagName, distinctId);
      }
    );
    return flagValue === true;
  } catch (error) {
    console.error('Error checking boolean feature flag:', flagName, error);
    captureException(error, {
      tags: { source: 'posthog_feature_flag_boolean_enabled' },
      extra: { flagName, distinctId },
    });
    return false;
  }
}
