/* eslint-disable drizzle/enforce-delete-with-where */

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabOAuthCredentialAad,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
} from '@kilocode/worker-utils/gitlab-credential';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  organizations,
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { runGitLabCredentialMigration } from './credential-migration';

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

describe('GitLab credential migration', () => {
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
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it('audits legacy OAuth, PAT, and project tokens without changing integrations', async () => {
    const user = await insertTestUser();
    const fixedUpdatedAt = '2026-07-01T00:00:00.000Z';
    const [oauthIntegration, patIntegration] = await db
      .insert(platform_integrations)
      .values([
        {
          id: '00000000-0000-4000-8000-000000000001',
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_account_id: '101',
          platform_account_login: 'oauth-user',
          integration_status: 'active',
          updated_at: fixedUpdatedAt,
          metadata: {
            access_token: 'oauth-access-secret',
            refresh_token: 'oauth-refresh-secret',
            token_expires_at: '2030-01-01T00:00:00.000Z',
            client_id: 'oauth-client-id',
            client_secret: 'oauth-client-secret',
            auth_type: 'oauth',
            webhook_secret: 'keep-webhook-secret',
            project_tokens: {
              '42': {
                token_id: 99,
                token: 'project-secret',
                expires_at: '2030-06-01',
                created_at: '2026-07-01T00:00:00.000Z',
                name: 'Kilo Code Review Bot',
              },
            },
          },
        },
        {
          id: '00000000-0000-4000-8000-000000000002',
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'pat',
          platform_account_id: '202',
          platform_account_login: 'pat-user',
          integration_status: 'suspended',
          updated_at: fixedUpdatedAt,
          metadata: { access_token: 'pat-secret', auth_type: 'pat' },
        },
      ])
      .returning();
    if (!oauthIntegration || !patIntegration) throw new Error('Expected integrations');

    const result = await runGitLabCredentialMigration();

    expect(result).toEqual({
      mode: 'audit',
      applied: false,
      scannedIntegrations: 2,
      mutatedIntegrations: 0,
      counts: {
        legacyTokenBearingIntegrations: 2,
        oauthMissingCredentials: 1,
        patMissingCredentials: 1,
        projectMissingCredentials: 1,
        credentialProfileMismatches: 0,
        providerMetadataMismatches: 0,
        crossTablePrimaryCredentialDuplicates: 0,
        malformedMetadata: 0,
        unmappableLegacyEntries: 0,
        integrationTypeDisagreements: 0,
        legacySecretFields: 6,
      },
      integrationIds: [oauthIntegration.id, patIntegration.id],
    });
    const rowsAfter = await db
      .select({ id: platform_integrations.id, updatedAt: platform_integrations.updated_at })
      .from(platform_integrations)
      .where(eq(platform_integrations.platform, 'gitlab'));
    expect(rowsAfter).toEqual([
      { id: oauthIntegration.id, updatedAt: expect.stringContaining('2026-07-01') },
      { id: patIntegration.id, updatedAt: expect.stringContaining('2026-07-01') },
    ]);
  });

  it('inserts a missing OAuth credential from freshly locked legacy metadata', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com/root';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        platform_account_id: '101',
        platform_account_login: 'oauth-user',
        integration_status: 'active',
        metadata: {
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          token_expires_at: '2030-01-01T00:00:00.000Z',
          client_id: 'oauth-client-id',
          client_secret: 'oauth-client-secret',
          gitlab_instance_url: providerBaseUrl,
          auth_type: 'oauth',
          webhook_secret: 'keep-webhook-secret',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');

    const result = await runGitLabCredentialMigration({
      mode: 'backfill',
      apply: true,
      batchSize: 1,
    });

    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    const [credential] = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
    if (!credential) throw new Error('Expected OAuth credential');

    expect(result.applied).toBe(true);
    expect(result.mutatedIntegrations).toBe(1);
    expect(updatedIntegration?.integration_type).toBe('oauth');
    expect(credential).toEqual(
      expect.objectContaining({
        authorized_by_user_id: user.id,
        provider_subject_id: '101',
        provider_subject_login: 'oauth-user',
        provider_base_url: providerBaseUrl,
        credential_version: 1,
      })
    );
    const privateKeys = {
      active: { keyId: TEST_KEY_ID, privateKeyPem: testKeyPair.privateKey },
    };
    const decrypt = (ciphertext: string, kind: 'access' | 'refresh' | 'oauth-client-secret') =>
      decryptKeyedEnvelope(
        ciphertext,
        GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        privateKeys,
        buildGitLabOAuthCredentialAad({
          credentialId: credential.id,
          integrationId: integration.id,
          providerBaseUrl,
          owner: { type: 'user', id: user.id },
          authorizedByUserId: user.id,
          credentialVersion: credential.credential_version,
          kind,
        })
      );
    expect(decrypt(credential.access_token_encrypted, 'access')).toBe('oauth-access-secret');
    if (!credential.refresh_token_encrypted || !credential.oauth_client_secret_encrypted) {
      throw new Error('Expected complete OAuth credential');
    }
    expect(decrypt(credential.refresh_token_encrypted, 'refresh')).toBe('oauth-refresh-secret');
    expect(decrypt(credential.oauth_client_secret_encrypted, 'oauth-client-secret')).toBe(
      'oauth-client-secret'
    );
  });

  it('backfills a personal access token with known legacy ownership and no fabricated evidence', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        platform_account_id: '202',
        platform_account_login: 'pat-user',
        scopes: ['api'],
        integration_status: 'suspended',
        metadata: {
          access_token: 'pat-secret',
          gitlab_instance_url: providerBaseUrl,
          auth_type: 'pat',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');

    await runGitLabCredentialMigration({ mode: 'backfill', apply: true });

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
    if (!credential) throw new Error('Expected PAT credential');
    expect(credential).toEqual(
      expect.objectContaining({
        expires_at: null,
        provider_credential_type: 'personal_access_token',
        provider_resource_id: null,
        provider_base_url: providerBaseUrl,
        authorized_by_user_id: user.id,
        provider_metadata: {},
        provider_scopes: ['api'],
        provider_verified_at: null,
        last_validated_at: null,
        credential_version: 1,
      })
    );
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId: TEST_KEY_ID, privateKeyPem: testKeyPair.privateKey } },
        buildGitLabPersonalAccessTokenAad({
          credentialId: credential.id,
          integrationId: integration.id,
          providerBaseUrl,
          owner: { type: 'user', id: user.id },
          authorizedByUserId: user.id,
          credentialVersion: 1,
        })
      )
    ).toBe('pat-secret');
  });

  it('backfills project tokens for a suspended integration without a primary token', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com/root';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_account_id: '303',
        platform_account_login: 'disconnected-user',
        integration_status: 'suspended',
        metadata: {
          gitlab_instance_url: providerBaseUrl,
          auth_type: 'oauth',
          project_tokens: {
            '42': {
              token_id: 99,
              token: 'project-secret',
              expires_at: '2030-06-01',
              created_at: '2026-07-01T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');

    await runGitLabCredentialMigration({ mode: 'backfill', apply: true });

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
    if (!credential) throw new Error('Expected project credential');
    expect(credential).toEqual(
      expect.objectContaining({
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: providerBaseUrl,
        authorized_by_user_id: null,
        provider_metadata: { providerCredentialId: '99', expiresOn: '2030-06-01' },
        provider_scopes: null,
        provider_verified_at: null,
        last_validated_at: null,
        credential_version: 1,
      })
    );
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId: TEST_KEY_ID, privateKeyPem: testKeyPair.privateKey } },
        buildGitLabProjectAccessTokenAad({
          credentialId: credential.id,
          integrationId: integration.id,
          providerBaseUrl,
          owner: { type: 'user', id: user.id },
          providerResourceId: '42',
          credentialVersion: 1,
        })
      )
    ).toBe('project-secret');
  });

  it('scrubs only migrated legacy secret fields and preserves GitLab configuration', async () => {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_account_id: '404',
        platform_account_login: 'oauth-user',
        integration_status: 'active',
        metadata: {
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          token_expires_at: '2030-01-01T00:00:00.000Z',
          client_id: 'custom-client-id',
          client_secret: 'oauth-client-secret',
          gitlab_instance_url: 'https://gitlab.example.com',
          auth_type: 'oauth',
          webhook_secret: 'keep-webhook-secret',
          configured_webhooks: { '42': { hook_id: 7 } },
          notes: 'keep-non-secret-metadata',
          project_tokens: {
            '42': {
              token_id: 99,
              token: 'project-secret',
              expires_at: '2030-06-01',
              created_at: '2026-07-01T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');
    await runGitLabCredentialMigration({ mode: 'backfill', apply: true });

    const result = await runGitLabCredentialMigration({
      mode: 'scrub',
      apply: true,
      privateAuditPassed: true,
    });

    const [scrubbed] = await db
      .select({ metadata: platform_integrations.metadata })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(result.applied).toBe(true);
    expect(result.mutatedIntegrations).toBe(1);
    expect(scrubbed?.metadata).toEqual({
      client_id: 'custom-client-id',
      gitlab_instance_url: 'https://gitlab.example.com',
      auth_type: 'oauth',
      webhook_secret: 'keep-webhook-secret',
      configured_webhooks: { '42': { hook_id: 7 } },
      notes: 'keep-non-secret-metadata',
    });
    const auditAfter = await runGitLabCredentialMigration();
    expect(auditAfter.counts.legacySecretFields).toBe(0);
    expect(auditAfter.counts.legacyTokenBearingIntegrations).toBe(0);
    expect(auditAfter.counts.unmappableLegacyEntries).toBe(0);
  });

  it('audits provider metadata separately from parent credential-profile mismatches', async () => {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        platform_account_id: '505',
        platform_account_login: 'pat-user',
        integration_status: 'active',
        metadata: {
          access_token: 'pat-secret',
          gitlab_instance_url: 'https://gitlab.example.com',
          auth_type: 'pat',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: integration.id,
      token_encrypted: 'persisted-envelope',
      provider_credential_type: 'personal_access_token',
      provider_resource_id: null,
      provider_base_url: 'https://other-gitlab.example.com',
      authorized_by_user_id: null,
      provider_metadata: { expiresOn: 'not-a-date' },
    });

    const result = await runGitLabCredentialMigration();

    expect(result.counts.patMissingCredentials).toBe(0);
    expect(result.counts.credentialProfileMismatches).toBe(1);
    expect(result.counts.providerMetadataMismatches).toBe(1);
    expect(result.integrationIds).toEqual([integration.id]);
  });

  it('accepts non-null supplying users on organization OAuth and PAT credentials', async () => {
    const user = await insertTestUser();
    const oauthOrganization = await createTestOrganization('OAuth Organization', user.id, 0);
    const patOrganization = await createTestOrganization('PAT Organization', user.id, 0);
    const providerBaseUrl = 'https://gitlab.example.com';
    const [oauthIntegration, patIntegration] = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_organization_id: oauthOrganization.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_account_id: '551',
          platform_account_login: 'oauth-user',
          metadata: {
            access_token: 'oauth-access-secret',
            refresh_token: 'oauth-refresh-secret',
            gitlab_instance_url: providerBaseUrl,
            auth_type: 'oauth',
          },
        },
        {
          owned_by_organization_id: patOrganization.id,
          platform: 'gitlab',
          integration_type: 'pat',
          platform_account_id: '552',
          platform_account_login: 'pat-user',
          metadata: {
            access_token: 'pat-secret',
            gitlab_instance_url: providerBaseUrl,
            auth_type: 'pat',
          },
        },
      ])
      .returning();
    if (!oauthIntegration || !patIntegration) throw new Error('Expected integrations');
    await db.insert(platform_oauth_credentials).values({
      platform_integration_id: oauthIntegration.id,
      authorized_by_user_id: user.id,
      provider_subject_id: '551',
      provider_subject_login: 'oauth-user',
      provider_base_url: providerBaseUrl,
      access_token_encrypted: 'oauth-envelope',
      refresh_token_encrypted: 'refresh-envelope',
    });
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: patIntegration.id,
      token_encrypted: 'pat-envelope',
      provider_credential_type: 'personal_access_token',
      provider_resource_id: null,
      provider_base_url: providerBaseUrl,
      authorized_by_user_id: user.id,
      provider_metadata: {},
    });

    const audit = await runGitLabCredentialMigration();

    expect(audit.counts.credentialProfileMismatches).toBe(0);
    expect(audit.counts.providerMetadataMismatches).toBe(0);
    expect(audit.integrationIds).toEqual([]);
  });

  it('reports duplicate OAuth and PAT primary credentials without mutating either', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_account_id: '606',
        platform_account_login: 'oauth-user',
        integration_status: 'active',
        metadata: {
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          gitlab_instance_url: providerBaseUrl,
          auth_type: 'oauth',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');
    await db.insert(platform_oauth_credentials).values({
      platform_integration_id: integration.id,
      authorized_by_user_id: user.id,
      provider_subject_id: '606',
      provider_subject_login: 'oauth-user',
      provider_base_url: providerBaseUrl,
      access_token_encrypted: 'oauth-envelope',
      refresh_token_encrypted: 'refresh-envelope',
    });
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: integration.id,
      token_encrypted: 'pat-envelope',
      provider_credential_type: 'personal_access_token',
      provider_resource_id: null,
      provider_base_url: providerBaseUrl,
      authorized_by_user_id: user.id,
      provider_metadata: {},
    });

    const audit = await runGitLabCredentialMigration();
    expect(audit.counts.crossTablePrimaryCredentialDuplicates).toBe(1);
    const oauthBefore = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));

    const backfill = await runGitLabCredentialMigration({ mode: 'backfill', apply: true });
    expect(backfill.mutatedIntegrations).toBe(0);
    await expect(
      db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integration.id))
    ).resolves.toEqual(oauthBefore);
  });

  it('reports legacy OAuth tokens without provider identity as unmappable', async () => {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        integration_status: 'suspended',
        metadata: {
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          auth_type: 'oauth',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');

    const audit = await runGitLabCredentialMigration();

    expect(audit.counts.oauthMissingCredentials).toBe(1);
    expect(audit.counts.unmappableLegacyEntries).toBe(1);
    expect(audit.integrationIds).toEqual([integration.id]);
  });

  it('requires an explicit passing private-key audit assertion before scrub', async () => {
    await expect(
      runGitLabCredentialMigration({
        mode: 'scrub',
        apply: true,
      })
    ).rejects.toThrow('private-key audit assertion');
  });

  it('reports an unpaired self-hosted OAuth client credential as unmappable', async () => {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'oauth',
        platform_account_id: '650',
        platform_account_login: 'oauth-user',
        metadata: {
          access_token: 'oauth-access-secret',
          refresh_token: 'oauth-refresh-secret',
          client_secret: 'unpaired-client-secret',
          auth_type: 'oauth',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');

    const audit = await runGitLabCredentialMigration();

    expect(audit.counts.unmappableLegacyEntries).toBe(1);
    expect(audit.integrationIds).toEqual([integration.id]);
  });

  it('keeps backfill read-only without --apply', async () => {
    const user = await insertTestUser();
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        platform_account_id: '707',
        platform_account_login: 'pat-user',
        metadata: { access_token: 'pat-secret', auth_type: 'pat' },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');

    const result = await runGitLabCredentialMigration({ mode: 'backfill' });

    expect(result.applied).toBe(false);
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(eq(platform_access_token_credentials.platform_integration_id, integration.id))
    ).resolves.toEqual([]);
  });

  it('never updates an existing encrypted row when legacy metadata differs', async () => {
    const user = await insertTestUser();
    const providerBaseUrl = 'https://gitlab.example.com';
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: user.id,
        platform: 'gitlab',
        integration_type: 'pat',
        platform_account_id: '808',
        platform_account_login: 'pat-user',
        metadata: {
          access_token: 'old-pat-secret',
          gitlab_instance_url: providerBaseUrl,
          auth_type: 'pat',
        },
      })
      .returning();
    if (!integration) throw new Error('Expected integration');
    await runGitLabCredentialMigration({ mode: 'backfill', apply: true });
    const [firstCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
    if (!firstCredential) throw new Error('Expected first credential');
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          access_token: 'new-pat-secret',
          gitlab_instance_url: providerBaseUrl,
          auth_type: 'pat',
        },
      })
      .where(eq(platform_integrations.id, integration.id));

    await runGitLabCredentialMigration({ mode: 'backfill', apply: true });

    const [unchanged] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
    if (!unchanged) throw new Error('Expected encrypted credential');
    expect(unchanged).toEqual(firstCredential);
    expect(
      decryptKeyedEnvelope(
        unchanged.token_encrypted,
        GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId: TEST_KEY_ID, privateKeyPem: testKeyPair.privateKey } },
        buildGitLabPersonalAccessTokenAad({
          credentialId: unchanged.id,
          integrationId: integration.id,
          providerBaseUrl,
          owner: { type: 'user', id: user.id },
          authorizedByUserId: user.id,
          credentialVersion: 1,
        })
      )
    ).toBe('old-pat-secret');
  });
});
