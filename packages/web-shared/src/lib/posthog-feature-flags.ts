import 'server-only';

import PostHogClient from '@kilocode/web-shared/lib/posthog';

import { captureException, startSpan } from '@sentry/nextjs';

const posthogClient = PostHogClient();

type FlagRead = {
  flagName: string;
  distinctId: string;
  /** Span operation recorded around the PostHog read. */
  op: string;
  /** Sentry `source` tag applied to the reported failure. */
  source: string;
  /** Exact `console.error` text kept byte-identical per caller. */
  logMessage: string;
  /** Sentry `extra` payload for the reported failure. */
  extra: Record<string, unknown>;
  personProperties?: Record<string, string>;
};

/**
 * Shared PostHog read-and-report wrapper. Runs the span-wrapped flag read and,
 * on error, logs and reports with the caller's tag and extra payload, then
 * returns `undefined` so each caller applies its own failure default.
 */
async function readFlag({
  flagName,
  distinctId,
  op,
  source,
  logMessage,
  extra,
  personProperties,
}: FlagRead): Promise<string | boolean | undefined> {
  try {
    return await startSpan({ name: flagName, op }, async () => {
      return await posthogClient.getFeatureFlag(flagName, distinctId, { personProperties });
    });
  } catch (error) {
    console.error(logMessage, flagName, error);
    captureException(error, {
      tags: { source },
      extra,
    });
    return undefined;
  }
}

/**
 * Server helper to check if a PostHog feature flag is enabled (boolean flags).
 * Call it from server components, route handlers, or other server modules.
 * @param flagName - The name of the PostHog feature flag to check
 * @param distinctId - Optional distinct ID for the feature flag request (defaults to 'server-config-fetch')
 * @returns Boolean indicating if the flag is enabled, or false if not found/error
 */
export async function isFeatureFlagEnabled(
  flagName: string,
  distinctId: string = 'server-config-fetch'
): Promise<boolean> {
  return Boolean(
    await readFlag({
      flagName,
      distinctId,
      op: 'posthog-feature-flag',
      source: 'posthog_feature_flag_enabled',
      logMessage: "Error checking feature flag '%s':",
      extra: { flagName, distinctId },
    })
  );
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
  distinctId: string = 'server-config-fetch',
  personProperties?: Record<string, string>
): Promise<boolean> {
  return (
    (await readFlag({
      flagName,
      distinctId,
      op: 'posthog-feature-flag-boolean',
      source: 'posthog_feature_flag_boolean_enabled',
      logMessage: 'Error checking boolean feature flag:',
      extra: { flagName },
      personProperties,
    })) === true
  );
}
