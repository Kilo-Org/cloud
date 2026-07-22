/* eslint-disable drizzle/enforce-delete-with-where */
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import {
  kilocode_users,
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { and, eq, isNull } from 'drizzle-orm';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
} from '@kilocode/worker-utils/gitlab-credential';
import type * as GitLabAdapter from '@/lib/integrations/platforms/gitlab/adapter';
import type * as GitLabService from './gitlab-service';
import type { fetchGitLabCredential as FetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';

const mockValidatePersonalAccessToken = jest.fn<typeof GitLabAdapter.validatePersonalAccessToken>();
const mockFetchGitLabProjects = jest.fn<typeof GitLabAdapter.fetchGitLabProjects>();
const mockCreateProjectAccessToken = jest.fn<typeof GitLabAdapter.createProjectAccessToken>();
const mockRotateProjectAccessToken = jest.fn<typeof GitLabAdapter.rotateProjectAccessToken>();
const mockValidateProjectAccessToken = jest.fn<typeof GitLabAdapter.validateProjectAccessToken>();
const mockRevokeProjectAccessToken = jest.fn<typeof GitLabAdapter.revokeProjectAccessToken>();
const mockFetchGitLabCredential = jest.fn<typeof FetchGitLabCredential>();
const mockResetCodeReviewConfigForOwner = jest.fn<() => Promise<void>>();

jest.mock('@/lib/integrations/platforms/gitlab/adapter', () => ({
  ...jest.requireActual<typeof GitLabAdapter>('@/lib/integrations/platforms/gitlab/adapter'),
  validatePersonalAccessToken: mockValidatePersonalAccessToken,
  fetchGitLabProjects: mockFetchGitLabProjects,
  createProjectAccessToken: mockCreateProjectAccessToken,
  rotateProjectAccessToken: mockRotateProjectAccessToken,
  validateProjectAccessToken: mockValidateProjectAccessToken,
  revokeProjectAccessToken: mockRevokeProjectAccessToken,
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  resetCodeReviewConfigForOwner: mockResetCodeReviewConfigForOwner,
}));

jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: mockFetchGitLabCredential,
}));

const KEY_ID = 'gitlab-service-test-key';
const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

jest.mock('@/lib/config.server', () => ({
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: KEY_ID,
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(keyPair.publicKey).toString('base64'),
}));

let connectWithPAT: typeof GitLabService.connectWithPAT;
let getValidGitLabToken: typeof GitLabService.getValidGitLabToken;
let getValidGitLabProjectAccessToken: typeof GitLabService.getValidGitLabProjectAccessToken;
let getOrCreateProjectAccessToken: typeof GitLabService.getOrCreateProjectAccessToken;
let removeStoredProjectAccessToken: typeof GitLabService.removeStoredProjectAccessToken;
let disconnectGitLabIntegration: typeof GitLabService.disconnectGitLabIntegration;

const validationResult = {
  valid: true,
  user: {
    id: 123,
    username: 'gitlab-user',
    name: 'GitLab User',
    email: 'gitlab-user@example.com',
    avatar_url: 'https://gitlab.com/avatar.png',
    web_url: 'https://gitlab.com/gitlab-user',
  },
  tokenInfo: {
    id: 456,
    name: 'Kilo PAT',
    scopes: ['api'],
    expiresAt: '2027-07-13',
    active: true,
    lastUsedAt: null,
  },
};

