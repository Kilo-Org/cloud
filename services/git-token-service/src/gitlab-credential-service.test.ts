import { generateKeyPairSync } from 'node:crypto';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
} from '@kilocode/worker-utils/gitlab-credential';
import { describe, expect, it } from 'vitest';
import { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';
import {
  GitLabCredentialService,
  type GitLabCredentialStore,
} from './gitlab-credential-service.js';

const now = '2026-07-13T12:00:00.000Z';

function encryptedPatFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const aad = buildGitLabPersonalAccessTokenAad({
    credentialId: 'credential-1',
    integrationId: 'integration-1',
    providerBaseUrl: 'https://gitlab.example.com',
    owner: { type: 'user', id: 'user-1' },
    authorizedByUserId: 'user-1',
    credentialVersion: 1,
  });
  return {
    crypto: new GitLabCredentialCrypto({
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: 'active',
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    }),
    tokenEncrypted: encryptKeyedEnvelope(
      'glpat-secret',
      GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
      { keyId: 'active', publicKeyPem: publicKey },
      aad
    ),
  };
}

function encryptedOAuthFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const aad = buildGitLabOAuthCredentialAad({
    credentialId: 'oauth-credential-1',
    integrationId: 'integration-1',
    providerBaseUrl: 'https://gitlab.example.com',
    owner: { type: 'user', id: 'user-1' },
    authorizedByUserId: 'user-1',
    credentialVersion: 1,
    kind: 'access',
  });
  return {
    crypto: new GitLabCredentialCrypto({
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: 'active',
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    }),
    tokenEncrypted: encryptKeyedEnvelope(
      'oauth-access-secret',
      GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
      { keyId: 'active', publicKeyPem: publicKey },
      aad
    ),
  };
}

function encryptedProjectTokenFixture() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const aad = buildGitLabProjectAccessTokenAad({
    credentialId: 'project-credential-1',
    integrationId: 'integration-1',
    providerBaseUrl: 'https://gitlab.example.com',
    owner: { type: 'user', id: 'user-1' },
    providerResourceId: '42',
    credentialVersion: 3,
  });
  return {
    crypto: new GitLabCredentialCrypto({
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: 'active',
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(publicKey).toString('base64'),
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: Buffer.from(privateKey).toString('base64'),
    }),
    tokenEncrypted: encryptKeyedEnvelope(
      'glpat-project-secret',
      GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
      { keyId: 'active', publicKeyPem: publicKey },
      aad
    ),
  };
}

