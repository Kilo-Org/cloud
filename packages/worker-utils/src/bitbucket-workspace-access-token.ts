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

export function hasRequiredBitbucketWorkspaceAccessTokenScopes(
  observedScopes: readonly string[]
): boolean {
  const effectiveScopes = new Set(
    observedScopes.map(scope => scope.trim().toLowerCase()).filter(Boolean)
  );

  // Bitbucket documents repository write as implying repository read. Keep the
  // implication out of normalization so stored provider evidence stays exact.
  if (effectiveScopes.has('repository:write')) {
    effectiveScopes.add('repository');
  }

  return BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES.every(scope =>
    effectiveScopes.has(scope)
  );
}
