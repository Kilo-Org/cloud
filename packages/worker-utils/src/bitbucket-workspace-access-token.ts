import { z } from 'zod';

export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME =
  'bitbucket-workspace-access-token-rsa-aes-256-gcm';
export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_VERSION = 1;
export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM = 'bitbucket';
export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE = 'workspace_access_token';
export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE =
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE;
export const BITBUCKET_ACCESS_TOKEN_FAMILY_PREFIX = 'ATCT';
export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_INVALIDATION_REASONS = [
  'expired',
  'provider_rejected',
  'workspace_mismatch',
  'encryption_unreadable',
] as const;
export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES = [
  'account',
  'repository',
  'repository:write',
  'pullrequest',
  'webhook',
] as const;
export type BitbucketWorkspaceAccessTokenInvalidationReason =
  (typeof BITBUCKET_WORKSPACE_ACCESS_TOKEN_INVALIDATION_REASONS)[number];
export type BitbucketWorkspaceAccessTokenRequiredScope =
  (typeof BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES)[number];
export const BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_SCOPE_LABELS = {
  account: 'Account Read',
  repository: 'Repository Read',
  'repository:write': 'Repository Write',
  pullrequest: 'Pull request Read',
  webhook: 'Webhooks Read and Write',
} satisfies Record<BitbucketWorkspaceAccessTokenRequiredScope, string>;

const BitbucketIsoTimestampSchema = z.iso.datetime({ offset: true });
const BitbucketPostgresTimestampPattern =
  /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::?\d{2})?)$/;

const BitbucketCredentialTimestampSchema = z.string().refine(value => {
  if (BitbucketIsoTimestampSchema.safeParse(value).success) return true;

  const match = BitbucketPostgresTimestampPattern.exec(value);
  if (!match) return false;
  const [, date, time, postgresOffset] = match;
  const offset =
    postgresOffset.length === 3
      ? `${postgresOffset}:00`
      : postgresOffset.length === 5
        ? `${postgresOffset.slice(0, 3)}:${postgresOffset.slice(3)}`
        : postgresOffset;
  return BitbucketIsoTimestampSchema.safeParse(`${date}T${time}${offset}`).success;
}, 'Invalid credential timestamp');

export const BitbucketOAuthCredentialRowSchema = z
  .object({
    id: z.string().min(1),
    platform_integration_id: z.string().min(1),
    platform: z.string().nullable().optional(),
    authorized_by_user_id: z.string().min(1),
    provider_subject_id: z.string().min(1),
    provider_subject_login: z.string().min(1),
    provider_base_url: z.null(),
    access_token_encrypted: z.string().min(1),
    access_token_expires_at: BitbucketCredentialTimestampSchema.nullable(),
    refresh_token_encrypted: z.string().min(1),
    refresh_token_expires_at: BitbucketCredentialTimestampSchema.nullable(),
    oauth_client_secret_encrypted: z.null(),
    credential_version: z.number().int().positive(),
    revoked_at: BitbucketCredentialTimestampSchema.nullable(),
    revocation_reason: z.string().nullable(),
    last_used_at: BitbucketCredentialTimestampSchema.nullable(),
    created_at: BitbucketCredentialTimestampSchema,
    updated_at: BitbucketCredentialTimestampSchema,
  })
  .strict();

export type BitbucketOAuthCredentialRow = z.infer<typeof BitbucketOAuthCredentialRowSchema>;

export const BitbucketWorkspaceAccessTokenCredentialRowSchema = z
  .object({
    id: z.string().min(1),
    platform_integration_id: z.string().min(1),
    owned_by_organization_id: z.string().nullable().optional(),
    platform: z.string().nullable().optional(),
    integration_type: z.string().nullable().optional(),
    token_encrypted: z.string().min(1),
    expires_at: BitbucketCredentialTimestampSchema.nullable(),
    provider_credential_type: z.literal(BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE),
    provider_resource_id: z.null(),
    provider_base_url: z.null(),
    authorized_by_user_id: z.null(),
    provider_metadata: z.null(),
    provider_scopes: z.array(z.string().min(1)),
    provider_verified_at: BitbucketCredentialTimestampSchema,
    credential_version: z.number().int().positive(),
    last_validated_at: BitbucketCredentialTimestampSchema,
    last_used_at: BitbucketCredentialTimestampSchema.nullable(),
    created_at: BitbucketCredentialTimestampSchema,
    updated_at: BitbucketCredentialTimestampSchema,
  })
  .strict();

