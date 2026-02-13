'use server';

import PostHogClient from '@/lib/posthog';

import type * as z from 'zod';
import { captureException, startSpan } from '@sentry/nextjs';

const posthogClient = PostHogClient();

/**
 * Generic server action to fetch any PostHog feature flag value
 * @param flagName - The name of the PostHog feature flag to fetch
 * @param distinctId - Optional distinct ID for the feature flag request (defaults to 'server-config-fetch')
 * @returns The feature flag payload value or null if not found/error
 */
export async function getFeatureFlagPayload<T>(
  schema: z.ZodType<T>,
  flagName: string
): Promise<T | undefined> {
  return await startSpan({ name: flagName, op: 'posthog-feature-flag-payload' }, async () => {
    // Get feature flag payload from PostHog
    const flagPayload = await posthogClient
      .getFeatureFlagPayload(flagName, 'server-config-fetch')
      .catch(error => {
        console.error(`Error fetching feature flag '${flagName}':`, error);
        captureException(error, {
          tags: { source: 'posthog_feature_flag_payload' },
          extra: { flagName },
        });
        return undefined;
      });

    if (!flagPayload) {
      return undefined;
    }

    try {
      const parsedPayload = typeof flagPayload === 'string' ? JSON.parse(flagPayload) : flagPayload;
      return schema.safeParse(parsedPayload).data;
    } catch (parseError) {
      console.error(`Failed to parse feature flag payload for '${flagName}':`, parseError);
      captureException(parseError, {
        tags: { source: 'posthog_feature_flag_parse' },
        extra: { flagName, flagPayload },
      });
      return undefined;
    }
  });
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
    // For boolean flags, we can use getFeatureFlag instead of getFeatureFlagPayload
    const isEnabled = await startSpan({ name: flagName, op: 'posthog-feature-flag' }, async () => {
      return await posthogClient.getFeatureFlag(flagName, distinctId);
    });
    return Boolean(isEnabled);
  } catch (error) {
    console.error(`Error checking feature flag '${flagName}':`, error);
    captureException(error, {
      tags: { source: 'posthog_feature_flag_enabled' },
      extra: { flagName, distinctId },
    });
    return false;
  }
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
    console.error(`Error checking boolean feature flag '${flagName}':`, error);
    captureException(error, {
      tags: { source: 'posthog_feature_flag_boolean_enabled' },
      extra: { flagName, distinctId },
    });
    return false;
  }
}
