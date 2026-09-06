import * as Application from 'expo-application';

/**
 * Version-aware feature flags.
 *
 * Every flag a mobile build reads must be registered here with the oldest app
 * version that understands it. The app applies a flag's remote value only when
 * its own version is at or above that minimum, and falls back to the flag's
 * default otherwise — a flag that a build does not understand must never
 * change that build's behaviour, whatever PostHog returns.
 *
 * Workflow: when a flag (or a renamed one) is introduced in version X, register
 * it with `minAppVersion: X`. Older builds that already carry this registry
 * then skip the key they do not understand instead of acting on it.
 */

export const FEATURE_FLAG_PR_REVIEW = 'mobile-pr-review';
export const FEATURE_FLAG_QUICK_CHAT = 'mobile-quick-chat';

export type FeatureFlagDefinition = Readonly<{
  key: string;
  /** Oldest app version that understands this flag. Lower builds fall back to `defaultValue`. */
  minAppVersion: string;
  /** Value used when the build is too old or the remote value is not loaded. Must match every `useFeatureFlag` call site for the key. */
  defaultValue: boolean;
}>;

/**
 * The registry the debug surface lists. Minimums record the first release that
 * shipped each flag's reading code:
 * - `mobile-pr-review` (#4669) first released in 1.0.4.
 * - `mobile-quick-chat` (#5541) first released in 1.0.6.
 */
export const FEATURE_FLAG_DEFINITIONS: readonly FeatureFlagDefinition[] = [
  { key: FEATURE_FLAG_PR_REVIEW, minAppVersion: '1.0.4', defaultValue: true },
  { key: FEATURE_FLAG_QUICK_CHAT, minAppVersion: '1.0.6', defaultValue: false },
];

const DEFINITIONS_BY_KEY: ReadonlyMap<string, FeatureFlagDefinition> = new Map(
  FEATURE_FLAG_DEFINITIONS.map(definition => [definition.key, definition])
);

export function getFeatureFlagDefinition(key: string): FeatureFlagDefinition | undefined {
  return DEFINITIONS_BY_KEY.get(key);
}

/** This build's version, or null when the platform does not report one. */
export function currentAppVersion(): string | null {
  return Application.nativeApplicationVersion ?? null;
}

/**
 * Compare dotted numeric version strings (`1.10.0` > `1.9.9`, missing
 * segments count as zero). Returns <0, 0, or >0 like `strcmp`.
 */
export function compareAppVersions(a: string, b: string): number {
  const left = a.split('.').map(segment => Number.parseInt(segment, 10) || 0);
  const right = b.split('.').map(segment => Number.parseInt(segment, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) {
      return delta < 0 ? -1 : 1;
    }
  }
  return 0;
}

/**
 * True when `current` is at or above `min`. An unknown build version never
 * clears the gate: a build that cannot prove its age does not get to apply a
 * flag it may not understand, so the flag's default holds.
 */
export function isAppVersionAtLeast(current: string | null | undefined, min: string): boolean {
  if (!current) {
    return false;
  }
  return compareAppVersions(current, min) >= 0;
}
