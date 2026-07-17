import { describe, expect, it } from 'vitest';
import {
  GitLabProjectAccessTokenMetadataSchema as RootGitLabProjectAccessTokenMetadataSchema,
  buildGitLabOAuthCredentialAad as rootBuildGitLabOAuthCredentialAad,
} from './index';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GitLabOAuthCredentialRowSchema,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GitLabPersonalAccessTokenCredentialRowSchema,
  GitLabPersonalAccessTokenMetadataSchema,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GitLabProjectAccessTokenCredentialRowSchema,
  GitLabProjectAccessTokenMetadataSchema,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
} from './gitlab-credential';

describe('GitLab credential contract', () => {
  it('exposes distinct envelope schemes for every credential kind', () => {
    expect(GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME).toBe('gitlab-oauth-credential-rsa-aes-256-gcm');
    expect(GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME).toBe(
      'gitlab-personal-access-token-rsa-aes-256-gcm'
    );
    expect(GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME).toBe(
      'gitlab-project-access-token-rsa-aes-256-gcm'
    );
  });

  it('builds OAuth AAD from the credential context, generation, and secret kind', () => {
    const input = {
      credentialId: 'credential-1',
      integrationId: 'integration-1',
      providerBaseUrl: 'https://gitlab.example.com/root',
      owner: { type: 'org', id: 'organization-1' } as const,
      authorizedByUserId: null,
      kind: 'oauth-client-secret' as const,
      credentialVersion: 7,
      providerSubjectId: 'must-not-be-bound',
    };

    expect(buildGitLabOAuthCredentialAad(input)).toBe(
      JSON.stringify({
        scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        version: 1,
        platform: 'gitlab',
        credentialId: 'credential-1',
        integrationId: 'integration-1',
        providerBaseUrl: 'https://gitlab.example.com/root',
        owner: { type: 'org', id: 'organization-1' },
        authorizedByUserId: null,
        credentialVersion: 7,
        kind: 'oauth-client-secret',
      })
    );
    expect(buildGitLabOAuthCredentialAad(input)).not.toContain('must-not-be-bound');
  });

  it('builds PAT AAD with the supplier and credential generation but no integration type', () => {
    const input = {
      credentialId: 'credential-2',
      integrationId: 'integration-2',
      providerBaseUrl: 'https://gitlab.example.com',
      owner: { type: 'user', id: 'user-1' } as const,
      authorizedByUserId: 'user-1',
      credentialVersion: 4,
      integrationType: 'must-not-be-bound',
    };

    const aad = buildGitLabPersonalAccessTokenAad(input);
    expect(aad).toBe(
      JSON.stringify({
        scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        version: 1,
        platform: 'gitlab',
        credentialId: 'credential-2',
        integrationId: 'integration-2',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: { type: 'user', id: 'user-1' },
        providerCredentialType: 'personal_access_token',
        providerResourceId: null,
        authorizedByUserId: 'user-1',
        credentialVersion: 4,
      })
    );
    expect(aad).not.toContain('must-not-be-bound');
  });

  it('builds project-token AAD with its resource but without a primary-token supplier', () => {
    const input = {
      credentialId: 'credential-3',
      integrationId: 'integration-3',
      providerBaseUrl: 'https://gitlab.example.com/group',
      owner: { type: 'org', id: 'organization-2' } as const,
      providerResourceId: '42',
      credentialVersion: 2,
      authorizedByUserId: 'must-not-be-bound',
      integrationType: 'must-also-not-be-bound',
    };

    const aad = buildGitLabProjectAccessTokenAad(input);
    expect(aad).toBe(
      JSON.stringify({
        scheme: GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
        version: 1,
        platform: 'gitlab',
        credentialId: 'credential-3',
        integrationId: 'integration-3',
        providerBaseUrl: 'https://gitlab.example.com/group',
        owner: { type: 'org', id: 'organization-2' },
        providerCredentialType: 'project_access_token',
        providerResourceId: '42',
        credentialVersion: 2,
      })
    );
    expect(aad).not.toContain('must-not-be-bound');
  });

  it('normalizes owner property order for every credential AAD', () => {
    const reversedOwner = { id: 'organization-1', type: 'org' } as const;
    const normalizedOwner = { type: 'org', id: 'organization-1' } as const;

    expect(
      buildGitLabOAuthCredentialAad({
        credentialId: 'oauth-credential',
        integrationId: 'integration-1',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: reversedOwner,
        authorizedByUserId: 'user-1',
        credentialVersion: 1,
        kind: 'access',
      })
    ).toBe(
      buildGitLabOAuthCredentialAad({
        credentialId: 'oauth-credential',
        integrationId: 'integration-1',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: normalizedOwner,
        authorizedByUserId: 'user-1',
        credentialVersion: 1,
        kind: 'access',
      })
    );
    expect(
      buildGitLabPersonalAccessTokenAad({
        credentialId: 'pat-credential',
        integrationId: 'integration-1',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: reversedOwner,
        authorizedByUserId: 'user-1',
        credentialVersion: 1,
      })
    ).toBe(
      buildGitLabPersonalAccessTokenAad({
        credentialId: 'pat-credential',
        integrationId: 'integration-1',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: normalizedOwner,
        authorizedByUserId: 'user-1',
        credentialVersion: 1,
      })
    );
    expect(
      buildGitLabProjectAccessTokenAad({
        credentialId: 'project-credential',
        integrationId: 'integration-1',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: reversedOwner,
        providerResourceId: '42',
        credentialVersion: 1,
      })
    ).toBe(
      buildGitLabProjectAccessTokenAad({
        credentialId: 'project-credential',
        integrationId: 'integration-1',
        providerBaseUrl: 'https://gitlab.example.com',
        owner: normalizedOwner,
        providerResourceId: '42',
        credentialVersion: 1,
      })
    );
  });

  it('accepts only the optional legacy-safe PAT provider metadata', () => {
    expect(GitLabPersonalAccessTokenMetadataSchema.parse({})).toEqual({});
    expect(
      GitLabPersonalAccessTokenMetadataSchema.parse({
        providerCredentialId: '123456',
        expiresOn: '2030-12-31',
      })
    ).toEqual({ providerCredentialId: '123456', expiresOn: '2030-12-31' });

    expect(
      GitLabPersonalAccessTokenMetadataSchema.safeParse({ providerCredentialId: '0' }).success
    ).toBe(false);
    expect(
      GitLabPersonalAccessTokenMetadataSchema.safeParse({ expiresOn: '2030-02-30' }).success
    ).toBe(false);
    expect(GitLabPersonalAccessTokenMetadataSchema.safeParse({ tokenName: 'secret' }).success).toBe(
      false
    );
  });

  it('requires both provider identifiers for project-token metadata', () => {
    expect(
      GitLabProjectAccessTokenMetadataSchema.parse({
        providerCredentialId: '987',
        expiresOn: '2031-01-15',
      })
    ).toEqual({ providerCredentialId: '987', expiresOn: '2031-01-15' });

    expect(
      GitLabProjectAccessTokenMetadataSchema.safeParse({ providerCredentialId: '987' }).success
    ).toBe(false);
    expect(
      GitLabProjectAccessTokenMetadataSchema.safeParse({ expiresOn: '2031-01-15' }).success
    ).toBe(false);
    expect(
      GitLabProjectAccessTokenMetadataSchema.safeParse({
        providerCredentialId: '987',
        expiresOn: '2031-01-15',
        token: 'must-never-be-stored',
      }).success
    ).toBe(false);
  });

  it('validates the complete GitLab OAuth row without normalizing PostgreSQL timestamps', () => {
    const postgresTimestamp = '2026-04-29 01:16:12.945+00';
    const row = {
      id: 'credential-1',
      platform_integration_id: 'integration-1',
      authorized_by_user_id: null,
      provider_subject_id: '123',
      provider_subject_login: 'octocat',
      provider_base_url: 'https://gitlab.example.com/root',
      access_token_encrypted: 'access-envelope',
      access_token_expires_at: postgresTimestamp,
      refresh_token_encrypted: null,
      refresh_token_expires_at: null,
      oauth_client_secret_encrypted: 'client-secret-envelope',
      credential_version: 3,
      revoked_at: null,
      revocation_reason: null,
      last_used_at: null,
      created_at: postgresTimestamp,
      updated_at: postgresTimestamp,
    };

    expect(GitLabOAuthCredentialRowSchema.parse(row)).toEqual(row);
    expect(
      GitLabOAuthCredentialRowSchema.safeParse({ ...row, platform: 'bitbucket' }).success
    ).toBe(true);
    expect(
      GitLabOAuthCredentialRowSchema.safeParse({ ...row, provider_base_url: null }).success
    ).toBe(false);
    for (const providerBaseUrl of [
      'http://gitlab.example.com',
      'https://user@gitlab.example.com',
      'https://gitlab.example.com?group=one',
      'https://gitlab.example.com#group',
      'https://GitLab.Example.com/',
    ]) {
      expect(
        GitLabOAuthCredentialRowSchema.safeParse({
          ...row,
          provider_base_url: providerBaseUrl,
        }).success
      ).toBe(false);
    }
    expect(GitLabOAuthCredentialRowSchema.safeParse({ ...row, unexpected: true }).success).toBe(
      false
    );
  });

  it('validates an integration-level GitLab PAT row profile', () => {
    const row = {
      id: 'credential-2',
      platform_integration_id: 'integration-2',
      token_encrypted: 'pat-envelope',
      expires_at: null,
      provider_credential_type: 'personal_access_token',
      provider_resource_id: null,
      provider_base_url: 'https://gitlab.example.com',
      authorized_by_user_id: null,
      provider_metadata: {},
      provider_scopes: null,
      provider_verified_at: null,
      credential_version: 1,
      last_validated_at: null,
      last_used_at: null,
      created_at: '2026-07-13T12:00:00.000Z',
      updated_at: '2026-07-13T12:00:00.000Z',
    };

    expect(GitLabPersonalAccessTokenCredentialRowSchema.parse(row)).toEqual(row);
    expect(
      GitLabPersonalAccessTokenCredentialRowSchema.safeParse({
        ...row,
        provider_resource_id: '42',
      }).success
    ).toBe(false);
    expect(
      GitLabPersonalAccessTokenCredentialRowSchema.safeParse({
        ...row,
        provider_metadata: { token: 'must-never-be-stored' },
      }).success
    ).toBe(false);
  });

  it('validates a resource-scoped GitLab project-token row profile', () => {
    const row = {
      id: 'credential-3',
      platform_integration_id: 'integration-3',
      token_encrypted: 'project-token-envelope',
      expires_at: null,
      provider_credential_type: 'project_access_token',
      provider_resource_id: '42',
      provider_base_url: 'https://gitlab.example.com/root',
      authorized_by_user_id: null,
      provider_metadata: {
        providerCredentialId: '654',
        expiresOn: '2032-06-30',
      },
      provider_scopes: ['api'],
      provider_verified_at: '2026-07-13T12:00:00.000Z',
      credential_version: 5,
      last_validated_at: '2026-07-13T12:00:00.000Z',
      last_used_at: null,
      created_at: '2026-07-13T12:00:00.000Z',
      updated_at: '2026-07-13T12:00:00.000Z',
    };

    expect(GitLabProjectAccessTokenCredentialRowSchema.parse(row)).toEqual(row);
    expect(
      GitLabProjectAccessTokenCredentialRowSchema.safeParse({
        ...row,
        provider_resource_id: 'not-decimal',
      }).success
    ).toBe(false);
    expect(
      GitLabProjectAccessTokenCredentialRowSchema.safeParse({
        ...row,
        authorized_by_user_id: 'user-1',
      }).success
    ).toBe(false);
  });

  it('exports the GitLab credential contract from the package root', () => {
    expect(rootBuildGitLabOAuthCredentialAad).toBe(buildGitLabOAuthCredentialAad);
    expect(RootGitLabProjectAccessTokenMetadataSchema).toBe(GitLabProjectAccessTokenMetadataSchema);
  });
});
