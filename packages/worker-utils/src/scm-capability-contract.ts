export type CapabilityPurpose = 'github' | 'gitlab' | 'bitbucket';

export const CURRENT_CAPABILITY_PREFIX = {
  github: 'kgh2.',
  gitlab: 'kgl2.',
  bitbucket: 'kbb1.',
} as const satisfies Record<CapabilityPurpose, string>;

/** Issued instead of the current GitHub prefix when the grant carries a GitHub task policy. */
export const GITHUB_TASK_CAPABILITY_PREFIX = 'kgh3.';
export const GITHUB_WORKSPACE_CAPABILITY_PREFIX = 'kgh4.';

export const LEGACY_CAPABILITY_PREFIX = {
  github: 'kgh1.',
  gitlab: 'kgl1.',
  /** No longer issued; only persisted cleanup-only grants can still carry it. */
  kilo: 'kka1.',
} as const;

export const ACCEPTED_CAPABILITY_PREFIXES = {
  github: [
    LEGACY_CAPABILITY_PREFIX.github,
    CURRENT_CAPABILITY_PREFIX.github,
    GITHUB_TASK_CAPABILITY_PREFIX,
    GITHUB_WORKSPACE_CAPABILITY_PREFIX,
  ],
  gitlab: [LEGACY_CAPABILITY_PREFIX.gitlab, CURRENT_CAPABILITY_PREFIX.gitlab],
  bitbucket: [CURRENT_CAPABILITY_PREFIX.bitbucket],
} as const satisfies Record<CapabilityPurpose, readonly string[]>;

/** Matches any versioned capability family, including versions this build does not accept. */
export const CAPABILITY_FAMILY_PATTERN_SOURCE = '(?:kka|kgh|kgl|kbb)\\d+\\.';

export function hasCurrentCapabilityPrefix(value: string): boolean {
  return (
    value.startsWith(GITHUB_WORKSPACE_CAPABILITY_PREFIX) ||
    value.startsWith(GITHUB_TASK_CAPABILITY_PREFIX) ||
    Object.values(CURRENT_CAPABILITY_PREFIX).some(prefix => value.startsWith(prefix))
  );
}

/** True when a capability has the prefix that this build issues for the provider. */
export function hasCurrentProviderCapabilityPrefix(
  purpose: CapabilityPurpose,
  value: string
): boolean {
  return (
    value.startsWith(CURRENT_CAPABILITY_PREFIX[purpose]) ||
    (purpose === 'github' &&
      (value.startsWith(GITHUB_TASK_CAPABILITY_PREFIX) ||
        value.startsWith(GITHUB_WORKSPACE_CAPABILITY_PREFIX)))
  );
}

export const GITHUB_CAPABILITY_HOSTS = [
  'api.github.com',
  'github.com',
  'uploads.github.com',
  'npm.pkg.github.com',
] as const;

export const BITBUCKET_GIT_ORIGIN = 'https://bitbucket.org';
export const BITBUCKET_API_ORIGIN = 'https://api.bitbucket.org';
