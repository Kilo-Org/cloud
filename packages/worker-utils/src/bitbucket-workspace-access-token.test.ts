import { describe, expect, it } from 'vitest';
import {
  BITBUCKET_ACCESS_TOKEN_FAMILY_PREFIX,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INVALIDATION_REASONS,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_SCOPE_LABELS,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES,
  BitbucketOAuthCredentialRowSchema,
  BitbucketWorkspaceAccessTokenCredentialRowSchema,
  buildBitbucketOrganizationCredentialLockKey,
  buildBitbucketWorkspaceAccessTokenAad,
  getMissingBitbucketWorkspaceAccessTokenScopes,
  getUnexpectedBitbucketWorkspaceAccessTokenScopes,
  hasBitbucketAccessTokenFamilyPrefix,
  hasRequiredBitbucketWorkspaceAccessTokenScopes,
  isValidBitbucketRepositoryPaginationUrl,
  normalizeBitbucketWorkspaceAccessTokenScopes,
} from './bitbucket-workspace-access-token';

const aadInput = {
  credentialId: 'credential-1',
  integrationId: 'integration-1',
  organizationId: 'organization-1',
  credentialVersion: 3,
};

describe('Bitbucket Workspace Access Token contract', () => {
  it('requires the complete legacy Bitbucket OAuth credential profile', () => {
    const row = {
      id: 'credential-1',
      platform_integration_id: 'integration-1',
      authorized_by_user_id: 'user-1',
      provider_subject_id: 'provider-user-1',
      provider_subject_login: 'octocat',
      provider_base_url: null,
      access_token_encrypted: 'access-envelope',
      access_token_expires_at: '2026-07-13T12:00:00.000Z',
      refresh_token_encrypted: 'refresh-envelope',
      refresh_token_expires_at: '2026-08-13T12:00:00.000Z',
      oauth_client_secret_encrypted: null,
      credential_version: 1,
      revoked_at: null,
      revocation_reason: null,
      last_used_at: null,
      created_at: '2026-07-13T12:00:00.000Z',
      updated_at: '2026-07-13T12:00:00.000Z',
    };

    expect(BitbucketOAuthCredentialRowSchema.parse(row)).toEqual(row);
    expect(
      BitbucketOAuthCredentialRowSchema.safeParse({ ...row, authorized_by_user_id: null }).success
    ).toBe(false);
    expect(
      BitbucketOAuthCredentialRowSchema.safeParse({ ...row, refresh_token_encrypted: null }).success
    ).toBe(false);
  });

  it('requires the complete Bitbucket workspace access-token credential profile', () => {
    const row = {
      id: 'credential-2',
      platform_integration_id: 'integration-2',
      token_encrypted: 'token-envelope',
      expires_at: null,
      provider_credential_type: 'workspace_access_token',
      provider_resource_id: null,
      provider_base_url: null,
      authorized_by_user_id: null,
      provider_metadata: null,
      provider_scopes: ['account', 'repository', 'repository:write', 'pullrequest', 'webhook'],
      provider_verified_at: '2026-07-13T12:00:00.000Z',
      credential_version: 2,
      last_validated_at: '2026-07-13T12:00:00.000Z',
      last_used_at: null,
      created_at: '2026-07-13T12:00:00.000Z',
      updated_at: '2026-07-13T12:00:00.000Z',
    };

    expect(BitbucketWorkspaceAccessTokenCredentialRowSchema.parse(row)).toEqual(row);
    expect(
      BitbucketWorkspaceAccessTokenCredentialRowSchema.safeParse({
        ...row,
        provider_scopes: null,
      }).success
    ).toBe(false);
    expect(
      BitbucketWorkspaceAccessTokenCredentialRowSchema.safeParse({
        ...row,
        last_validated_at: null,
      }).success
    ).toBe(false);
  });

  it('builds the compatible organization credential lock key', () => {
    expect(
      buildBitbucketOrganizationCredentialLockKey('123e4567-e89b-12d3-a456-426614174030')
    ).toBe('bitbucket-oauth-owner:org:123e4567-e89b-12d3-a456-426614174030');
  });

  it('builds deterministic organization-owned AAD without a Kilo user', () => {
    const inputWithUser = {
      ...aadInput,
      userId: 'must-not-be-bound',
      authorizedByUserId: 'must-also-not-be-bound',
    };
    const aad = buildBitbucketWorkspaceAccessTokenAad(inputWithUser);

    expect(aad).toBe(
      JSON.stringify({
        scheme: BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        version: 1,
        platform: 'bitbucket',
        credentialId: 'credential-1',
        integrationId: 'integration-1',
        owner: { type: 'org', id: 'organization-1' },
        integrationType: 'workspace_access_token',
        credentialVersion: 3,
      })
    );
    expect(aad).not.toContain('must-not-be-bound');
    expect(aad).not.toContain('must-also-not-be-bound');
    expect(buildBitbucketWorkspaceAccessTokenAad(aadInput)).toBe(aad);
  });

  it('normalizes observed scopes without materializing implied scopes', () => {
    expect(
      normalizeBitbucketWorkspaceAccessTokenScopes(
        ' Repository:Write, ACCOUNT  repository:write\trepository '
      )
    ).toEqual(['account', 'repository', 'repository:write']);
    expect(normalizeBitbucketWorkspaceAccessTokenScopes('repository:write account')).toEqual([
      'account',
      'repository:write',
    ]);
    expect(
      normalizeBitbucketWorkspaceAccessTokenScopes('repository:write account pullrequest')
    ).toEqual(['account', 'pullrequest', 'repository:write']);
    expect(
      normalizeBitbucketWorkspaceAccessTokenScopes('repository:write account webhook')
    ).toEqual(['account', 'repository:write', 'webhook']);
    expect(BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES).toEqual([
      'account',
      'repository',
      'repository:write',
      'pullrequest',
      'webhook',
    ]);
  });

  it('reports observed scopes that Kilo did not request', () => {
    expect(
      getUnexpectedBitbucketWorkspaceAccessTokenScopes([
        'account',
        'project',
        'repository',
        'repository:write',
        'pullrequest',
        'pullrequest:write',
        'webhook',
        'repository:admin',
        'pipeline:write',
      ])
    ).toEqual(['pipeline:write', 'project', 'repository:admin']);
  });

  it('requires effective scopes without rejecting additional observed evidence', () => {
    expect(BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_SCOPE_LABELS).toEqual({
      account: 'Account Read',
      repository: 'Repository Read',
      'repository:write': 'Repository Write',
      pullrequest: 'Pull request Read',
      webhook: 'Webhooks Read and Write',
    });
    expect(hasRequiredBitbucketWorkspaceAccessTokenScopes(['account', 'repository:write'])).toBe(
      false
    );
    expect(getMissingBitbucketWorkspaceAccessTokenScopes(['account', 'repository:write'])).toEqual([
      'pullrequest',
      'webhook',
    ]);
    expect(
      hasRequiredBitbucketWorkspaceAccessTokenScopes(['account', 'repository:write', 'webhook'])
    ).toBe(false);
    expect(
      hasRequiredBitbucketWorkspaceAccessTokenScopes([
        'account',
        'repository',
        'repository:write',
        'pullrequest',
        'webhook',
      ])
    ).toBe(true);

    const observedScopes = normalizeBitbucketWorkspaceAccessTokenScopes(
      'pullrequest Repository:Write account webhook'
    );
    expect(observedScopes).toEqual(['account', 'pullrequest', 'repository:write', 'webhook']);
    expect(hasRequiredBitbucketWorkspaceAccessTokenScopes(observedScopes)).toBe(true);
    expect(getMissingBitbucketWorkspaceAccessTokenScopes(observedScopes)).toEqual([]);
    expect(
      hasRequiredBitbucketWorkspaceAccessTokenScopes(['account', 'pullrequest:write', 'webhook'])
    ).toBe(true);
    expect(
      getMissingBitbucketWorkspaceAccessTokenScopes(['account', 'pullrequest:write', 'webhook'])
    ).toEqual([]);
    expect(getMissingBitbucketWorkspaceAccessTokenScopes(['account', 'project'])).toEqual([
      'repository:write',
      'pullrequest',
      'webhook',
    ]);

    expect(hasRequiredBitbucketWorkspaceAccessTokenScopes(['account', 'repository'])).toBe(false);
    expect(
      hasRequiredBitbucketWorkspaceAccessTokenScopes(['pullrequest', 'repository:write'])
    ).toBe(false);
  });

  it('validates fixed-host repository pagination consistently', () => {
    expect(
      isValidBitbucketRepositoryPaginationUrl(
        'https://api.bitbucket.org/2.0/repositories/acme?pagelen=%35%30',
        'acme'
      )
    ).toBe(true);
    expect(
      isValidBitbucketRepositoryPaginationUrl(
        'https://api.bitbucket.org/2.0/repositories/acme?role=contributor&pagelen=50',
        'acme'
      )
    ).toBe(false);
    expect(
      isValidBitbucketRepositoryPaginationUrl(
        'https://evil.example/2.0/repositories/acme?pagelen=50',
        'acme'
      )
    ).toBe(false);
  });

  it('exposes the approved credential and invalidation vocabulary', () => {
    expect(BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE).toBe(
      'workspace_access_token'
    );
    expect(BITBUCKET_WORKSPACE_ACCESS_TOKEN_INVALIDATION_REASONS).toEqual([
      'expired',
      'provider_rejected',
      'workspace_mismatch',
      'encryption_unreadable',
    ]);
  });

  it('recognizes only the unmodified Bitbucket access-token family prefix', () => {
    expect(BITBUCKET_ACCESS_TOKEN_FAMILY_PREFIX).toBe('ATCT');
    expect(hasBitbucketAccessTokenFamilyPrefix('ATCT-valid-looking-token')).toBe(true);
    expect(hasBitbucketAccessTokenFamilyPrefix(' ATCT-valid-looking-token')).toBe(false);
    expect(hasBitbucketAccessTokenFamilyPrefix('oauth-token')).toBe(false);
  });
});
