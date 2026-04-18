import { z } from 'zod';

export const GOOGLE_CAPABILITY = {
  CALENDAR_READ: 'calendar_read',
  GMAIL_READ: 'gmail_read',
  DRIVE_READ: 'drive_read',
} as const;

export type GoogleCapability = (typeof GOOGLE_CAPABILITY)[keyof typeof GOOGLE_CAPABILITY];

export const GoogleCapabilitySchema = z.enum([
  GOOGLE_CAPABILITY.CALENDAR_READ,
  GOOGLE_CAPABILITY.GMAIL_READ,
  GOOGLE_CAPABILITY.DRIVE_READ,
]);

const GOOGLE_CAPABILITY_SCOPES: Record<GoogleCapability, readonly string[]> = {
  [GOOGLE_CAPABILITY.CALENDAR_READ]: ['https://www.googleapis.com/auth/calendar.readonly'],
  [GOOGLE_CAPABILITY.GMAIL_READ]: ['https://www.googleapis.com/auth/gmail.readonly'],
  [GOOGLE_CAPABILITY.DRIVE_READ]: [
    'https://www.googleapis.com/auth/drive.readonly',
    'https://www.googleapis.com/auth/documents.readonly',
    'https://www.googleapis.com/auth/spreadsheets.readonly',
  ],
};

export const GOOGLE_IDENTITY_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
] as const;

export const DEFAULT_GOOGLE_CAPABILITIES: readonly GoogleCapability[] = [
  GOOGLE_CAPABILITY.CALENDAR_READ,
];

/**
 * Parses a comma-separated capability list from query params.
 *
 * Empty/null values fall back to the default capability set.
 */
export function parseGoogleCapabilities(
  capabilitiesParam: string | null | undefined,
  fallback: readonly GoogleCapability[] = DEFAULT_GOOGLE_CAPABILITIES
): GoogleCapability[] {
  if (!capabilitiesParam || capabilitiesParam.trim().length === 0) {
    return [...fallback];
  }

  const raw = capabilitiesParam
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  const unique = [...new Set(raw)];
  const parsed = z.array(GoogleCapabilitySchema).safeParse(unique);

  if (!parsed.success) {
    throw new Error('Invalid Google capability selection');
  }

  if (parsed.data.length === 0) {
    return [...fallback];
  }

  return parsed.data;
}

/**
 * Resolves concrete OAuth scopes for a capability set.
 *
 * Identity scopes are always included because callback identity verification
 * and account linkage rely on them.
 */
export function resolveGoogleScopesForCapabilities(
  capabilities: readonly GoogleCapability[]
): string[] {
  const dedupedCapabilities = [...new Set(capabilities)];
  const scopes = new Set<string>(GOOGLE_IDENTITY_SCOPES);

  for (const capability of dedupedCapabilities) {
    for (const scope of GOOGLE_CAPABILITY_SCOPES[capability]) {
      scopes.add(scope);
    }
  }

  return [...scopes].sort();
}

/**
 * Returns true when all scopes required by the capability set are granted.
 */
export function hasRequiredScopesForCapabilities(
  grantedScopes: readonly string[],
  capabilities: readonly GoogleCapability[]
): boolean {
  const granted = new Set(grantedScopes);
  const required = resolveGoogleScopesForCapabilities(capabilities);
  return required.every(scope => granted.has(scope));
}

/**
 * Parses a space-delimited OAuth scope string into a stable sorted array.
 */
export function parseGoogleScopeString(scope: string | null | undefined): string[] {
  if (!scope || scope.trim().length === 0) {
    return [];
  }

  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}