describe('GitLab encrypted credential persistence', () => {
  beforeAll(async () => {
    ({
      connectWithPAT,
      getValidGitLabToken,
      getValidGitLabProjectAccessToken,
      getOrCreateProjectAccessToken,
      removeStoredProjectAccessToken,
      disconnectGitLabIntegration,
    } = await import('./gitlab-service'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockValidatePersonalAccessToken.mockResolvedValue(validationResult);
    mockFetchGitLabProjects.mockResolvedValue([]);
    mockCreateProjectAccessToken.mockResolvedValue({
      id: 777,
      name: 'Kilo Code Review Bot',
      token: 'glpat-created-project-token',
      expires_at: '2027-07-13',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      active: true,
      revoked: false,
      created_at: '2026-07-13T00:00:00.000Z',
      last_used_at: null,
      user_id: 123,
    });
    mockRotateProjectAccessToken.mockResolvedValue({
      id: 778,
      name: 'Kilo Code Review Bot',
      token: 'glpat-rotated-project-token',
      expires_at: '2027-07-13',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      active: true,
      revoked: false,
      created_at: '2026-07-13T00:00:00.000Z',
      last_used_at: null,
      user_id: 123,
    });
    mockValidateProjectAccessToken.mockResolvedValue(true);
    mockRevokeProjectAccessToken.mockResolvedValue();
    mockFetchGitLabCredential.mockImplementation(async (_actor, selector) => ({
      status: 'available' as const,
      token:
        selector.credential === 'integration'
          ? 'glpat-primary-token'
          : 'glpat-created-project-token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: false,
    }));
    mockResetCodeReviewConfigForOwner.mockResolvedValue();
  });

  afterEach(async () => {
    await db.delete(platform_oauth_credentials);
    await db.delete(platform_access_token_credentials);
    await db.delete(platform_integrations);
    await db.delete(kilocode_users);
  });

  it('stores a new personal PAT only in its encrypted row with supplier evidence', async () => {
    const user = await insertTestUser();
    const plaintextToken = 'glpat-new-personal-token';

    const result = await connectWithPAT(
      { type: 'user', id: user.id },
      plaintextToken,
      'https://GitLab.COM/',
      user.id
    );

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, result.integration.id));
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, result.integration.id));

    expect(integration).toEqual(
      expect.objectContaining({
        owned_by_user_id: user.id,
        integration_type: 'pat',
        metadata: expect.objectContaining({
          gitlab_instance_url: 'https://gitlab.com',
          auth_type: 'pat',
        }),
      })
    );
    expect(integration.metadata).not.toHaveProperty('access_token');
    expect(credential).toEqual(
      expect.objectContaining({
        provider_credential_type: 'personal_access_token',
        provider_resource_id: null,
        provider_base_url: 'https://gitlab.com',
        authorized_by_user_id: user.id,
        provider_metadata: {
          providerCredentialId: '456',
          expiresOn: '2027-07-13',
        },
        provider_scopes: ['api'],
        credential_version: 1,
        provider_verified_at: expect.any(String),
        last_validated_at: expect.any(String),
      })
    );
    expect(credential.token_encrypted).not.toContain(plaintextToken);
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId: KEY_ID, privateKeyPem: keyPair.privateKey } },
        buildGitLabPersonalAccessTokenAad({
          credentialId: credential.id,
          integrationId: integration.id,
          providerBaseUrl: 'https://gitlab.com',
          owner: { type: 'user', id: user.id },
          authorizedByUserId: user.id,
          credentialVersion: 1,
        })
      )
    ).toBe(plaintextToken);
    expect(
      await db
        .select()
        .from(platform_access_token_credentials)
        .where(isNull(platform_access_token_credentials.provider_resource_id))
    ).toHaveLength(1);
  });

  it('stores PAT and project tokens only in encrypted rows', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });

    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );

    expect(updatedIntegration.metadata).not.toHaveProperty('access_token');
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
    expect(credentials).toEqual([
      expect.objectContaining({
        provider_credential_type: 'personal_access_token',
        token_encrypted: expect.any(String),
      }),
      expect.objectContaining({
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        token_encrypted: expect.any(String),
      }),
    ]);
  });

  it('creates a new project credential when only stale legacy metadata remains', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    // Stale plaintext left behind from before the credential-encryption
    // migration's scrub ran. There is no encrypted row for this project, so
    // it must never be trusted or reused.
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(integration.metadata as Record<string, unknown>),
          project_tokens: {
            '42': {
              token_id: 991,
              token: 'glpat-legacy-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, integration.id));
    const [integrationWithStaleMetadata] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));

    await expect(
      getOrCreateProjectAccessToken(integrationWithStaleMetadata, 42, { userId: user.id })
    ).resolves.toBe('glpat-created-project-token');
    expect(mockCreateProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(mockFetchGitLabCredential).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ credential: 'project-exact' })
    );
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(eq(platform_access_token_credentials.provider_resource_id, '42'))
    ).resolves.toEqual([
      expect.objectContaining({
        provider_resource_id: '42',
        token_encrypted: expect.any(String),
      }),
    ]);
  });

  it('no-ops removal when only stale legacy metadata remains and no encrypted row exists', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(integration.metadata as Record<string, unknown>),
          project_tokens: {
            '42': {
              token_id: 991,
              token: 'glpat-legacy-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, integration.id));
    const [integrationWithStaleMetadata] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));

    await removeStoredProjectAccessToken(integrationWithStaleMetadata, 42, { userId: user.id });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updatedIntegration.metadata).toEqual(
      expect.objectContaining({
        project_tokens: { '42': expect.objectContaining({ token_id: 991 }) },
      })
    );
  });

  it.each([
    [
      'integration',
      (integration: PlatformIntegration, userId: string) =>
        getValidGitLabToken(integration, { userId }),
    ],
    [
      'project',
      (integration: PlatformIntegration, userId: string) =>
        getValidGitLabProjectAccessToken(integration, 42, { userId }),
    ],
  ])('rejects a %s credential resolved for a different GitLab instance', async (_kind, resolve) => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockFetchGitLabCredential.mockResolvedValueOnce({
      status: 'available',
      token: 'must-not-be-returned',
      instanceUrl: 'https://other-gitlab.example.com',
      glabIsOAuth2: false,
    });

    await expect(resolve(integration, user.id)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'GitLab integration changed while resolving credentials',
    });
  });

  it('replaces a same-instance PAT in the stable row and preserves project credentials', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    const [initialCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, initial.integration.id));
    const [initialIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    const legacyProjectToken = {
      token_id: 999,
      token: 'glpat-project-token',
      expires_at: '2027-07-13',
      created_at: '2026-07-13T00:00:00.000Z',
      name: 'Kilo Code Review Bot',
    };

    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(initialIntegration.metadata as Record<string, unknown>),
          project_tokens: { '99': legacyProjectToken },
        },
      })
      .where(eq(platform_integrations.id, initial.integration.id));
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: initial.integration.id,
      token_encrypted: 'encrypted-project-token',
      provider_credential_type: 'project_access_token',
      provider_resource_id: '99',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: {
        providerCredentialId: '999',
        expiresOn: '2027-07-13',
      },
      provider_scopes: ['api'],
    });
    await db.insert(platform_oauth_credentials).values({
      platform_integration_id: initial.integration.id,
      authorized_by_user_id: user.id,
      provider_subject_id: '123',
      provider_subject_login: 'gitlab-user',
      provider_base_url: 'https://gitlab.com',
      access_token_encrypted: 'obsolete-oauth-token',
    });

    const replacementToken = 'glpat-replacement-token';
    await connectWithPAT(
      { type: 'user', id: user.id },
      replacementToken,
      'https://gitlab.com/',
      user.id
    );

    const [primaryCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
          isNull(platform_access_token_credentials.provider_resource_id)
        )
      );
    const [projectCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '99'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    const oauthCredentials = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, initial.integration.id));

    expect(primaryCredential.id).toBe(initialCredential.id);
    expect(primaryCredential.credential_version).toBe(2);
    expect(
      decryptKeyedEnvelope(
        primaryCredential.token_encrypted,
        GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId: KEY_ID, privateKeyPem: keyPair.privateKey } },
        buildGitLabPersonalAccessTokenAad({
          credentialId: primaryCredential.id,
          integrationId: initial.integration.id,
          providerBaseUrl: 'https://gitlab.com',
          owner: { type: 'user', id: user.id },
          authorizedByUserId: user.id,
          credentialVersion: 2,
        })
      )
    ).toBe(replacementToken);
    expect(projectCredential).toBeDefined();
    expect(updatedIntegration.metadata).toEqual(
      expect.objectContaining({
        project_tokens: { '99': legacyProjectToken },
      })
    );
    expect(updatedIntegration.metadata).not.toHaveProperty('access_token');
    expect(oauthCredentials).toHaveLength(0);
  });

  it('drops project credentials when a PAT reconnect changes GitLab instance', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    const [initialCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, initial.integration.id));
    const [initialIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));

    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(initialIntegration.metadata as Record<string, unknown>),
          project_tokens: {
            '99': {
              token_id: 999,
              token: 'glpat-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, initial.integration.id));
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: initial.integration.id,
      token_encrypted: 'encrypted-project-token',
      provider_credential_type: 'project_access_token',
      provider_resource_id: '99',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: {
        providerCredentialId: '999',
        expiresOn: '2027-07-13',
      },
    });

    await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    );

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, initial.integration.id));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));

    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual(
      expect.objectContaining({
        id: initialCredential.id,
        provider_resource_id: null,
        provider_base_url: 'https://self.gitlab.example',
        credential_version: 2,
      })
    );
    expect(updatedIntegration.metadata).toEqual(
      expect.objectContaining({
        gitlab_instance_url: 'https://self.gitlab.example',
      })
    );
    expect(updatedIntegration.metadata).not.toHaveProperty('access_token');
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
  });

  it('stores a newly created project token only in its exact encrypted row', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    const token = await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(token).toBe('glpat-created-project-token');
    expect(credential).toEqual(
      expect.objectContaining({
        platform_integration_id: connected.integration.id,
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: 'https://gitlab.com',
        authorized_by_user_id: null,
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
        },
        provider_scopes: ['api', 'self_rotate'],
        credential_version: 1,
      })
    );
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId: KEY_ID, privateKeyPem: keyPair.privateKey } },
        buildGitLabProjectAccessTokenAad({
          credentialId: credential.id,
          integrationId: connected.integration.id,
          providerBaseUrl: 'https://gitlab.com',
          owner: { type: 'user', id: user.id },
          providerResourceId: '42',
          credentialVersion: 1,
        })
      )
    ).toBe('glpat-created-project-token');
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
  });

  it('rotates a project token in its stable encrypted row with a version bump', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockCreateProjectAccessToken.mockResolvedValueOnce({
      id: 777,
      name: 'Kilo Code Review Bot',
      token: 'glpat-expiring-project-token',
      expires_at: '2026-07-14',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      active: true,
      revoked: false,
      created_at: '2026-07-13T00:00:00.000Z',
      last_used_at: null,
      user_id: 123,
    });
    await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });
    const [initialCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    let [integrationWithProject] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    const scrubbedMetadata = {
      ...(integrationWithProject.metadata as Record<string, unknown>),
    };
    delete scrubbedMetadata.project_tokens;
    await db
      .update(platform_integrations)
      .set({ metadata: scrubbedMetadata })
      .where(eq(platform_integrations.id, connected.integration.id));
    [integrationWithProject] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    const token = await getOrCreateProjectAccessToken(integrationWithProject, 42, {
      userId: user.id,
    });

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(token).toBe('glpat-rotated-project-token');
    expect(credential).toEqual(
      expect.objectContaining({
        id: initialCredential.id,
        credential_version: 2,
        provider_metadata: {
          providerCredentialId: '778',
          expiresOn: '2027-07-13',
        },
      })
    );
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { active: { keyId: KEY_ID, privateKeyPem: keyPair.privateKey } },
        buildGitLabProjectAccessTokenAad({
          credentialId: credential.id,
          integrationId: connected.integration.id,
          providerBaseUrl: 'https://gitlab.com',
          owner: { type: 'user', id: user.id },
          providerResourceId: '42',
          credentialVersion: 2,
        })
      )
    ).toBe('glpat-rotated-project-token');
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
  });

  it('deletes only the invalid project credential before replacement', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    let [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockCreateProjectAccessToken.mockResolvedValueOnce({
      id: 888,
      name: 'Kilo Code Review Bot',
      token: 'glpat-other-project-token',
      expires_at: '2027-07-13',
      scopes: ['api'],
      access_level: 30,
      active: true,
      revoked: false,
      created_at: '2026-07-13T00:00:00.000Z',
      last_used_at: null,
      user_id: 123,
    });
    await getOrCreateProjectAccessToken(integration, 43, { userId: user.id });
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockValidateProjectAccessToken.mockResolvedValueOnce(false);
    mockCreateProjectAccessToken.mockRejectedValueOnce(new Error('replacement failed'));

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toThrow('replacement failed');

    const projectCredentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
      );
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(projectCredentials.map(credential => credential.provider_resource_id)).toEqual(['43']);
    expect(updatedIntegration.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it('removes the exact encrypted project credential after explicit revocation', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    let [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    const scrubbedMetadata = { ...(integration.metadata as Record<string, unknown>) };
    delete scrubbedMetadata.project_tokens;
    await db
      .update(platform_integrations)
      .set({ metadata: scrubbedMetadata })
      .where(eq(platform_integrations.id, connected.integration.id));
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    await removeStoredProjectAccessToken(integration, 42, { userId: user.id });

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(credentials).toHaveLength(1);
    expect(credentials[0].provider_resource_id).toBeNull();
    expect(updatedIntegration.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it('does not delete a project credential rotated during explicit revocation', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    let [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockRevokeProjectAccessToken.mockImplementationOnce(async () => {
      await db
        .update(platform_access_token_credentials)
        .set({ credential_version: 2 })
        .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    });

    await expect(
      removeStoredProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toThrow('GitLab project access token was replaced concurrently');

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    expect(credential.credential_version).toBe(2);
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
  });

  it('does not invalidate a project credential rotated during validation', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    let [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockValidateProjectAccessToken.mockImplementationOnce(async () => {
      await db
        .update(platform_access_token_credentials)
        .set({ credential_version: 2 })
        .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
      return false;
    });

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toThrow('GitLab project access token was replaced concurrently');

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    expect(credential.credential_version).toBe(2);
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
  });

  it('disconnects the primary PAT while preserving project credentials', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    await getOrCreateProjectAccessToken(integration, 42, { userId: user.id });

    await disconnectGitLabIntegration({ type: 'user', id: user.id });

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );
    const [disconnectedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(credentials).toHaveLength(1);
    expect(credentials[0].provider_resource_id).toBe('42');
    expect(disconnectedIntegration.integration_status).toBe('suspended');
    expect(disconnectedIntegration.metadata).not.toHaveProperty('access_token');
    expect(disconnectedIntegration.metadata).not.toHaveProperty('project_tokens');
  });
});