export type BitbucketWorkspaceAccessTokenCredentialRow = z.infer<
  typeof BitbucketWorkspaceAccessTokenCredentialRowSchema
>;

export function buildBitbucketOrganizationCredentialLockKey(organizationId: string): string {
  return `bitbucket-oauth-owner:org:${organizationId}`;
}

export type BitbucketWorkspaceAccessTokenAadInput = {
  credentialId: string;
  integrationId: string;
  organizationId: string;
  credentialVersion: number;
};

export function buildBitbucketWorkspaceAccessTokenAad(
  input: BitbucketWorkspaceAccessTokenAadInput
): string {
  return JSON.stringify({
    scheme: BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
    version: BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_VERSION,
    platform: BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
    credentialId: input.credentialId,
    integrationId: input.integrationId,
    owner: { type: 'org', id: input.organizationId },
    integrationType: BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
    credentialVersion: input.credentialVersion,
  });
}

export function hasBitbucketAccessTokenFamilyPrefix(token: string): boolean {
  return token.startsWith(BITBUCKET_ACCESS_TOKEN_FAMILY_PREFIX);
}

export function isValidBitbucketRepositoryPaginationUrl(
  value: string,
  workspaceSlug: string
): boolean {
  const expectedPath = `/2.0/repositories/${encodeURIComponent(workspaceSlug)}`;
  const rawUrl = /^https:\/\/api\.bitbucket\.org([^?#]*)(\?[^#]*)?$/.exec(value);
  if (!rawUrl || rawUrl[1] !== expectedPath) return false;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x21 || code > 0x7e) return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
    decodeURIComponent(`${parsed.pathname}${parsed.search}`);
  } catch {
    return false;
  }

  const queryParameterNames = [...parsed.searchParams.keys()];
  const hasRole = queryParameterNames.some(name => name.toLowerCase() === 'role');
  const hasCaseVariantPageLength = queryParameterNames.some(
    name => name !== 'pagelen' && name.toLowerCase() === 'pagelen'
  );
  const pageLengths = parsed.searchParams.getAll('pagelen');
  return (
    parsed.protocol === 'https:' &&
    parsed.origin === 'https://api.bitbucket.org' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    parsed.pathname === expectedPath &&
    parsed.href === value &&
    !hasRole &&
    !hasCaseVariantPageLength &&
    pageLengths.length <= 1 &&
    (pageLengths.length === 0 ||
      (/^[1-9][0-9]*$/.test(pageLengths[0]) && Number(pageLengths[0]) <= 50))
  );
}

export function normalizeBitbucketWorkspaceAccessTokenScopes(scopeHeader: string): string[] {
  return [
    ...new Set(
      scopeHeader
        .split(/[\s,]+/)
        .map(scope => scope.trim().toLowerCase())
        .filter(Boolean)
    ),
  ].sort();
}

export function getUnexpectedBitbucketWorkspaceAccessTokenScopes(
  observedScopes: readonly string[]
): string[] {
  const expectedScopes = new Set<string>(
    BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES
  );
  expectedScopes.add('pullrequest:write');
  return normalizeBitbucketWorkspaceAccessTokenScopes(observedScopes.join(' ')).filter(
    scope => !expectedScopes.has(scope)
  );
}

function buildBitbucketWorkspaceAccessTokenEffectiveScopeSet(
  observedScopes: readonly string[]
): Set<string> {
  const effectiveScopes = new Set(
    observedScopes.map(scope => scope.trim().toLowerCase()).filter(Boolean)
  );

  // Keep documented Bitbucket implications out of normalization so stored
  // provider evidence stays exact.
  if (effectiveScopes.has('pullrequest:write')) {
    effectiveScopes.add('pullrequest');
    effectiveScopes.add('repository:write');
  }
  if (effectiveScopes.has('repository:write')) {
    effectiveScopes.add('repository');
  }
  if (effectiveScopes.has('project')) {
    effectiveScopes.add('repository');
  }

  return effectiveScopes;
}

export function getMissingBitbucketWorkspaceAccessTokenScopes(
  observedScopes: readonly string[]
): BitbucketWorkspaceAccessTokenRequiredScope[] {
  const effectiveScopes = buildBitbucketWorkspaceAccessTokenEffectiveScopeSet(observedScopes);
  return BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES.filter(
    scope => !effectiveScopes.has(scope)
  );
}

export function hasRequiredBitbucketWorkspaceAccessTokenScopes(
  observedScopes: readonly string[]
): boolean {
  return getMissingBitbucketWorkspaceAccessTokenScopes(observedScopes).length === 0;
}
