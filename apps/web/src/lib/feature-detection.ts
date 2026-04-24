/**
 * Feature attribution for microdollar usage.
 *
 * Every caller sends `X-KILOCODE-FEATURE` with a value from FEATURE_VALUES.
 * The gateway validates the header and stores it in `microdollar_usage_metadata.feature_id`.
 * No header = NULL (unattributed).
 *
 * To add a new feature: add it to FEATURE_VALUES, then have the caller send the header.
 */

import { z } from 'zod';

export const FEATURE_VALUES = [
  'vscode-extension',
  'jetbrains-extension',
  'autocomplete',
  'parallel-agent',
  'managed-indexing',
  'cli',
  'cloud-agent',
  'code-review',
  'auto-triage',
  'autofix',
  'app-builder',
  'agent-manager',
  'security-agent',
  'slack',
  'discord',
  'bot',
  'webhook',
  'kiloclaw',
  'openclaw',
  'direct-gateway',
  'embeddings',
  'kiloclaw-embedding',
  'openclaw-embedding',
  'gastown',
] as const;

const featureSchema = z.enum(FEATURE_VALUES);

export type FeatureValue = z.infer<typeof featureSchema>;

export const FEATURE_HEADER = 'x-kilocode-feature';

export function validateFeatureHeader(headerValue: string | null): FeatureValue | null {
  if (!headerValue) return null;
  const result = featureSchema.safeParse(headerValue.trim().toLowerCase());
  return result.success ? result.data : null;
}

/**
 * Server-side products that rate-limit free models per user instead of per IP.
 * These products share infrastructure IPs, so IP-based limits would be too restrictive.
 */
const USER_RATE_LIMITED_FEATURES: ReadonlySet<FeatureValue> = new Set([
  'cloud-agent',
  'code-review',
  'app-builder',
]);

export function isUserRateLimitedFeature(feature: FeatureValue | null): boolean {
  if (!feature) return false;
  return USER_RATE_LIMITED_FEATURES.has(feature);
}
