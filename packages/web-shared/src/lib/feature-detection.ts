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
  'jetbrains-plugin',
  'autocomplete',
  'parallel-agent',
  'managed-indexing',
  'cli',
  'desktop',
  'daemon',
  'cloud-agent',
  'cloud-agent-web',
  'code-review',
  'code-review-memory',
  'app-builder',
  'agent-manager',
  'security-agent',
  'security-remediation',
  'slack',
  'discord',
  'github',
  'linear',
  'bot',
  'webhook',
  'scheduled',
  'kiloclaw',
  'openclaw',
  'direct-gateway',
  'quick-chat',
  'mobile-chat',
  'embeddings',
  'kiloclaw-embedding',
  'openclaw-embedding',
  'gastown',
  'mobile-voice-input',
  'tool-summary-translation',
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
 * Server-side products that reach the gateway from shared Kilo infrastructure
 * (Cloudflare Workers), so their source IP says nothing about the user.
 */
const SERVER_SIDE_PRODUCT_FEATURES: ReadonlySet<FeatureValue> = new Set([
  'cloud-agent',
  'code-review',
  'app-builder',
  'gastown',
]);

export function isServerSideProductFeature(feature: FeatureValue | null): boolean {
  if (!feature) return false;
  return SERVER_SIDE_PRODUCT_FEATURES.has(feature);
}
