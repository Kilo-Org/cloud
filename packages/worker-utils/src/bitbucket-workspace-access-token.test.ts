import { describe, expect, it } from 'vitest';
import {
  BITBUCKET_ACCESS_TOKEN_FAMILY_PREFIX,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INVALIDATION_REASONS,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_SCOPE_LABELS,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_REQUIRED_EFFECTIVE_SCOPES,
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
