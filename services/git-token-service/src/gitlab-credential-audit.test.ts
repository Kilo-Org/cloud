import { getWorkerDb } from '@kilocode/db/client';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
} from '@kilocode/worker-utils/gitlab-credential';
import { describe, expect, it, vi } from 'vitest';
import {
  GitLabCredentialAuditRequestSchema,
  GitLabCredentialAuditService,
  buildGitLabAccessTokenCredentialAuditQuery,
  buildGitLabOAuthCredentialAuditQuery,
} from './gitlab-credential-audit.js';

const timestamp = '2026-07-13T12:00:00.000Z';

function oauthCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'credential-oauth',
    platform_integration_id: 'integration-oauth',
    authorized_by_user_id: 'user-1',
    provider_subject_id: '42',
    provider_subject_login: 'octocat',
    provider_base_url: 'https://gitlab.example.com/root',
    access_token_encrypted: 'ciphertext-access',
    access_token_expires_at: timestamp,
    refresh_token_encrypted: 'ciphertext-refresh',
    refresh_token_expires_at: null,
    oauth_client_secret_encrypted: 'ciphertext-client-secret',
    credential_version: 1,
    revoked_at: null,
    revocation_reason: null,
    last_used_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function accessTokenCredential(overrides: Record<string, unknown> = {}) {
  return {
    id: 'credential-pat',
    platform_integration_id: 'integration-pat',
    token_encrypted: 'ciphertext-pat',
    expires_at: null,
    provider_credential_type: 'personal_access_token',
    provider_resource_id: null,
    provider_base_url: 'https://gitlab.example.com/root',
    authorized_by_user_id: 'user-1',
    provider_metadata: {},
    provider_scopes: null,
    provider_verified_at: null,
    credential_version: 2,
    last_validated_at: null,
    last_used_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  };
}

function parent(integrationId: string, integrationType: 'oauth' | 'pat') {
  return {
    id: integrationId,
    platform: 'gitlab',
    integration_type: integrationType,
    integration_status: 'suspended',
    platform_account_id: '42',
    platform_account_login: 'octocat',
    owned_by_user_id: 'user-1',
    owned_by_organization_id: null,
    metadata: { gitlab_instance_url: 'https://gitlab.example.com/root' },
  };
}

