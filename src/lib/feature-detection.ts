/**
 * Feature attribution for microdollar usage.
 *
 * Every caller sends `X-KILOCODE-FEATURE` with a value from FEATURE_VALUES.
 * The gateway validates the header and stores it in `microdollar_usage.feature`.
 * No header = NULL (unattributed).
 *
 * To add a new feature: add it to FEATURE_VALUES, then have the caller send the header.
 */

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
  'webhook',
  'kilo-claw',
  'direct-gateway',
] as const;

export type FeatureValue = (typeof FEATURE_VALUES)[number];

const featureSet = new Set<string>(FEATURE_VALUES);

function isFeatureValue(value: string): value is FeatureValue {
  return featureSet.has(value);
}

export const FEATURE_HEADER = 'x-kilocode-feature';

export function validateFeatureHeader(headerValue: string | null): FeatureValue | null {
  if (!headerValue) return null;
  const normalized = headerValue.trim().toLowerCase();
  return isFeatureValue(normalized) ? normalized : null;
}
