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
import {
  backfillGitLabCredentialBatch,
  backfillGitLabIntegration,
  scrubGitLabCredentialBatch,
  scrubGitLabIntegration,
} from './credential-migration';
import {
  selectGitLabIntegrationsNeedingBackfill,
  selectGitLabIntegrationsNeedingScrub,
} from './credential-migration-selection';

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

const activePrivateKeys = () => ({
  active: { keyId: TEST_KEY_ID, privateKeyPem: testKeyPair.privateKey },
});

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

  describe('selection', () => {
    it('selects only GitLab integrations that still carry plaintext with no encrypted row', async () => {
      const user = await insertTestUser();
      const [oauth, pat, done, bitbucket] = await db
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
            metadata: {
              access_token: 'oauth-access-secret',
              refresh_token: 'oauth-refresh-secret',
              auth_type: 'oauth',
            },
          },
          {
            id: '00000000-0000-4000-8000-000000000002',
            owned_by_user_id: user.id,
            platform: 'gitlab',
            integration_type: 'pat',
            metadata: { access_token: 'pat-secret', auth_type: 'pat' },
          },
          {
            id: '00000000-0000-4000-8000-000000000003',
            owned_by_user_id: user.id,
            platform: 'gitlab',
            integration_type: 'pat',
            metadata: { access_token: 'already-migrated', auth_type: 'pat' },
          },
          {
            id: '00000000-0000-4000-8000-000000000004',
            owned_by_user_id: user.id,
            platform: 'bitbucket',
            integration_type: 'oauth',
            metadata: { access_token: 'bitbucket-secret' },
          },
        ])
        .returning();
      if (!oauth || !pat || !done || !bitbucket) throw new Error('Expected integrations');
      // `done` already has its encrypted primary row → excluded.
      await db.insert(platform_access_token_credentials).values({
        platform_integration_id: done.id,
        token_encrypted: 'existing-envelope',
        provider_credential_type: 'personal_access_token',
        provider_resource_id: null,
        provider_base_url: 'https://gitlab.example.com',
        authorized_by_user_id: user.id,
        provider_metadata: {},
      });

      const ids = await selectGitLabIntegrationsNeedingBackfill(100, null);

      expect(ids).toEqual([oauth.id, pat.id]);
    });

    it('selects integrations missing only a project-token credential', async () => {
      const user = await insertTestUser();
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'pat',
          platform_account_id: '202',
          platform_account_login: 'pat-user',
          metadata: {
            gitlab_instance_url: 'https://gitlab.example.com',
            auth_type: 'pat',
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

      expect(await selectGitLabIntegrationsNeedingBackfill(100, null)).toEqual([integration.id]);

      await db.insert(platform_access_token_credentials).values({
        platform_integration_id: integration.id,
        token_encrypted: 'project-envelope',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: 'https://gitlab.example.com',
        authorized_by_user_id: null,
        provider_metadata: { providerCredentialId: '99', expiresOn: '2030-06-01' },
      });

      expect(await selectGitLabIntegrationsNeedingBackfill(100, null)).toEqual([]);
    });

    it('paginates deterministically by id without repeating integrations', async () => {
      const user = await insertTestUser();
      await db.insert(platform_integrations).values([
        {
          id: '00000000-0000-4000-8000-000000000007',
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'pat',
          metadata: { auth_type: 'pat', access_token: 'first-secret' },
        },
        {
          id: '00000000-0000-4000-8000-000000000008',
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'pat',
          metadata: { auth_type: 'pat', access_token: 'second-secret' },
        },
      ]);

      const first = await selectGitLabIntegrationsNeedingBackfill(1, null);
      const second = await selectGitLabIntegrationsNeedingBackfill(1, first[0] ?? null);
      const third = await selectGitLabIntegrationsNeedingBackfill(1, second[0] ?? null);

      expect(first).toEqual(['00000000-0000-4000-8000-000000000007']);
      expect(second).toEqual(['00000000-0000-4000-8000-000000000008']);
      expect(third).toEqual([]);
    });
  });

  describe('backfillGitLabIntegration', () => {
    it('falls back to the integration type when legacy OAuth metadata omits auth_type', async () => {
      const user = await insertTestUser();
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_account_id: '100',
          platform_account_login: 'legacy-oauth-user',
          integration_status: 'active',
          metadata: {
            access_token: 'legacy-access-secret',
            refresh_token: 'legacy-refresh-secret',
            token_expires_at: '2030-01-01T00:00:00.000Z',
          },
        })
        .returning();
      if (!integration) throw new Error('Expected integration');

      expect(await backfillGitLabIntegration(integration.id)).toEqual({ mutated: true });

      const [credential] = await db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
      expect(credential).toEqual(
        expect.objectContaining({
          provider_subject_id: '100',
          provider_subject_login: 'legacy-oauth-user',
          refresh_token_encrypted: expect.any(String),
        })
      );

      expect(await scrubGitLabIntegration(integration.id)).toEqual({
        scrubbed: true,
        skipped: false,
      });
      const [scrubbed] = await db
        .select({ metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(scrubbed?.metadata).toEqual({});
    });

    it('inserts a decryptable OAuth credential and aligns the integration type', async () => {
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

      const outcome = await backfillGitLabIntegration(integration.id);

      expect(outcome).toEqual({ mutated: true });
      const [updatedIntegration] = await db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(updatedIntegration?.integration_type).toBe('oauth');
      const [credential] = await db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));
      if (!credential) throw new Error('Expected OAuth credential');
      expect(credential).toEqual(
        expect.objectContaining({
          authorized_by_user_id: user.id,
          provider_subject_id: '101',
          provider_subject_login: 'oauth-user',
          provider_base_url: providerBaseUrl,
          credential_version: 1,
        })
      );
      const decrypt = (ciphertext: string, kind: 'access' | 'refresh' | 'oauth-client-secret') =>
        decryptKeyedEnvelope(
          ciphertext,
          GITLAB_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
          activePrivateKeys(),
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

    it('backfills a personal access token with legacy ownership', async () => {
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

      expect(await backfillGitLabIntegration(integration.id)).toEqual({ mutated: true });

      const [credential] = await db
        .select()
        .from(platform_access_token_credentials)
        .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
      if (!credential) throw new Error('Expected PAT credential');
      expect(credential).toEqual(
        expect.objectContaining({
          provider_credential_type: 'personal_access_token',
          provider_resource_id: null,
          provider_base_url: providerBaseUrl,
          authorized_by_user_id: user.id,
          provider_metadata: {},
          provider_scopes: ['api'],
          credential_version: 1,
        })
      );
      expect(
        decryptKeyedEnvelope(
          credential.token_encrypted,
          GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
          activePrivateKeys(),
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

    it('backfills project tokens for an integration without a primary token', async () => {
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

      expect(await backfillGitLabIntegration(integration.id)).toEqual({ mutated: true });

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
          credential_version: 1,
        })
      );
      expect(
        decryptKeyedEnvelope(
          credential.token_encrypted,
          GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
          activePrivateKeys(),
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

    it('is idempotent and never rewrites an existing encrypted row', async () => {
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
      await backfillGitLabIntegration(integration.id);
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

      // Row already exists → nothing left to backfill and the row is untouched.
      expect(await selectGitLabIntegrationsNeedingBackfill(100, null)).toEqual([]);
      expect(await backfillGitLabIntegration(integration.id)).toEqual({ mutated: false });
      const [unchanged] = await db
        .select()
        .from(platform_access_token_credentials)
        .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));
      expect(unchanged).toEqual(firstCredential);
    });

    it('reports conflicting OAuth and PAT primary credentials as unmappable without mutating', async () => {
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
      const oauthBefore = await db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.platform_integration_id, integration.id));

      expect(await backfillGitLabIntegration(integration.id)).toEqual({ mutated: false });
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

      expect(await backfillGitLabIntegration(integration.id)).toEqual({ mutated: false });
      await expect(
        db
          .select()
          .from(platform_oauth_credentials)
          .where(eq(platform_oauth_credentials.platform_integration_id, integration.id))
      ).resolves.toEqual([]);
    });
  });

  describe('scrub', () => {
    it('never selects an integration whose backfill is incomplete', async () => {
      const user = await insertTestUser();
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'pat',
          platform_account_id: '404',
          platform_account_login: 'pat-user',
          metadata: {
            access_token: 'pat-secret',
            gitlab_instance_url: 'https://gitlab.example.com',
            auth_type: 'pat',
          },
        })
        .returning();
      if (!integration) throw new Error('Expected integration');

      // Plaintext present but no encrypted row yet → must not be scrubbed.
      expect(await selectGitLabIntegrationsNeedingScrub(100, null)).toEqual([]);

      await backfillGitLabIntegration(integration.id);

      expect(await selectGitLabIntegrationsNeedingScrub(100, null)).toEqual([integration.id]);
    });

    it('removes only migrated secret fields and preserves GitLab configuration', async () => {
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
      await backfillGitLabIntegration(integration.id);

      expect(await scrubGitLabIntegration(integration.id)).toEqual({
        scrubbed: true,
        skipped: false,
      });

      const [scrubbed] = await db
        .select({ metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(scrubbed?.metadata).toEqual({
        client_id: 'custom-client-id',
        gitlab_instance_url: 'https://gitlab.example.com',
        auth_type: 'oauth',
        webhook_secret: 'keep-webhook-secret',
        configured_webhooks: { '42': { hook_id: 7 } },
        notes: 'keep-non-secret-metadata',
      });
      // Fully scrubbed → nothing left for either selector.
      expect(await selectGitLabIntegrationsNeedingScrub(100, null)).toEqual([]);
      expect(await selectGitLabIntegrationsNeedingBackfill(100, null)).toEqual([]);
    });

    it('skips scrub when an encrypted row has a profile mismatch', async () => {
      const user = await insertTestUser();
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'pat',
          platform_account_id: '505',
          platform_account_login: 'pat-user',
          metadata: {
            access_token: 'pat-secret',
            gitlab_instance_url: 'https://gitlab.example.com',
            auth_type: 'pat',
          },
        })
        .returning();
      if (!integration) throw new Error('Expected integration');
      // Encrypted row exists but its provider_base_url disagrees with the integration.
      await db.insert(platform_access_token_credentials).values({
        platform_integration_id: integration.id,
        token_encrypted: 'persisted-envelope',
        provider_credential_type: 'personal_access_token',
        provider_resource_id: null,
        provider_base_url: 'https://other-gitlab.example.com',
        authorized_by_user_id: user.id,
        provider_metadata: {},
      });

      const before = await db
        .select({ metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));

      expect(await scrubGitLabIntegration(integration.id)).toEqual({
        scrubbed: false,
        skipped: true,
      });
      const after = await db
        .select({ metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(after).toEqual(before);
    });

    it('skips scrub when OAuth plaintext fields lack encrypted counterparts', async () => {
      const user = await insertTestUser();
      const providerBaseUrl = 'https://gitlab.example.com';
      const [integration] = await db
        .insert(platform_integrations)
        .values({
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          platform_account_id: '707',
          platform_account_login: 'oauth-user',
          metadata: {
            access_token: 'stale-access-secret',
            refresh_token: 'unmigrated-refresh-secret',
            token_expires_at: '2030-01-01T00:00:00.000Z',
            client_id: 'custom-client-id',
            client_secret: 'unmigrated-client-secret',
            gitlab_instance_url: providerBaseUrl,
            auth_type: 'oauth',
          },
        })
        .returning();
      if (!integration) throw new Error('Expected integration');
      await db.insert(platform_oauth_credentials).values({
        platform_integration_id: integration.id,
        authorized_by_user_id: user.id,
        provider_subject_id: '707',
        provider_subject_login: 'oauth-user',
        provider_base_url: providerBaseUrl,
        access_token_encrypted: 'newer-access-envelope',
        refresh_token_encrypted: null,
        oauth_client_secret_encrypted: null,
      });

      expect(await scrubGitLabIntegration(integration.id)).toEqual({
        scrubbed: false,
        skipped: true,
      });
      const [scrubbed] = await db
        .select({ metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, integration.id));
      expect(scrubbed?.metadata).toEqual({
        access_token: 'stale-access-secret',
        refresh_token: 'unmigrated-refresh-secret',
        token_expires_at: '2030-01-01T00:00:00.000Z',
        client_id: 'custom-client-id',
        client_secret: 'unmigrated-client-secret',
        gitlab_instance_url: providerBaseUrl,
        auth_type: 'oauth',
      });
    });
  });

  describe('batch helpers', () => {
    it('backfillGitLabCredentialBatch reports outcomes and a keyset cursor', async () => {
      const user = await insertTestUser();
      await db.insert(platform_integrations).values([
        {
          id: '00000000-0000-4000-8000-0000000000a1',
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'pat',
          platform_account_id: '1',
          platform_account_login: 'a',
          metadata: {
            access_token: 'secret-a',
            gitlab_instance_url: 'https://gitlab.example.com',
            auth_type: 'pat',
          },
        },
        {
          // Unmappable: OAuth material without provider identity.
          id: '00000000-0000-4000-8000-0000000000a2',
          owned_by_user_id: user.id,
          platform: 'gitlab',
          integration_type: 'oauth',
          metadata: {
            access_token: 'secret-b',
            refresh_token: 'refresh-b',
            auth_type: 'oauth',
          },
        },
      ]);

      const first = await backfillGitLabCredentialBatch({ limit: 1, afterId: null });
      expect(first).toEqual({
        processed: 1,
        mutated: 1,
        unmappable: 0,
        nextCursor: '00000000-0000-4000-8000-0000000000a1',
      });
      const second = await backfillGitLabCredentialBatch({ limit: 1, afterId: first.nextCursor });
      expect(second).toEqual({
        processed: 1,
        mutated: 0,
        unmappable: 1,
        nextCursor: '00000000-0000-4000-8000-0000000000a2',
      });
      const third = await backfillGitLabCredentialBatch({ limit: 1, afterId: second.nextCursor });
      expect(third).toEqual({ processed: 0, mutated: 0, unmappable: 0, nextCursor: null });
    });

    it('scrubGitLabCredentialBatch scrubs fully-backfilled integrations only', async () => {
      const user = await insertTestUser();
      const [ready, notReady] = await db
        .insert(platform_integrations)
        .values([
          {
            id: '00000000-0000-4000-8000-0000000000b1',
            owned_by_user_id: user.id,
            platform: 'gitlab',
            integration_type: 'pat',
            platform_account_id: '1',
            platform_account_login: 'ready',
            metadata: {
              access_token: 'ready-secret',
              gitlab_instance_url: 'https://gitlab.example.com',
              auth_type: 'pat',
            },
          },
          {
            id: '00000000-0000-4000-8000-0000000000b2',
            owned_by_user_id: user.id,
            platform: 'gitlab',
            integration_type: 'pat',
            platform_account_id: '2',
            platform_account_login: 'not-ready',
            metadata: {
              access_token: 'not-ready-secret',
              gitlab_instance_url: 'https://gitlab.example.com',
              auth_type: 'pat',
            },
          },
        ])
        .returning();
      if (!ready || !notReady) throw new Error('Expected integrations');
      await backfillGitLabIntegration(ready.id); // notReady deliberately left un-backfilled

      const result = await scrubGitLabCredentialBatch({ limit: 100, afterId: null });

      expect(result).toEqual({ processed: 1, scrubbed: 1, skipped: 0, nextCursor: null });
      const [readyAfter] = await db
        .select({ metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, ready.id));
      const [notReadyAfter] = await db
        .select({ metadata: platform_integrations.metadata })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, notReady.id));
      expect(readyAfter?.metadata).not.toHaveProperty('access_token');
      expect(notReadyAfter?.metadata).toHaveProperty('access_token', 'not-ready-secret');
    });
  });
});
