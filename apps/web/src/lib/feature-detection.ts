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
  'daemon',
  'cloud-agent',
  'cloud-agent-web',
  'code-review',
  'code-review-memory',
  'auto-triage',
  'autofix',
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
