export type CapabilityPurpose = 'github' | 'gitlab' | 'bitbucket';

export const CURRENT_CAPABILITY_PREFIX = {
  github: 'kgh2.',
  gitlab: 'kgl2.',
  bitbucket: 'kbb1.',
} as const satisfies Record<CapabilityPurpose, string>;

export const LEGACY_CAPABILITY_PREFIX = {
  github: 'kgh1.',
  gitlab: 'kgl1.',
  /** No longer issued; only persisted cleanup-only grants can still carry it. */
  kilo: 'kka1.',
} as const;

export const ACCEPTED_CAPABILITY_PREFIXES = {
  github: [LEGACY_CAPABILITY_PREFIX.github, CURRENT_CAPABILITY_PREFIX.github],
  gitlab: [LEGACY_CAPABILITY_PREFIX.gitlab, CURRENT_CAPABILITY_PREFIX.gitlab],
  bitbucket: [CURRENT_CAPABILITY_PREFIX.bitbucket],
} as const satisfies Record<CapabilityPurpose, readonly string[]>;

/** Matches any versioned capability family, including versions this build does not accept. */
export const CAPABILITY_FAMILY_PATTERN_SOURCE = '(?:kka|kgh|kgl|kbb)\\d+\\.';

export function hasCurrentCapabilityPrefix(value: string): boolean {
  return Object.values(CURRENT_CAPABILITY_PREFIX).some(prefix => value.startsWith(prefix));
}

export const GITHUB_CAPABILITY_HOSTS = [
  'api.github.com',
  'github.com',
  'uploads.github.com',
  'npm.pkg.github.com',
] as const;

export const BITBUCKET_GIT_ORIGIN = 'https://bitbucket.org';
export const BITBUCKET_API_ORIGIN = 'https://api.bitbucket.org';