describe('GitLabCredentialAuditService', () => {
  it('joins credentials from every GitLab parent without filtering suspended integrations', () => {
    const db = getWorkerDb('postgres://query-builder');
    const afterId = '123e4567-e89b-12d3-a456-426614174099';
    const queries = [
      buildGitLabOAuthCredentialAuditQuery(db, afterId).toSQL(),
      buildGitLabAccessTokenCredentialAuditQuery(db, afterId).toSQL(),
    ];

    for (const query of queries) {
      expect(query.sql).toContain('inner join "platform_integrations"');
      expect(query.sql).toContain('"platform_integrations"."platform" =');
      expect(query.sql).not.toContain('"platform_integrations"."integration_status" =');
      expect(query.params).toContain('gitlab');
      expect(query.params).toContain(afterId);
    }
  });

  it('reconstructs every OAuth AAD and returns only key identity, counts, and IDs', async () => {
    const auditDecrypt = vi.fn().mockResolvedValue({
      status: 'available' as const,
      token: 'decrypted-secret-must-not-be-returned',
    });
    const service = new GitLabCredentialAuditService(
      {
        listCredentials: vi.fn().mockResolvedValue({
          rows: [
            {
              table: 'oauth',
              parent: parent('integration-oauth', 'oauth'),
              credential: oauthCredential(),
            },
          ],
          nextCursor: null,
        }),
      },
      {
        auditDecrypt,
        auditKeyIdentity: vi.fn().mockResolvedValue({
          status: 'available',
          keyId: 'active',
          publicKeySha256: 'a'.repeat(64),
        }),
      }
    );

    const result = await service.audit({ limit: 25 });

    expect(auditDecrypt).toHaveBeenNthCalledWith(1, {
      ciphertext: 'ciphertext-access',
      scheme: GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      aad: buildGitLabOAuthCredentialAad({
        credentialId: 'credential-oauth',
        integrationId: 'integration-oauth',
        providerBaseUrl: 'https://gitlab.example.com/root',
        owner: { type: 'user', id: 'user-1' },
        authorizedByUserId: 'user-1',
        credentialVersion: 1,
        kind: 'access',
      }),
    });
    expect(auditDecrypt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ aad: expect.stringContaining('"kind":"refresh"') })
    );
    expect(auditDecrypt).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ aad: expect.stringContaining('"kind":"oauth-client-secret"') })
    );
    expect(result).toEqual({
      activeKey: { keyId: 'active', publicKeySha256: 'a'.repeat(64) },
      counts: {
        credentials: 1,
        secrets: 3,
        passedCredentials: 1,
        profileFailures: 0,
        configurationFailures: 0,
        parseFailures: 0,
        unknownKeyFailures: 0,
        decryptOrAadFailures: 0,
      },
      failingCredentials: {
        profile: [],
        configuration: [],
        parse: [],
        unknownKey: [],
        decryptOrAad: [],
      },
      nextCursor: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/decrypted-secret|ciphertext-/);
  });

  it('reconstructs PAT AAD from the validated parent owner and version', async () => {
    const auditDecrypt = vi.fn().mockResolvedValue({ status: 'available', token: 'pat-secret' });
    const service = new GitLabCredentialAuditService(
      {
        listCredentials: vi.fn().mockResolvedValue({
          rows: [
            {
              table: 'access-token',
              parent: parent('integration-pat', 'pat'),
              credential: accessTokenCredential(),
            },
          ],
          nextCursor: null,
        }),
      },
      {
        auditDecrypt,
        auditKeyIdentity: vi.fn().mockResolvedValue({
          status: 'available',
          keyId: 'active',
          publicKeySha256: 'b'.repeat(64),
        }),
      }
    );

    await service.audit({ limit: 1 });

    expect(auditDecrypt).toHaveBeenCalledWith({
      ciphertext: 'ciphertext-pat',
      scheme: GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
      aad: buildGitLabPersonalAccessTokenAad({
        credentialId: 'credential-pat',
        integrationId: 'integration-pat',
        providerBaseUrl: 'https://gitlab.example.com/root',
        owner: { type: 'user', id: 'user-1' },
        authorizedByUserId: 'user-1',
        credentialVersion: 2,
      }),
    });
  });

  it('classifies profile and decrypt failures by integration and credential ID only', async () => {
    const service = new GitLabCredentialAuditService(
      {
        listCredentials: vi.fn().mockResolvedValue({
          rows: [
            {
              table: 'oauth',
              parent: parent('integration-profile', 'oauth'),
              credential: oauthCredential({
                id: 'credential-profile',
                platform_integration_id: 'integration-profile',
                provider_subject_id: 'wrong-subject',
              }),
            },
            {
              table: 'access-token',
              parent: parent('integration-decrypt', 'pat'),
              credential: accessTokenCredential({
                id: 'credential-decrypt',
                platform_integration_id: 'integration-decrypt',
              }),
            },
          ],
          nextCursor: null,
        }),
      },
      {
        auditDecrypt: vi.fn().mockResolvedValue({ status: 'decrypt_failed' }),
        auditKeyIdentity: vi.fn().mockResolvedValue({
          status: 'available',
          keyId: 'active',
          publicKeySha256: 'c'.repeat(64),
        }),
      }
    );

    const result = await service.audit({ limit: 2 });

    expect(result.failingCredentials.profile).toEqual([
      { integrationId: 'integration-profile', credentialId: 'credential-profile' },
    ]);
    expect(result.failingCredentials.decryptOrAad).toEqual([
      { integrationId: 'integration-decrypt', credentialId: 'credential-decrypt' },
    ]);
  });

  it('strictly bounds cursor and limit and rejects removed legacy-comparison input', () => {
    expect(GitLabCredentialAuditRequestSchema.parse({})).toEqual({ limit: 100 });
    expect(
      GitLabCredentialAuditRequestSchema.safeParse({
        cursor: 'access-token:123e4567-e89b-12d3-a456-426614174099',
        limit: 1,
      }).success
    ).toBe(true);
    expect(GitLabCredentialAuditRequestSchema.safeParse({ cursor: 'access-token' }).success).toBe(
      true
    );
    expect(GitLabCredentialAuditRequestSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(GitLabCredentialAuditRequestSchema.safeParse({ compareLegacy: true }).success).toBe(
      false
    );
  });
});