describe('GitLabCredentialService', () => {
  it('resolves a matching encrypted integration PAT', async () => {
    const fixture = encryptedPatFixture();
    const store: GitLabCredentialStore = {
      findCredential: async () => ({
        parent: {
          integrationId: 'integration-1',
          platform: 'gitlab',
          integrationType: 'pat',
          integrationStatus: 'active',
          ownedByUserId: 'user-1',
          ownedByOrganizationId: null,
          providerBaseUrl: 'https://gitlab.example.com',
        },
        credential: {
          id: 'credential-1',
          platform_integration_id: 'integration-1',
          token_encrypted: fixture.tokenEncrypted,
          expires_at: null,
          provider_credential_type: 'personal_access_token',
          provider_resource_id: null,
          provider_base_url: 'https://gitlab.example.com',
          authorized_by_user_id: 'user-1',
          provider_metadata: {},
          provider_scopes: null,
          provider_verified_at: null,
          credential_version: 1,
          last_validated_at: null,
          last_used_at: null,
          created_at: now,
          updated_at: now,
        },
      }),
      hasProjectCredentialCandidates: async () => false,
      markUsed: async () => true,
    };

    await expect(
      new GitLabCredentialService(store, fixture.crypto).getCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({
      status: 'available',
      token: 'glpat-secret',
      instanceUrl: 'https://gitlab.example.com',
      integrationId: 'integration-1',
      glabIsOAuth2: false,
      credentialId: 'credential-1',
      credentialVersion: 1,
      source: { type: 'integration' },
    });
  });

  it('resolves a matching encrypted OAuth access token', async () => {
    const fixture = encryptedOAuthFixture();
    const store: GitLabCredentialStore = {
      findCredential: async () => ({
        parent: {
          integrationId: 'integration-1',
          platform: 'gitlab',
          integrationType: 'oauth',
          integrationStatus: 'active',
          ownedByUserId: 'user-1',
          ownedByOrganizationId: null,
          providerBaseUrl: 'https://gitlab.example.com',
        },
        credential: {
          id: 'oauth-credential-1',
          platform_integration_id: 'integration-1',
          authorized_by_user_id: 'user-1',
          provider_subject_id: '123',
          provider_subject_login: 'octocat',
          provider_base_url: 'https://gitlab.example.com',
          access_token_encrypted: fixture.tokenEncrypted,
          access_token_expires_at: '2027-07-13T14:00:00.000Z',
          refresh_token_encrypted: 'encrypted-refresh-token',
          refresh_token_expires_at: null,
          oauth_client_secret_encrypted: null,
          credential_version: 1,
          revoked_at: null,
          revocation_reason: null,
          last_used_at: null,
          created_at: now,
          updated_at: now,
        },
      }),
      hasProjectCredentialCandidates: async () => false,
      markUsed: async () => true,
    };

    await expect(
      new GitLabCredentialService(store, fixture.crypto).getCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({
      status: 'available',
      token: 'oauth-access-secret',
      instanceUrl: 'https://gitlab.example.com',
      integrationId: 'integration-1',
      glabIsOAuth2: true,
      credentialId: 'oauth-credential-1',
      credentialVersion: 1,
      source: { type: 'integration' },
    });
  });

  it('refreshes an expired OAuth credential through the locked refresher', async () => {
    const fixture = encryptedOAuthFixture();
    const store: GitLabCredentialStore = {
      findCredential: async () => ({
        parent: {
          integrationId: 'integration-1',
          platform: 'gitlab',
          integrationType: 'oauth',
          integrationStatus: 'active',
          ownedByUserId: 'user-1',
          ownedByOrganizationId: null,
          providerBaseUrl: 'https://gitlab.example.com',
        },
        credential: {
          id: 'oauth-credential-1',
          platform_integration_id: 'integration-1',
          authorized_by_user_id: 'user-1',
          provider_subject_id: '123',
          provider_subject_login: 'octocat',
          provider_base_url: 'https://gitlab.example.com',
          access_token_encrypted: fixture.tokenEncrypted,
          access_token_expires_at: '2020-01-01T00:00:00.000Z',
          refresh_token_encrypted: 'encrypted-refresh-token',
          refresh_token_expires_at: null,
          oauth_client_secret_encrypted: null,
          credential_version: 1,
          revoked_at: null,
          revocation_reason: null,
          last_used_at: null,
          created_at: now,
          updated_at: now,
        },
      }),
      hasProjectCredentialCandidates: async () => false,
      markUsed: async () => true,
    };

    await expect(
      new GitLabCredentialService(store, fixture.crypto, {
        refresh: async () => ({
          status: 'available',
          token: 'refreshed-oauth-secret',
          credentialVersion: 2,
        }),
      }).getCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({
      status: 'available',
      token: 'refreshed-oauth-secret',
      instanceUrl: 'https://gitlab.example.com',
      integrationId: 'integration-1',
      glabIsOAuth2: true,
      credentialId: 'oauth-credential-1',
      credentialVersion: 2,
      source: { type: 'integration' },
    });
  });

  it('resolves only the exact encrypted project credential', async () => {
    const fixture = encryptedProjectTokenFixture();
    const store: GitLabCredentialStore = {
      findCredential: async () => ({
        parent: {
          integrationId: 'integration-1',
          platform: 'gitlab',
          integrationType: 'oauth',
          integrationStatus: 'active',
          ownedByUserId: 'user-1',
          ownedByOrganizationId: null,
          providerBaseUrl: 'https://gitlab.example.com',
        },
        credential: {
          id: 'project-credential-1',
          platform_integration_id: 'integration-1',
          token_encrypted: fixture.tokenEncrypted,
          expires_at: null,
          provider_credential_type: 'project_access_token',
          provider_resource_id: '42',
          provider_base_url: 'https://gitlab.example.com',
          authorized_by_user_id: null,
          provider_metadata: {
            providerCredentialId: '314',
            expiresOn: '2027-07-13',
          },
          provider_scopes: null,
          provider_verified_at: null,
          credential_version: 3,
          last_validated_at: null,
          last_used_at: null,
          created_at: now,
          updated_at: now,
        },
      }),
      hasProjectCredentialCandidates: async () => false,
      markUsed: async () => true,
    };

    await expect(
      new GitLabCredentialService(store, fixture.crypto).getCredential(
        { userId: 'user-1' },
        { credential: 'project-exact', integrationId: 'integration-1', projectId: '42' }
      )
    ).resolves.toEqual({
      status: 'available',
      token: 'glpat-project-secret',
      instanceUrl: 'https://gitlab.example.com',
      integrationId: 'integration-1',
      glabIsOAuth2: false,
      credentialId: 'project-credential-1',
      credentialVersion: 3,
      source: { type: 'project', projectId: '42' },
    });
  });
});
