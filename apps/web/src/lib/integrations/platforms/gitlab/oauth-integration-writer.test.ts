/* eslint-disable drizzle/enforce-delete-with-where */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  buildGitLabOAuthCredentialAad,
} from '@kilocode/worker-utils/gitlab-credential';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { storeGitLabOAuthIntegration } from './oauth-integration-writer';

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const TEST_KEY_ID = 'platform-credential-key-v1';
const mockCredentialEncryptionConfig: {
  keyId: string | undefined;
  publicKey: string | undefined;
} = {
  keyId: TEST_KEY_ID,
  publicKey: Buffer.from(testKeyPair.publicKey).toString('base64'),
};

jest.mock('@/lib/config.server', () => ({
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID() {
    return mockCredentialEncryptionConfig.keyId;
  },
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY() {
    return mockCredentialEncryptionConfig.publicKey;
  },
}));

describe('GitLab OAuth integration writer', () => {
  beforeEach(() => {
    mockCredentialEncryptionConfig.keyId = TEST_KEY_ID;
    mockCredentialEncryptionConfig.publicKey = Buffer.from(testKeyPair.publicKey).toString(
      'base64'
    );
  });

  afterEach(async () => {
    await db.delete(platform_oauth_credentials);
    await db.delete(platform_access_token_credentials);
    await db.delete(platform_integrations);
    await db.delete(kilocode_users);
  });

  it('atomically stores a new OAuth integration with only encrypted credentials', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user', id: user.id } as const;
    const input = {
      owner,
      authorizedByUserId: user.id,
      providerBaseUrl: 'https://gitlab.example.com/root',
      providerUser: { id: '12345', login: 'gitlab-user' },
      accessToken: 'oauth-access-secret',
      refreshToken: 'oauth-refresh-secret',
      accessTokenExpiresAt: '2030-01-01T00:00:00.000Z',
      oauthClientId: 'custom-client-id',
      oauthClientSecret: 'custom-client-secret',
      scopes: ['api', 'read_user'],
      repositories: [{ id: 42, name: 'project', full_name: 'group/project', private: true }],
    };

    const result = await storeGitLabOAuthIntegration(input);

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, result.integrationId));
    const [credential] = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, result.integrationId));
    if (!integration || !credential || !credential.oauth_client_secret_encrypted) {
      throw new Error('Expected complete GitLab OAuth integration');
    }

    expect(result.instanceChanged).toBe(false);
    expect(integration).toEqual(
      expect.objectContaining({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_installation_id: '12345',
        platform_account_id: '12345',
        platform_account_login: 'gitlab-user',
        integration_status: 'active',
        metadata: expect.objectContaining({
          gitlab_instance_url: input.providerBaseUrl,
          client_id: input.oauthClientId,
          auth_type: 'oauth',
        }),
      })
    );
    expect(integration.metadata).not.toHaveProperty('access_token');
    expect(integration.metadata).not.toHaveProperty('refresh_token');
    expect(integration.metadata).not.toHaveProperty('token_expires_at');
    expect(integration.metadata).not.toHaveProperty('client_secret');
    expect(credential).toEqual(
      expect.objectContaining({
        authorized_by_user_id: user.id,
        provider_subject_id: '12345',
        provider_subject_login: 'gitlab-user',
        provider_base_url: input.providerBaseUrl,
        access_token_expires_at: expect.anything(),
        credential_version: 1,
      })
    );

    const privateKeys = {
      active: {
        keyId: TEST_KEY_ID,
        privateKeyPem: testKeyPair.privateKey,
      },
    };
    const decrypt = (ciphertext: string, kind: 'access' | 'refresh' | 'oauth-client-secret') =>
      decryptKeyedEnvelope(
        ciphertext,
        GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        privateKeys,
        buildGitLabOAuthCredentialAad({
          credentialId: credential.id,
          integrationId: integration.id,
          providerBaseUrl: input.providerBaseUrl,
          owner,
          authorizedByUserId: user.id,
          credentialVersion: credential.credential_version,
          kind,
        })
      );
    expect(decrypt(credential.access_token_encrypted, 'access')).toBe(input.accessToken);
    if (!credential.refresh_token_encrypted) throw new Error('Expected encrypted refresh token');
    expect(decrypt(credential.refresh_token_encrypted, 'refresh')).toBe(input.refreshToken);
    expect(decrypt(credential.oauth_client_secret_encrypted, 'oauth-client-secret')).toBe(
      input.oauthClientSecret
    );
    expect(JSON.stringify(credential)).not.toContain(input.accessToken);
    expect(JSON.stringify(credential)).not.toContain(input.refreshToken);
    expect(JSON.stringify(credential)).not.toContain(input.oauthClientSecret);
  });

  it('replaces the OAuth credential identity on a same-instance reconnect', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com/root';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_account_id: 'old-provider-id',
        platform_account_login: 'old-login',
        integration_status: 'active',
        metadata: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          gitlab_instance_url: providerBaseUrl,
          webhook_secret: 'preserved-webhook-secret',
          configured_webhooks: ['42'],
          auth_type: 'oauth',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected existing integration');
    const [oldCredential] = await db
      .insert(platform_oauth_credentials)
      .values({
        platform_integration_id: integration.id,
        authorized_by_user_id: user.id,
        provider_subject_id: 'old-provider-id',
        provider_subject_login: 'old-login',
        provider_base_url: providerBaseUrl,
        access_token_encrypted: 'old-access-envelope',
        refresh_token_encrypted: 'old-refresh-envelope',
      })
      .returning();
    if (!oldCredential) throw new Error('Expected existing OAuth credential');

    const result = await storeGitLabOAuthIntegration({
      owner: { type: 'user', id: user.id },
      authorizedByUserId: user.id,
      providerBaseUrl,
      providerUser: { id: 'new-provider-id', login: 'new-login' },
      accessToken: 'new-access-secret',
      refreshToken: 'new-refresh-secret',
      accessTokenExpiresAt: '2031-01-01T00:00:00.000Z',
      oauthClientId: null,
      oauthClientSecret: null,
      scopes: ['api'],
      repositories: null,
    });

    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    const credentials = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));

    expect(result).toEqual({ integrationId: integration.id, instanceChanged: false });
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual(
      expect.objectContaining({
        provider_subject_id: 'new-provider-id',
        provider_subject_login: 'new-login',
        provider_base_url: providerBaseUrl,
        credential_version: 1,
      })
    );
    expect(credentials[0]?.id).not.toBe(oldCredential.id);
    expect(updatedIntegration).toEqual(
      expect.objectContaining({
        integration_type: 'oauth',
        platform_account_id: 'new-provider-id',
        platform_account_login: 'new-login',
        metadata: expect.objectContaining({
          webhook_secret: 'preserved-webhook-secret',
          configured_webhooks: ['42'],
          auth_type: 'oauth',
        }),
      })
    );
    expect(updatedIntegration.metadata).not.toHaveProperty('access_token');
    expect(updatedIntegration.metadata).not.toHaveProperty('refresh_token');
  });

  it('replaces an integration PAT while preserving same-instance project credentials', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com/root';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        platform_account_id: 'provider-id',
        platform_account_login: 'provider-login',
        integration_status: 'active',
        metadata: {
          access_token: 'old-pat',
          gitlab_instance_url: providerBaseUrl,
          webhook_secret: 'preserved-webhook-secret',
          auth_type: 'pat',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected existing PAT integration');
    const [personalCredential, projectCredential] = await db
      .insert(platform_access_token_credentials)
      .values([
        {
          platform_integration_id: integration.id,
          token_encrypted: 'pat-envelope',
          provider_credential_type: 'personal_access_token',
          provider_resource_id: null,
          provider_base_url: providerBaseUrl,
          authorized_by_user_id: user.id,
          provider_metadata: {},
        },
        {
          platform_integration_id: integration.id,
          token_encrypted: 'project-envelope',
          provider_credential_type: 'project_access_token',
          provider_resource_id: '42',
          provider_base_url: providerBaseUrl,
          authorized_by_user_id: null,
          provider_metadata: { providerCredentialId: '99', expiresOn: '2030-01-01' },
        },
      ])
      .returning();
    if (!personalCredential || !projectCredential) {
      throw new Error('Expected PAT and project credentials');
    }

    await storeGitLabOAuthIntegration({
      owner: { type: 'user', id: user.id },
      authorizedByUserId: user.id,
      providerBaseUrl,
      providerUser: { id: 'provider-id', login: 'provider-login' },
      accessToken: 'oauth-access-secret',
      refreshToken: 'oauth-refresh-secret',
      accessTokenExpiresAt: '2031-01-01T00:00:00.000Z',
      oauthClientId: null,
      oauthClientSecret: null,
      scopes: ['api'],
      repositories: null,
    });

    const remainingAccessCredentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
    expect(remainingAccessCredentials).toEqual([
      expect.objectContaining({
        id: projectCredential.id,
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
      }),
    ]);
    expect(remainingAccessCredentials.map(row => row.id)).not.toContain(personalCredential.id);
    await expect(
      db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integration.id))
    ).resolves.toHaveLength(1);
  });

  it('deletes every access credential when the GitLab instance changes', async () => {
    const user = await insertTestUser();
    const oldProviderBaseUrl = 'https://old-gitlab.example.com';
    const newProviderBaseUrl = 'https://new-gitlab.example.com/root';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_account_id: 'provider-id',
        platform_account_login: 'provider-login',
        integration_status: 'active',
        metadata: {
          access_token: 'old-access',
          refresh_token: 'old-refresh',
          gitlab_instance_url: oldProviderBaseUrl,
          webhook_secret: 'old-webhook-secret',
          configured_webhooks: ['42'],
          project_tokens: { '42': { token: 'legacy-project-token' } },
          auth_type: 'oauth',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected existing integration');
    await db.insert(platform_oauth_credentials).values({
      platform_integration_id: integration.id,
      authorized_by_user_id: user.id,
      provider_subject_id: 'provider-id',
      provider_subject_login: 'provider-login',
      provider_base_url: oldProviderBaseUrl,
      access_token_encrypted: 'old-access-envelope',
      refresh_token_encrypted: 'old-refresh-envelope',
    });
    await db.insert(platform_access_token_credentials).values([
      {
        platform_integration_id: integration.id,
        token_encrypted: 'pat-envelope',
        provider_credential_type: 'personal_access_token',
        provider_resource_id: null,
        provider_base_url: oldProviderBaseUrl,
        authorized_by_user_id: user.id,
        provider_metadata: {},
      },
      {
        platform_integration_id: integration.id,
        token_encrypted: 'project-envelope',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: oldProviderBaseUrl,
        authorized_by_user_id: null,
        provider_metadata: { providerCredentialId: '99', expiresOn: '2030-01-01' },
      },
    ]);

    const result = await storeGitLabOAuthIntegration({
      owner: { type: 'user', id: user.id },
      authorizedByUserId: user.id,
      providerBaseUrl: newProviderBaseUrl,
      providerUser: { id: 'new-provider-id', login: 'new-provider-login' },
      accessToken: 'new-access-secret',
      refreshToken: 'new-refresh-secret',
      accessTokenExpiresAt: '2031-01-01T00:00:00.000Z',
      oauthClientId: 'new-client-id',
      oauthClientSecret: 'new-client-secret',
      scopes: ['api'],
      repositories: null,
    });

    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    const [updatedCredential] = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
    expect(result.instanceChanged).toBe(true);
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(eq(platform_access_token_credentials.platform_integration_id, integration.id))
    ).resolves.toEqual([]);
    expect(updatedCredential?.provider_base_url).toBe(newProviderBaseUrl);
    expect(updatedIntegration?.metadata).toEqual(
      expect.not.objectContaining({
        configured_webhooks: expect.anything(),
        project_tokens: expect.anything(),
      })
    );
    expect(updatedIntegration?.metadata).toEqual(
      expect.objectContaining({
        gitlab_instance_url: newProviderBaseUrl,
        client_id: 'new-client-id',
      })
    );
    expect(updatedIntegration?.metadata).not.toHaveProperty('client_secret');
  });

  it('leaves existing state unchanged when credential encryption is unavailable', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com/root';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        platform_account_id: 'provider-id',
        platform_account_login: 'provider-login',
        integration_status: 'active',
        metadata: {
          access_token: 'old-pat',
          gitlab_instance_url: providerBaseUrl,
          webhook_secret: 'old-webhook-secret',
          auth_type: 'pat',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected existing PAT integration');
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: integration.id,
      token_encrypted: 'pat-envelope',
      provider_credential_type: 'personal_access_token',
      provider_resource_id: null,
      provider_base_url: providerBaseUrl,
      authorized_by_user_id: user.id,
      provider_metadata: {},
    });
    const [integrationBefore] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    const accessCredentialsBefore = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
    mockCredentialEncryptionConfig.publicKey = undefined;

    await expect(
      storeGitLabOAuthIntegration({
        owner: { type: 'user', id: user.id },
        authorizedByUserId: user.id,
        providerBaseUrl,
        providerUser: { id: 'new-provider-id', login: 'new-provider-login' },
        accessToken: 'new-access-secret',
        refreshToken: 'new-refresh-secret',
        accessTokenExpiresAt: '2031-01-01T00:00:00.000Z',
        oauthClientId: null,
        oauthClientSecret: null,
        scopes: ['api'],
        repositories: null,
      })
    ).rejects.toThrow('GitLab credential encryption is not configured');

    await expect(
      db.select().from(platform_integrations).where(eq(platform_integrations.id, integration.id))
    ).resolves.toEqual([integrationBefore]);
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(eq(platform_access_token_credentials.platform_integration_id, integration.id))
    ).resolves.toEqual(accessCredentialsBefore);
    await expect(
      db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integration.id))
    ).resolves.toEqual([]);
  });
});
