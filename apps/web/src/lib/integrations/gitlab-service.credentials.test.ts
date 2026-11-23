/* eslint-disable drizzle/enforce-delete-with-where */
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { generateKeyPairSync } from 'node:crypto';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  platform_access_token_credentials,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import type { PlatformIntegration } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  GITLAB_PERSONAL_ACCESS_TOKEN_ENVELOPE_SCHEME,
  GITLAB_PROJECT_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildGitLabPersonalAccessTokenAad,
  buildGitLabProjectAccessTokenAad,
} from '@kilocode/worker-utils/gitlab-credential';
import type * as GitLabAdapter from '@/lib/integrations/platforms/gitlab/adapter';
import {
  GitLabAuthenticationError,
  GitLabProjectAccessTokenPermissionError,
  GitLabProjectAccessTokenRevocationError,
} from '@/lib/integrations/platforms/gitlab/adapter';
import type * as GitLabService from './gitlab-service';
import type * as GitLabProjectTokenHandles from './platforms/gitlab/project-token-handles';
import type { fetchGitLabCredential as FetchGitLabCredential } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import { isPlatformIntegrationSuspended } from './core/health';

const mockValidatePersonalAccessToken = jest.fn<typeof GitLabAdapter.validatePersonalAccessToken>();
const mockFetchGitLabProjects = jest.fn<typeof GitLabAdapter.fetchGitLabProjects>();
const mockCreateProjectAccessToken = jest.fn<typeof GitLabAdapter.createProjectAccessToken>();
const mockRotateProjectAccessToken = jest.fn<typeof GitLabAdapter.rotateProjectAccessToken>();
const mockValidateProjectAccessToken = jest.fn<typeof GitLabAdapter.validateProjectAccessToken>();
const mockRevokeProjectAccessToken = jest.fn<typeof GitLabAdapter.revokeProjectAccessToken>();
const mockFetchGitLabCredential = jest.fn<typeof FetchGitLabCredential>();
const mockResetCodeReviewConfigForOwner =
  jest.fn<(owner: unknown, platform: string) => Promise<void>>();

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

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: KEY_ID,
  BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(keyPair.publicKey).toString('base64'),
}));

let connectWithPAT: typeof GitLabService.connectWithPAT;
let getValidGitLabToken: typeof GitLabService.getValidGitLabToken;
let getValidGitLabProjectAccessToken: typeof GitLabService.getValidGitLabProjectAccessToken;
let getOrCreateProjectAccessToken: typeof GitLabService.getOrCreateProjectAccessToken;
let removeStoredProjectAccessToken: typeof GitLabProjectTokenHandles.removeStoredProjectAccessToken;
let listProjectIdsWithStoredTokens: typeof GitLabProjectTokenHandles.listProjectIdsWithStoredTokens;
let retireProjectCredentialsForReplacedAccount: typeof GitLabProjectTokenHandles.retireProjectCredentialsForReplacedAccount;
let describeSettlementFailure: typeof GitLabProjectTokenHandles.describeSettlementFailure;
let classifyCredentialResolutionFailure: typeof GitLabProjectTokenHandles.classifyCredentialResolutionFailure;
let disconnectGitLabIntegration: typeof GitLabService.disconnectGitLabIntegration;
let settleStoredProjectTokens: typeof GitLabService.settleStoredProjectTokens;

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
      disconnectGitLabIntegration,
      settleStoredProjectTokens,
    } = await import('./gitlab-service'));
    ({
      removeStoredProjectAccessToken,
      listProjectIdsWithStoredTokens,
      retireProjectCredentialsForReplacedAccount,
      describeSettlementFailure,
      classifyCredentialResolutionFailure,
    } = await import('./platforms/gitlab/project-token-handles'));
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
    mockValidateProjectAccessToken.mockResolvedValue({ status: 'valid' });
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
    await db.delete(organization_memberships);
    await db.delete(organizations);
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

  it('revokes a legacy metadata-only project token before dropping its entry', async () => {
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

    await expect(
      removeStoredProjectAccessToken(integrationWithStaleMetadata, 42, {
        userToken: 'glpat-primary-token',
      })
    ).resolves.toEqual({ outcome: 'removed' });

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      42,
      991,
      'https://gitlab.com',
      undefined
    );
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updatedIntegration.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it('revokes the legacy token id as well when the encrypted row holds a different one', async () => {
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
    const [integrationWithLegacy] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));

    await expect(
      removeStoredProjectAccessToken(integrationWithLegacy, 42, {
        userToken: 'glpat-primary-token',
      })
    ).resolves.toEqual({ outcome: 'removed' });

    expect(mockRevokeProjectAccessToken.mock.calls).toEqual([
      ['glpat-primary-token', 42, 777, 'https://gitlab.com'],
      ['glpat-primary-token', 42, 991, 'https://gitlab.com'],
    ]);
    expect(
      await db
        .select()
        .from(platform_access_token_credentials)
        .where(eq(platform_access_token_credentials.provider_resource_id, '42'))
    ).toEqual([]);
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updatedIntegration.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it('keeps a legacy metadata-only entry when GitLab does not settle its revocation', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenRevocationError(
        42,
        403,
        'GitLab revoke Project Access Token failed: 403'
      )
    );

    await expect(
      removeStoredProjectAccessToken(integrationWithStaleMetadata, 42, {
        userToken: 'glpat-primary-token',
      })
    ).resolves.toEqual({ outcome: 'retained', retryable: false, reason: 'provider_rejected' });

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

  it('keeps every stored handle when the stored instance URL is not a string', async () => {
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
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(integration.metadata as Record<string, unknown>),
          gitlab_instance_url: 42,
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
    const [unreadableInstance] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));

    await expect(
      removeStoredProjectAccessToken(unreadableInstance, 42, {
        userToken: 'glpat-primary-token',
      })
    ).resolves.toEqual({
      outcome: 'retained',
      retryable: false,
      reason: 'stored_instance_unusable',
    });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(credentials).toHaveLength(1);
    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({
        project_tokens: { '42': expect.objectContaining({ token_id: 991 }) },
      })
    );
  });

  it('keeps every stored handle when the stored instance URL cannot be normalized', async () => {
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
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(integration.metadata as Record<string, unknown>),
          gitlab_instance_url: 'http://plain.example',
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
    const [invalidInstance] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));

    await expect(
      removeStoredProjectAccessToken(invalidInstance, 42, {
        userToken: 'glpat-primary-token',
      })
    ).resolves.toEqual({
      outcome: 'retained',
      retryable: false,
      reason: 'stored_instance_unusable',
    });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(credentials).toHaveLength(1);
    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({
        project_tokens: { '42': expect.objectContaining({ token_id: 991 }) },
      })
    );
  });

  it('drops a legacy project token entry that names no revocable id', async () => {
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
              token: 'glpat-legacy-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, integration.id));
    const [integrationWithLegacy] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));

    await expect(
      removeStoredProjectAccessToken(integrationWithLegacy, 42, {
        userToken: 'glpat-primary-token',
      })
    ).resolves.toEqual({ outcome: 'scrubbed' });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updatedIntegration.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
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

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '99',
      999,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
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

  it('refuses an instance change while a stored project token stays unsettled', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
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
      provider_metadata: { providerCredentialId: '999', expiresOn: '2027-07-13' },
    });
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(99, 403, 'x')
    );

    const refusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('projects: 99');
    expect(refusalMessage).toContain('GitLab refused the connected credential');
    expect(refusalMessage).toContain(
      'Disconnect the integration, then reconnect the current instance with a credential that can revoke them.'
    );

    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({
        gitlab_instance_url: 'https://gitlab.com',
        project_tokens: { '99': expect.objectContaining({ token_id: 999 }) },
      })
    );
    const [projectCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '99')
        )
      );
    expect(projectCredential).toBeDefined();
  });

  it('refuses an instance change when no stored credential can be resolved', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
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
    mockFetchGitLabCredential.mockResolvedValue({ status: 'not_connected' });

    const noCredentialRefusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    ).catch((error: unknown) => error);

    expect(noCredentialRefusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const noCredentialMessage =
      noCredentialRefusal instanceof Error ? noCredentialRefusal.message : '';
    expect(noCredentialMessage).toContain('projects: 99');
    expect(noCredentialMessage).toContain('no stored credential can revoke them');
    expect(noCredentialMessage).toContain(
      'Disconnect the integration, then reconnect the current instance with a credential that can revoke them.'
    );

    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({
        gitlab_instance_url: 'https://gitlab.com',
        project_tokens: { '99': expect.objectContaining({ token_id: 999 }) },
      })
    );
    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabCredential).toHaveBeenCalledTimes(1);
  });

  it('reports a transient credential outage as retryable', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
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
      provider_metadata: { providerCredentialId: '999', expiresOn: '2027-07-13' },
    });
    mockFetchGitLabCredential.mockResolvedValue({ status: 'temporarily_unavailable' });

    const refusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('projects: 99');
    expect(refusalMessage).toContain('the stored credential could not be reached');
    expect(refusalMessage).toContain('Try again in a moment.');
    expect(refusalMessage).not.toContain('Disconnect the integration');

    expect(mockFetchGitLabCredential).toHaveBeenCalledTimes(2);
    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({
        gitlab_instance_url: 'https://gitlab.com',
        project_tokens: { '99': expect.objectContaining({ token_id: 999 }) },
      })
    );
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
            eq(platform_access_token_credentials.provider_resource_id, '99')
          )
        )
    ).resolves.toHaveLength(1);
  });

  it('allows an instance change when a transient credential outage clears on a repeat', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
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
      provider_metadata: { providerCredentialId: '999', expiresOn: '2027-07-13' },
    });
    mockFetchGitLabCredential
      .mockResolvedValueOnce({ status: 'temporarily_unavailable' })
      .mockResolvedValueOnce({
        status: 'available',
        token: 'glpat-primary-token',
        instanceUrl: 'https://gitlab.com',
        glabIsOAuth2: false,
      });

    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    );

    expect(connected.success).toBe(true);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '99',
      999,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
            eq(platform_access_token_credentials.provider_resource_id, '99')
          )
        )
    ).resolves.toHaveLength(0);
  });

  it('lists each blocked project under its own cause', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
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
            '77': {
              token_id: 777,
              token: 'glpat-second-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, initial.integration.id));
    await db.insert(platform_access_token_credentials).values([
      {
        platform_integration_id: initial.integration.id,
        token_encrypted: 'encrypted-project-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '99',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: { providerCredentialId: '999', expiresOn: '2027-07-13' },
      },
      {
        platform_integration_id: initial.integration.id,
        token_encrypted: 'encrypted-second-project-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '77',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: { providerCredentialId: '777', expiresOn: '2027-07-13' },
      },
    ]);
    mockRevokeProjectAccessToken.mockImplementation(async (_token, projectId) => {
      if (String(projectId) === '99') {
        throw new GitLabProjectAccessTokenPermissionError(99, 403, 'x');
      }
      throw new GitLabProjectAccessTokenRevocationError(77, 503, 'GitLab responded with HTTP 503.');
    });

    const refusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    const [rejectedClause, unconfirmedClause] = refusalMessage.split(
      'Other project tokens are also blocked because'
    );
    expect(rejectedClause).toContain('projects: 99');
    expect(rejectedClause).toContain('GitLab refused the connected credential while revoking them');
    expect(rejectedClause).toContain(
      'Disconnect the integration, then reconnect the current instance with a credential that can revoke them.'
    );
    expect(unconfirmedClause).toContain('projects: 77');
    expect(unconfirmedClause).toContain('a revocation could not be confirmed');
    expect(unconfirmedClause).toContain('Try again in a moment.');
    expect(unconfirmedClause).not.toContain('99');

    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({
        gitlab_instance_url: 'https://gitlab.com',
        project_tokens: {
          '99': expect.objectContaining({ token_id: 999 }),
          '77': expect.objectContaining({ token_id: 777 }),
        },
      })
    );
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
            isNotNull(platform_access_token_credentials.provider_resource_id)
          )
        )
    ).resolves.toHaveLength(2);
  });

  it('refuses an instance change when the stored instance address is unusable', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    const [initialIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(initialIntegration.metadata as Record<string, unknown>),
          gitlab_instance_url: 42,
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
      provider_metadata: { providerCredentialId: '999', expiresOn: '2027-07-13' },
    });

    const refusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('projects: 99');
    expect(refusalMessage).toContain('stored GitLab instance address could not be used');
    expect(refusalMessage).toContain(
      'Ask Kilo support to repair the stored integration record, then reconnect.'
    );
    expect(refusalMessage).not.toContain('Reconnect the current instance');
    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();

    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({
        gitlab_instance_url: 42,
        project_tokens: { '99': expect.objectContaining({ token_id: 999 }) },
      })
    );
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
            eq(platform_access_token_credentials.provider_resource_id, '99')
          )
        )
    ).resolves.toHaveLength(1);
  });

  it('refuses a plain reconnect to the same instance when the stored address is unusable', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    const [initialIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(initialIntegration.metadata as Record<string, unknown>),
          gitlab_instance_url: 42,
        },
      })
      .where(eq(platform_integrations.id, initial.integration.id));
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: initial.integration.id,
      token_encrypted: 'encrypted-project-token',
      provider_credential_type: 'project_access_token',
      provider_resource_id: '99',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: { providerCredentialId: '999', expiresOn: '2027-07-13' },
    });

    const refusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://gitlab.com',
      user.id
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('projects: 99');
    expect(refusalMessage).toContain('stored GitLab instance address could not be used');
    expect(refusalMessage).toContain(
      'Ask Kilo support to repair the stored integration record, then reconnect.'
    );
    expect(refusalMessage).not.toContain('Reconnect the current instance');
    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
  });

  it('refuses an instance change when a project token appears after the settlement', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
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
    mockRevokeProjectAccessToken.mockImplementationOnce(async () => {
      await db.insert(platform_access_token_credentials).values({
        platform_integration_id: initial.integration.id,
        token_encrypted: 'encrypted-late-project-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '77',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: { providerCredentialId: '1234', expiresOn: '2027-07-13' },
      });
    });

    const inTransactionRefusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-other-instance-token',
      'https://self.gitlab.example/',
      user.id
    ).catch((error: unknown) => error);

    expect(inTransactionRefusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const inTransactionMessage =
      inTransactionRefusal instanceof Error ? inTransactionRefusal.message : '';
    expect(inTransactionMessage).toContain('projects: 77');
    expect(inTransactionMessage).toContain('a revocation could not be attempted');
    expect(inTransactionMessage).toContain('Try again in a moment.');

    const [unchanged] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    expect(unchanged.metadata).toEqual(
      expect.objectContaining({ gitlab_instance_url: 'https://gitlab.com' })
    );
    const [lateProjectCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '77')
        )
      );
    expect(lateProjectCredential).toBeDefined();
  });

  it('lists only project ids that a stored credential row names', async () => {
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
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: connected.integration.id,
      token_encrypted: 'encrypted-malformed-token',
      provider_credential_type: 'project_access_token',
      provider_resource_id: 'not-a-project',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: { providerCredentialId: '1234', expiresOn: '2027-07-13' },
    });

    await expect(
      listProjectIdsWithStoredTokens({
        id: connected.integration.id,
        metadata: integration.metadata,
      })
    ).resolves.toEqual(['42']);
  });

  it('allows an instance change when only a malformed credential row is stored', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: initial.integration.id,
      token_encrypted: 'encrypted-malformed-token',
      provider_credential_type: 'project_access_token',
      provider_resource_id: 'not-a-project',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: { providerCredentialId: '1234', expiresOn: '2027-07-13' },
    });

    await expect(
      connectWithPAT(
        { type: 'user', id: user.id },
        'glpat-other-instance-token',
        'https://gitlab.example.com',
        user.id
      )
    ).resolves.toMatchObject({ success: true });

    const projectCredentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, initial.integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(projectCredentials).toHaveLength(0);
    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
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
          authorizedAccountId: '123',
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
          authorizedAccountId: '123',
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
    mockValidateProjectAccessToken.mockResolvedValueOnce({
      status: 'invalid',
      reason: 'unauthorized',
      httpStatus: 401,
    });
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

  it.each([
    { status: 'invalid', reason: 'unauthorized', httpStatus: 401 },
    { status: 'invalid', reason: 'forbidden', httpStatus: 403 },
  ] as const)('replaces a denied project credential after a bounded probe', async validation => {
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
    mockValidateProjectAccessToken
      .mockResolvedValueOnce({ status: 'unverified', reason: 'transport' })
      .mockResolvedValueOnce(validation);
    mockCreateProjectAccessToken.mockResolvedValueOnce({
      id: 888,
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

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-rotated-project-token'
    );

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
      );
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(mockCreateProjectAccessToken).toHaveBeenCalledTimes(2);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual(
      expect.objectContaining({
        provider_resource_id: '42',
        provider_metadata: expect.objectContaining({ providerCredentialId: '888' }),
      })
    );
    expect(updatedIntegration.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it.each([
    { status: 'unverified', reason: 'http-error', httpStatus: 500 },
    { status: 'unverified', reason: 'transport' },
  ] as const)('reuses the stored project credential after a bounded probe', async validation => {
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
    const [initialCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    mockValidateProjectAccessToken.mockClear();
    mockValidateProjectAccessToken.mockResolvedValue(validation);

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-created-project-token'
    );

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));

    expect(mockValidateProjectAccessToken).toHaveBeenCalledTimes(2);
    expect(mockCreateProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(credentials).toEqual([
      expect.objectContaining({
        id: initialCredential.id,
        credential_version: initialCredential.credential_version,
      }),
    ]);
  });

  it('reuses the stored project credential when a retried probe succeeds', async () => {
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
    mockValidateProjectAccessToken.mockClear();
    mockValidateProjectAccessToken
      .mockResolvedValueOnce({ status: 'unverified', reason: 'transport' })
      .mockResolvedValueOnce({ status: 'valid' });

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-created-project-token'
    );

    expect(mockValidateProjectAccessToken).toHaveBeenCalledTimes(2);
    expect(mockCreateProjectAccessToken).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a probe whose answer is a stored configuration problem', async () => {
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
    mockValidateProjectAccessToken.mockClear();
    mockValidateProjectAccessToken.mockResolvedValue({
      status: 'unverified',
      reason: 'instance-url',
    });

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockValidateProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(mockCreateProjectAccessToken).toHaveBeenCalledTimes(1);
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

    await removeStoredProjectAccessToken(integration, 42, { userToken: 'glpat-primary-token' });

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

  it('keeps the stored project credential when GitLab does not settle the revocation', async () => {
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
      .where(eq(platform_integrations.id, connected.integration.id));
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenRevocationError(
        42,
        503,
        'GitLab revoke Project Access Token failed: 503 - Service Unavailable'
      )
    );

    await removeStoredProjectAccessToken(integration, 42, { userToken: 'glpat-primary-token' });

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(credential).toEqual(
      expect.objectContaining({ provider_resource_id: '42', credential_version: 1 })
    );
    expect(updatedIntegration.metadata).toEqual(
      expect.objectContaining({
        project_tokens: { '42': expect.objectContaining({ token_id: 991 }) },
      })
    );
  });

  it('keeps the stored project credential when GitLab rejects the acting credential', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabAuthenticationError(
        42,
        401,
        'GitLab rejected the credential while revoking a Project Access Token'
      )
    );

    await removeStoredProjectAccessToken(integration, 42, { userToken: 'glpat-primary-token' });

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(credential).toEqual(expect.objectContaining({ provider_resource_id: '42' }));
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
  });

  it('keeps the stored project credential when the revocation request fails in transport', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValueOnce(new TypeError('fetch failed'));

    await removeStoredProjectAccessToken(integration, 42, { userToken: 'glpat-primary-token' });

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    const [updatedIntegration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(credential).toEqual(expect.objectContaining({ provider_resource_id: '42' }));
    expect(updatedIntegration.metadata).not.toHaveProperty('project_tokens');
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
      removeStoredProjectAccessToken(integration, 42, { userToken: 'glpat-primary-token' })
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
      return { status: 'invalid', reason: 'unauthorized', httpStatus: 401 };
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

  it('requires a connected account before serving a project credential', async () => {
    const user = await insertTestUser();
    const connected = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    await db
      .update(platform_integrations)
      .set({ platform_account_id: null, platform_installation_id: null })
      .where(eq(platform_integrations.id, connected.integration.id));
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(mockFetchGitLabCredential).not.toHaveBeenCalled();
    expect(mockCreateProjectAccessToken).not.toHaveBeenCalled();
  });

  it('reuses a project credential recorded for the connected GitLab account', async () => {
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
    const [initialCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    mockRevokeProjectAccessToken.mockClear();

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-created-project-token'
    );

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    expect(mockCreateProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(credential).toEqual(
      expect.objectContaining({
        id: initialCredential.id,
        credential_version: initialCredential.credential_version,
        provider_metadata: expect.objectContaining({ authorizedAccountId: '123' }),
      })
    );
  });

  it('replaces a project credential that records no account', async () => {
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
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: connected.integration.id,
      token_encrypted: 'legacy-project-token-envelope',
      provider_credential_type: 'project_access_token',
      provider_resource_id: '42',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: {
        providerCredentialId: '555',
        expiresOn: '2027-07-13',
      },
      provider_scopes: ['api'],
    });
    mockCreateProjectAccessToken.mockResolvedValueOnce({
      id: 888,
      name: 'Kilo Code Review Bot',
      token: 'glpat-expiring-project-token',
      expires_at: '2027-07-13',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      active: true,
      revoked: false,
      created_at: '2026-07-13T00:00:00.000Z',
      last_used_at: null,
      user_id: 123,
    });

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-expiring-project-token'
    );

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '42',
      555,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    expect(credentials).toEqual([
      expect.objectContaining({
        provider_resource_id: '42',
        credential_version: 1,
        provider_metadata: {
          providerCredentialId: '888',
          expiresOn: '2027-07-13',
          authorizedAccountId: '123',
        },
      }),
    ]);
  });

  it('binds project credentials to the connected account on a PAT connect', async () => {
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
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(integration.metadata as Record<string, unknown>),
          project_tokens: {
            '42': {
              token_id: 777,
              token: 'glpat-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, connected.integration.id));
    mockValidatePersonalAccessToken.mockResolvedValueOnce({
      ...validationResult,
      user: { ...validationResult.user, id: 456, username: 'other-gitlab-user' },
    });

    await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-replacement-token',
      'https://gitlab.com',
      user.id
    );

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

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-replacement-token',
      '42',
      777,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    expect(projectCredentials).toHaveLength(0);
    expect(updatedIntegration.platform_account_id).toBe('456');
    expect(updatedIntegration.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
    expect(mockResetCodeReviewConfigForOwner).toHaveBeenCalledWith(
      { type: 'user', id: user.id },
      'gitlab'
    );
  });

  it('marks the stored project credential unusable', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(
        42,
        403,
        'Insufficient permissions to revoke Project Access Token for project 42.'
      )
    );
    mockValidatePersonalAccessToken.mockResolvedValueOnce({
      ...validationResult,
      user: { ...validationResult.user, id: 456, username: 'other-gitlab-user' },
    });

    await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-replacement-token',
      'https://gitlab.com',
      user.id
    );

    const [retained] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));
    expect(retained).toEqual(
      expect.objectContaining({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
          authorizedAccountId: '123',
          unusableReason: 'account-changed',
        },
      })
    );

    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockCreateProjectAccessToken.mockResolvedValueOnce({
      id: 889,
      name: 'Kilo Code Review Bot',
      token: 'glpat-expiring-project-token',
      expires_at: '2027-07-13',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      active: true,
      revoked: false,
      created_at: '2026-07-13T00:00:00.000Z',
      last_used_at: null,
      user_id: 456,
    });

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-expiring-project-token'
    );

    const [replaced] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.provider_resource_id, '42'));

    expect(mockValidateProjectAccessToken).not.toHaveBeenCalled();
    expect(replaced).toEqual(
      expect.objectContaining({
        provider_resource_id: '42',
        provider_metadata: {
          providerCredentialId: '889',
          expiresOn: '2027-07-13',
          authorizedAccountId: '456',
        },
      })
    );
  });

  it('retires a project credential of another account on account change', async () => {
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
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: integration.id,
      token_encrypted: 'encrypted-project-42-token',
      provider_credential_type: 'project_access_token',
      provider_resource_id: '42',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: {
        providerCredentialId: '555',
        expiresOn: '2027-07-13',
        authorizedAccountId: '101',
        unusableReason: 'account-changed',
      },
    });

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-created-project-token'
    );

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '42',
      555,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    expect(mockCreateProjectAccessToken).toHaveBeenCalledTimes(1);
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(credentials).toEqual([
      expect.objectContaining({
        provider_resource_id: '42',
        credential_version: 1,
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
          authorizedAccountId: '123',
        },
      }),
    ]);
  });

  it('retires the credential before writing a new row for the project', async () => {
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
    await db.insert(platform_access_token_credentials).values({
      platform_integration_id: integration.id,
      token_encrypted: 'encrypted-project-42-token',
      provider_credential_type: 'project_access_token',
      provider_resource_id: '42',
      provider_base_url: 'https://gitlab.com',
      provider_metadata: {
        providerCredentialId: '555',
        expiresOn: '2027-07-13',
        authorizedAccountId: '101',
        unusableReason: 'account-changed',
      },
    });
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(
        42,
        403,
        'Insufficient permissions to revoke Project Access Token for project 42.'
      )
    );

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      'glpat-created-project-token'
    );

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(credentials).toEqual([
      expect.objectContaining({
        provider_resource_id: '42',
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
          authorizedAccountId: '123',
        },
      }),
    ]);
  });

  it('marks the remaining credentials after the account-change deadline', async () => {
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
          gitlab_instance_url: 'https://gitlab.com',
        },
      })
      .where(eq(platform_integrations.id, integration.id));
    await db.insert(platform_access_token_credentials).values([
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-42-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
        },
      },
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-43-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '43',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '888',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
        },
      },
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-44-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '44',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '999',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
        },
      },
    ]);
    const controller = new AbortController();
    mockRevokeProjectAccessToken.mockImplementation(async () => {
      controller.abort();
    });

    await expect(
      retireProjectCredentialsForReplacedAccount({
        integration: {
          id: integration.id,
          metadata: { gitlab_instance_url: 'https://gitlab.com' },
        },
        userToken: 'glpat-primary-token',
        currentAccountId: '202',
        signal: controller.signal,
      })
    ).resolves.toEqual({ retired: 1, retained: 2, skippedWithinRetained: 2 });

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '42',
      777,
      'https://gitlab.com',
      controller.signal
    );
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(
      credentials
        .map(credential => credential.provider_resource_id)
        .sort((left, right) => Number(left) - Number(right))
    ).toEqual(['43', '44']);
    for (const credential of credentials) {
      expect(credential.provider_metadata).toEqual(
        expect.objectContaining({
          unusableReason: 'account-changed',
          authorizedAccountId: '101',
        })
      );
    }
  });

  it('leaves a project of the connected account out of the counts after the deadline', async () => {
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
    await db.insert(platform_access_token_credentials).values([
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-42-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
        },
      },
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-43-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '43',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '888',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
        },
      },
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-44-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '44',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '999',
          expiresOn: '2027-07-13',
          authorizedAccountId: '202',
        },
      },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      retireProjectCredentialsForReplacedAccount({
        integration: {
          id: integration.id,
          metadata: { gitlab_instance_url: 'https://gitlab.com' },
        },
        userToken: 'glpat-primary-token',
        currentAccountId: '202',
        signal: controller.signal,
      })
    ).resolves.toEqual({ retired: 0, retained: 2, skippedWithinRetained: 2 });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    const byProject = new Map(
      credentials.map(credential => [credential.provider_resource_id, credential.provider_metadata])
    );
    expect(byProject.get('42')).toEqual(
      expect.objectContaining({ unusableReason: 'account-changed' })
    );
    expect(byProject.get('43')).toEqual(
      expect.objectContaining({ unusableReason: 'account-changed' })
    );
    expect(byProject.get('44')).toEqual({
      authorizedAccountId: '202',
      expiresOn: '2027-07-13',
      providerCredentialId: '999',
    });
  });

  it('leaves an own-account row that already carries the marker out of the counts', async () => {
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
    await db.insert(platform_access_token_credentials).values([
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-42-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
        },
      },
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-43-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '43',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          authorizedAccountId: '202',
          expiresOn: '2027-07-13',
          providerCredentialId: '888',
          unusableReason: 'account-changed',
        },
      },
    ]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      retireProjectCredentialsForReplacedAccount({
        integration: {
          id: integration.id,
          metadata: { gitlab_instance_url: 'https://gitlab.com' },
        },
        userToken: 'glpat-primary-token',
        currentAccountId: '202',
        signal: controller.signal,
      })
    ).resolves.toEqual({ retired: 0, retained: 1, skippedWithinRetained: 1 });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
  });

  it('leaves a project credential the provider already refused alone on a later account change', async () => {
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
          gitlab_instance_url: 'https://gitlab.com',
        },
      })
      .where(eq(platform_integrations.id, integration.id));
    await db.insert(platform_access_token_credentials).values([
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-42-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '42',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
          unusableReason: 'account-changed',
        },
      },
      {
        platform_integration_id: integration.id,
        token_encrypted: 'encrypted-project-43-token',
        provider_credential_type: 'project_access_token',
        provider_resource_id: '43',
        provider_base_url: 'https://gitlab.com',
        provider_metadata: {
          providerCredentialId: '888',
          expiresOn: '2027-07-13',
          authorizedAccountId: '101',
        },
      },
    ]);

    await expect(
      retireProjectCredentialsForReplacedAccount({
        integration: {
          id: integration.id,
          metadata: { gitlab_instance_url: 'https://gitlab.com' },
        },
        userToken: 'glpat-primary-token',
        currentAccountId: '202',
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({ retired: 1, retained: 1, skippedWithinRetained: 0 });

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '43',
      888,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(credentials.map(credential => credential.provider_resource_id)).toEqual(['42']);
    expect(credentials[0].provider_metadata).toEqual({
      providerCredentialId: '777',
      expiresOn: '2027-07-13',
      authorizedAccountId: '101',
      unusableReason: 'account-changed',
    });
  });

  it('revokes each project token at GitLab and drops its stored handles on disconnect', async () => {
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
    const configuredWebhooks = {
      '42': { hook_id: 77, created_at: '2026-07-13T00:00:00.000Z' },
    };
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(integration.metadata as Record<string, unknown>),
          configured_webhooks: configuredWebhooks,
        },
      })
      .where(eq(platform_integrations.id, integration.id));

    await disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id);

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

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '42',
      777,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    expect(credentials).toEqual([]);
    expect(disconnectedIntegration.integration_status).toBe('suspended');
    expect(disconnectedIntegration.metadata).not.toHaveProperty('access_token');
    expect(disconnectedIntegration.metadata).toEqual(
      expect.objectContaining({
        webhook_secret: expect.any(String),
        configured_webhooks: configuredWebhooks,
        project_tokens: {},
      })
    );
  });

  it('keeps a project token whose revocation GitLab refuses', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValue(
      new GitLabProjectAccessTokenPermissionError(
        42,
        403,
        'Insufficient permissions to revoke Project Access Token for project 42.'
      )
    );

    await expect(
      disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id)
    ).resolves.toEqual({ success: true });

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

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toEqual(
      expect.objectContaining({
        provider_resource_id: '42',
        provider_credential_type: 'project_access_token',
      })
    );
    expect(disconnectedIntegration.integration_status).toBe('suspended');
    expect(disconnectedIntegration.metadata).not.toHaveProperty(['project_tokens', '42']);
  });

  it('settles a project token when GitLab refuses once and accepts the next attempt', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenRevocationError(42, 503, 'GitLab responded with HTTP 503.')
    );

    await expect(
      disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id)
    ).resolves.toEqual({ success: true });

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

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(2);
    expect(credentials).toEqual([]);
    expect(disconnectedIntegration.metadata).toEqual(
      expect.objectContaining({ project_tokens: {} })
    );
  });

  it('counts a project whose stored handles another attempt settled as settled', async () => {
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
    mockRevokeProjectAccessToken.mockImplementationOnce(async () => {
      await db
        .delete(platform_access_token_credentials)
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
            eq(platform_access_token_credentials.provider_resource_id, '42')
          )
        );
      throw new GitLabProjectAccessTokenRevocationError(42, 503, 'GitLab responded with HTTP 503.');
    });

    await expect(settleStoredProjectTokens(integration, 'glpat-primary-token')).resolves.toEqual({
      revoked: 0,
      scrubbed: 1,
      retained: 0,
      unattempted: 0,
      blocking: [],
    });

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(credentials).toEqual([]);
  });

  it('keeps a project token whose revocation fails twice with a server error', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValue(
      new GitLabProjectAccessTokenRevocationError(42, 503, 'GitLab responded with HTTP 503.')
    );

    await expect(
      disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id)
    ).resolves.toEqual({ success: true });

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(2);
    expect(credentials).toHaveLength(1);
    expect(credentials[0].provider_resource_id).toBe('42');
  });

  it('leaves project tokens unattempted when the settlement budget is already spent', async () => {
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
    const controller = new AbortController();
    controller.abort();

    await expect(
      settleStoredProjectTokens(integration, 'glpat-primary-token', {
        signal: controller.signal,
      })
    ).resolves.toEqual({
      revoked: 0,
      scrubbed: 0,
      retained: 1,
      unattempted: 1,
      blocking: [{ projectId: '42', reason: 'not_attempted' }],
    });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(credentials).toHaveLength(1);
  });

  it('skips the second attempt when the settlement budget is spent during the first', async () => {
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
    const controller = new AbortController();
    mockRevokeProjectAccessToken.mockImplementation(async () => {
      controller.abort();
      throw new GitLabProjectAccessTokenRevocationError(42, 503, 'GitLab responded with HTTP 503.');
    });

    await expect(
      settleStoredProjectTokens(integration, 'glpat-primary-token', {
        signal: controller.signal,
      })
    ).resolves.toEqual({
      revoked: 0,
      scrubbed: 0,
      retained: 1,
      unattempted: 0,
      blocking: [{ projectId: '42', reason: 'provider_unconfirmed' }],
    });

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(credentials).toHaveLength(1);
  });

  it('keeps a project token whose stored credential cannot be parsed and names the permanent cause', async () => {
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
    await db
      .update(platform_access_token_credentials)
      .set({ provider_metadata: { expiresOn: '2027-07-13' } })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );

    await expect(settleStoredProjectTokens(integration, 'glpat-primary-token')).resolves.toEqual({
      revoked: 0,
      scrubbed: 0,
      retained: 1,
      unattempted: 0,
      blocking: [{ projectId: '42', reason: 'stored_credential_unreadable' }],
    });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();

    const refusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.example.com',
      user.id
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('a stored project credential could not be read');
    expect(refusalMessage).toContain(
      'Ask Kilo support to repair the stored integration record, then reconnect.'
    );
    expect(refusalMessage).not.toContain('Try again in a moment');
  });

  it('reports an unreadable stored credential row without a resolved credential as the permanent cause', async () => {
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
    await db
      .update(platform_access_token_credentials)
      .set({ provider_metadata: { expiresOn: '2027-07-13' } })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    mockFetchGitLabCredential.mockResolvedValueOnce({ status: 'not_connected' });

    await expect(
      settleStoredProjectTokens(integration, undefined, {
        missingCredentialReason: 'credential_unresolved',
      })
    ).resolves.toEqual({
      revoked: 0,
      scrubbed: 0,
      retained: 1,
      unattempted: 1,
      blocking: [{ projectId: '42', reason: 'stored_credential_unreadable' }],
    });

    const refusal = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.example.com',
      user.id
    ).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('a stored project credential could not be read');
    expect(refusalMessage).toContain(
      'Ask Kilo support to repair the stored integration record, then reconnect.'
    );
    expect(refusalMessage).not.toContain('no stored credential can revoke them');
  });

  it('reports only an unreadable stored credential as a permanent settlement failure', () => {
    expect(describeSettlementFailure(new Error('connection terminated unexpectedly'))).toEqual({
      retryable: true,
      reason: 'provider_unconfirmed',
    });
    expect(describeSettlementFailure(new TypeError('fetch failed'))).toEqual({
      retryable: true,
      reason: 'provider_unconfirmed',
    });
    expect(
      describeSettlementFailure(
        new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'GitLab project credential must be recreated',
        })
      )
    ).toEqual({
      retryable: false,
      reason: 'stored_credential_unreadable',
    });
    expect(
      describeSettlementFailure(new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'x' }))
    ).toEqual({ retryable: true, reason: 'provider_unconfirmed' });
    expect(
      classifyCredentialResolutionFailure(
        new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'x' })
      )
    ).toBe('credential_unresolved');
    expect(classifyCredentialResolutionFailure(new TypeError('fetch failed'))).toBe(
      'credential_unresolved'
    );
    expect(
      classifyCredentialResolutionFailure(new TRPCError({ code: 'NOT_FOUND', message: 'x' }))
    ).toBe('no_credential');
  });

  it('drops a legacy entry that names no revocable id on disconnect', async () => {
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
              token: 'glpat-legacy-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, integration.id));

    await expect(
      disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id)
    ).resolves.toEqual({ success: true });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    const [disconnected] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    expect(disconnected.integration_status).toBe('suspended');
    expect(disconnected.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it('keeps project tokens when the connected credential cannot be resolved', async () => {
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
    mockFetchGitLabCredential.mockResolvedValueOnce({ status: 'not_connected' });

    await expect(
      disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id)
    ).resolves.toEqual({ success: true });

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    expect(credentials).toHaveLength(1);
    expect(credentials[0].provider_resource_id).toBe('42');
  });

  it('runs the credential-free entry cleanup when no credential is available', async () => {
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
    await db
      .update(platform_integrations)
      .set({
        metadata: {
          ...(integration.metadata as Record<string, unknown>),
          project_tokens: {
            '43': {
              token: 'glpat-legacy-project-token',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'Kilo Code Review Bot',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, integration.id));
    const [withLegacy] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    mockFetchGitLabCredential.mockClear();

    await expect(settleStoredProjectTokens(withLegacy, undefined)).resolves.toEqual({
      revoked: 0,
      scrubbed: 1,
      retained: 1,
      unattempted: 1,
      blocking: [{ projectId: '42', reason: 'no_credential' }],
    });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    expect(mockFetchGitLabCredential).not.toHaveBeenCalled();
    const [updated] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(updated.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_credential_type, 'project_access_token')
        )
      );
    expect(credentials).toHaveLength(1);
  });

  it('settles the project token a disconnect kept when the integration is reconnected', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(
        42,
        403,
        'Insufficient permissions to revoke Project Access Token for project 42.'
      )
    );

    await disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id);

    const keptBeforeReconnect = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );
    expect(keptBeforeReconnect).toHaveLength(1);

    mockRevokeProjectAccessToken.mockClear();
    const statusWhileSettling: Array<string | null> = [];
    mockRevokeProjectAccessToken.mockImplementation(async () => {
      const [row] = await db
        .select({ status: platform_integrations.integration_status })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, connected.integration.id));
      statusWhileSettling.push(row.status);
    });

    await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-reconnect-token',
      'https://gitlab.com',
      user.id
    );

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );
    const [reconnected] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-reconnect-token',
      '42',
      777,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    expect(statusWhileSettling).toEqual(['suspended']);
    expect(credentials).toEqual([
      expect.objectContaining({
        provider_credential_type: 'personal_access_token',
        provider_resource_id: null,
      }),
    ]);
    expect(reconnected.integration_status).toBe('active');
    expect(reconnected.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it('keeps a project token a reconnect cannot settle and still connects', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValue(
      new GitLabProjectAccessTokenPermissionError(
        42,
        403,
        'Insufficient permissions to revoke Project Access Token for project 42.'
      )
    );

    await disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id);
    mockRevokeProjectAccessToken.mockClear();

    const result = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-reconnect-token',
      'https://gitlab.com',
      user.id
    );

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );
    const [reconnected] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(result.success).toBe(true);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider_resource_id: '42',
          provider_credential_type: 'project_access_token',
        }),
      ])
    );
    expect(credentials).toHaveLength(2);
    expect(reconnected.integration_status).toBe('active');
  });

  it('settles kept project tokens against the previous instance before a reconnect changes it', async () => {
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
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(
        42,
        403,
        'Insufficient permissions to revoke Project Access Token for project 42.'
      )
    );

    await disconnectGitLabIntegration({ type: 'user', id: user.id }, user.id);
    mockRevokeProjectAccessToken.mockClear();

    await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-reconnect-token',
      'https://selfhosted.test',
      user.id
    );

    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integration.id)
      );
    const [reconnected] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '42',
      777,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    expect(credentials).toHaveLength(1);
    expect(credentials[0].provider_credential_type).toBe('personal_access_token');
    expect(reconnected.metadata).toEqual(
      expect.objectContaining({ gitlab_instance_url: 'https://selfhosted.test' })
    );
    expect(reconnected.metadata).not.toHaveProperty('project_tokens');
  });

  it('resolves the disconnect credential as the acting organization member', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('GitLab disconnect org', user.id, 0);
    const connected = await connectWithPAT(
      { type: 'org', id: organization.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    await getOrCreateProjectAccessToken(integration, 42, {
      userId: user.id,
      organizationId: organization.id,
    });
    mockFetchGitLabCredential.mockClear();

    await disconnectGitLabIntegration({ type: 'org', id: organization.id }, user.id);

    expect(mockFetchGitLabCredential).toHaveBeenCalledWith(
      { userId: user.id, organizationId: organization.id },
      { credential: 'integration', integrationId: integration.id }
    );
  });

  it('keeps a new connection when the repository list cannot be loaded', async () => {
    const user = await insertTestUser();
    mockFetchGitLabProjects.mockRejectedValueOnce(new Error('GitLab projects fetch failed: 500'));

    const result = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-primary-token',
      'https://gitlab.com',
      user.id
    );

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, result.integration.id));
    const credentials = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, integration.id));

    expect(result.success).toBe(true);
    expect(result.integration.id).toBe(integration.id);
    expect(result.warnings).toEqual([
      'Connected, but the repository list could not be loaded. Refresh the project list from the GitLab integration page.',
    ]);
    expect(integration.integration_status).toBe('active');
    expect(integration.repositories).toBeNull();
    expect(integration.repositories_synced_at).toBeNull();
    expect(credentials).toHaveLength(1);
  });

  it('keeps an existing connection and its webhook secret when the repository list cannot be loaded', async () => {
    const user = await insertTestUser();
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    const [before] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    mockFetchGitLabProjects.mockRejectedValueOnce(new Error('GitLab projects fetch failed: 502'));

    const result = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-replacement-token',
      'https://gitlab.com',
      user.id
    );

    const [after] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      'Connected, but the repository list could not be loaded. Refresh the project list from the GitLab integration page.',
    ]);
    expect(after.integration_status).toBe('active');
    // The cache from the earlier successful sync survives the failed refresh.
    expect(after.repositories).toEqual(before.repositories);
    expect(after.repositories_synced_at).toEqual(before.repositories_synced_at);
    expect((after.metadata as Record<string, unknown>).webhook_secret).toBe(
      (before.metadata as Record<string, unknown>).webhook_secret
    );
  });

  it('restores credential health on reconnect even when repository sync fails', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user', id: user.id } as const;
    const initial = await connectWithPAT(
      owner,
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    await db
      .update(platform_integrations)
      .set({
        integration_status: 'suspended',
        auth_invalid_at: new Date().toISOString(),
        auth_invalid_reason: 'authorizing_user_deleted',
      })
      .where(eq(platform_integrations.id, initial.integration.id));
    await db
      .delete(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, initial.integration.id));
    mockFetchGitLabProjects.mockRejectedValueOnce(new Error('GitLab projects fetch failed: 502'));

    const result = await connectWithPAT(
      owner,
      'glpat-replacement-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, initial.integration.id));

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      'Connected, but the repository list could not be loaded. Refresh the project list from the GitLab integration page.',
    ]);
    expect(integration.integration_status).toBe('active');
    expect(integration.auth_invalid_at).toBeNull();
    expect(integration.auth_invalid_reason).toBeNull();
    expect(credential.authorized_by_user_id).toBe(user.id);
  });

  it('clears the suspension markers when a PAT reconnect reactivates the row', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user', id: user.id } as const;
    const initial = await connectWithPAT(
      owner,
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    await db
      .update(platform_integrations)
      .set({
        suspended_at: new Date().toISOString(),
        suspended_by: 'suspension-writer',
      })
      .where(eq(platform_integrations.id, initial.integration.id));

    const result = await connectWithPAT(
      owner,
      'glpat-replacement-token',
      'https://gitlab.com',
      user.id
    );
    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));

    expect(result.success).toBe(true);
    expect(integration.integration_status).toBe('active');
    expect(integration.suspended_at).toBeNull();
    expect(integration.suspended_by).toBeNull();
    expect(isPlatformIntegrationSuspended(integration)).toBe(false);
  });

  it('discards the previous instance cache when the repository list cannot be loaded', async () => {
    const user = await insertTestUser();
    mockFetchGitLabProjects.mockResolvedValueOnce([
      { id: 123, name: 'repo', full_name: 'group/sub/repo', private: true },
    ]);
    const initial = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-initial-token',
      'https://gitlab.com',
      user.id
    );
    const [before] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));
    mockFetchGitLabProjects.mockRejectedValueOnce(new Error('GitLab projects fetch failed: 500'));

    const result = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-replacement-token',
      'https://gitlab.example.com',
      user.id
    );

    const [after] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, initial.integration.id));

    expect(before.repositories).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.warnings).toEqual([
      'Connected, but the repository list could not be loaded. Refresh the project list from the GitLab integration page.',
    ]);
    expect(after.repositories).toBeNull();
    expect(after.repositories_synced_at).toBeNull();
  });

  it('reports a rejected project token creation as a reconnect error', async () => {
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
    mockCreateProjectAccessToken.mockRejectedValueOnce(
      new GitLabAuthenticationError(
        42,
        401,
        'GitLab rejected the credential while creating a Project Access Token for project 42 (HTTP 401). Reconnect the GitLab integration and try again.'
      )
    );

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message:
        'GitLab rejected the connected credential. Reconnect the GitLab integration and try again.',
    });
  });

  it('reports a refused project token role as a permission error', async () => {
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
    mockCreateProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(
        42,
        403,
        'Insufficient permissions to create Project Access Token for project 42. Requires Maintainer role or higher.'
      )
    );

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: expect.stringContaining('You need Maintainer role or higher'),
    });
  });

  it('revokes the replaced project token before creating its replacement', async () => {
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
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: nearExpiry,
          authorizedAccountId: '123',
        },
      })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );

    const adapterCalls: string[] = [];
    mockRotateProjectAccessToken.mockImplementationOnce(async () => {
      adapterCalls.push('rotate');
      throw new Error('rotation failed');
    });
    mockRevokeProjectAccessToken.mockImplementationOnce(async () => {
      adapterCalls.push('revoke');
    });
    mockCreateProjectAccessToken.mockImplementationOnce(async () => {
      adapterCalls.push('create');
      return {
        id: 888,
        name: 'Kilo Code Review Bot',
        token: '$$CREDENTIAL_QWERTYUIOPAS:L$$',
        expires_at: '2027-07-13',
        scopes: ['api', 'self_rotate'],
        access_level: 30,
        active: true,
        revoked: false,
        created_at: '2026-07-13T00:00:00.000Z',
        last_used_at: null,
        user_id: 123,
      };
    });

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      '$$CREDENTIAL_QWERTYUIOPAS:L$$'
    );

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(adapterCalls).toEqual(['rotate', 'revoke', 'create']);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '42',
      777,
      'https://gitlab.com',
      undefined
    );
    expect(credential.provider_metadata).toEqual(
      expect.objectContaining({ providerCredentialId: '888' })
    );
  });

  it('keeps the stored project token when a failed rotation cannot revoke it', async () => {
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
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: nearExpiry,
          authorizedAccountId: '123',
        },
      })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    mockRotateProjectAccessToken.mockRejectedValueOnce(new Error('rotation failed'));
    mockCreateProjectAccessToken.mockClear();
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(42, 403, 'x')
    );

    const refusal = await getOrCreateProjectAccessToken(integration, 42, {
      userId: user.id,
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('GitLab refused the connected credential');
    expect(refusalMessage).toContain(
      'Disconnect the integration, then reconnect the current instance with a credential that can revoke them.'
    );

    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(credential.provider_metadata).toEqual(
      expect.objectContaining({ providerCredentialId: '777' })
    );
    expect(mockCreateProjectAccessToken).not.toHaveBeenCalled();
  });

  it('refuses a replacement when the stored instance record cannot be read', async () => {
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
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: nearExpiry,
          authorizedAccountId: '123',
        },
      })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    await db
      .update(platform_integrations)
      .set({ metadata: null })
      .where(eq(platform_integrations.id, connected.integration.id));
    [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    mockRotateProjectAccessToken.mockRejectedValueOnce(new Error('rotation failed'));
    mockCreateProjectAccessToken.mockClear();

    const refusal = await getOrCreateProjectAccessToken(integration, 42, {
      userId: user.id,
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('the stored GitLab instance address could not be used');
    expect(refusalMessage).toContain(
      'Ask Kilo support to repair the stored integration record, then reconnect.'
    );
    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    expect(mockCreateProjectAccessToken).not.toHaveBeenCalled();
  });

  it('retries an unconfirmed revocation before refusing the replacement', async () => {
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
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: nearExpiry,
          authorizedAccountId: '123',
        },
      })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    mockRotateProjectAccessToken.mockRejectedValueOnce(new Error('rotation failed'));
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenRevocationError(42, 503, 'GitLab responded with HTTP 503.')
    );
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenRevocationError(42, 503, 'GitLab responded with HTTP 503.')
    );
    mockCreateProjectAccessToken.mockClear();

    const refusal = await getOrCreateProjectAccessToken(integration, 42, {
      userId: user.id,
    }).catch((error: unknown) => error);

    expect(refusal).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const refusalMessage = refusal instanceof Error ? refusal.message : '';
    expect(refusalMessage).toContain('a revocation could not be confirmed');
    expect(refusalMessage).toContain('Try again in a moment.');
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(2);
    expect(mockCreateProjectAccessToken).not.toHaveBeenCalled();
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(credential.provider_metadata).toEqual(
      expect.objectContaining({ providerCredentialId: '777' })
    );
  });

  it('creates the replacement when the retried revocation succeeds', async () => {
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
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: nearExpiry,
          authorizedAccountId: '123',
        },
      })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    mockRotateProjectAccessToken.mockRejectedValueOnce(new Error('rotation failed'));
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenRevocationError(42, 503, 'GitLab responded with HTTP 503.')
    );
    mockCreateProjectAccessToken.mockImplementationOnce(async () => ({
      id: 888,
      name: 'Kilo Code Review Bot',
      token: '$$CREDENTIAL_QWERTYUIOPAS:L$$',
      expires_at: '2027-07-13',
      scopes: ['api', 'self_rotate'],
      access_level: 30,
      active: true,
      revoked: false,
      created_at: '2026-07-13T00:00:00.000Z',
      last_used_at: null,
      user_id: 123,
    }));

    await expect(getOrCreateProjectAccessToken(integration, 42, { userId: user.id })).resolves.toBe(
      '$$CREDENTIAL_QWERTYUIOPAS:L$$'
    );

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(2);
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(credential.provider_metadata).toEqual(
      expect.objectContaining({ providerCredentialId: '888' })
    );
  });

  it('settles only the credential the failed rotation tried to replace', async () => {
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
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: nearExpiry,
          authorizedAccountId: '123',
        },
      })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );

    mockRotateProjectAccessToken.mockImplementationOnce(async () => {
      await db
        .update(platform_access_token_credentials)
        .set({
          provider_metadata: {
            providerCredentialId: '888',
            expiresOn: '2027-07-13',
            authorizedAccountId: '123',
          },
        })
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
            eq(platform_access_token_credentials.provider_resource_id, '42')
          )
        );
      throw new Error('rotation failed');
    });
    mockRevokeProjectAccessToken.mockClear();
    mockCreateProjectAccessToken.mockClear();

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockRevokeProjectAccessToken).not.toHaveBeenCalled();
    expect(mockCreateProjectAccessToken).not.toHaveBeenCalled();
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(credential.provider_metadata).toEqual(
      expect.objectContaining({ providerCredentialId: '888' })
    );
  });

  it('refuses a replacement when another writer settles the replaced credential first', async () => {
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
    const nearExpiry = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    await db
      .update(platform_access_token_credentials)
      .set({
        provider_metadata: {
          providerCredentialId: '777',
          expiresOn: nearExpiry,
          authorizedAccountId: '123',
        },
      })
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    mockRotateProjectAccessToken.mockRejectedValueOnce(new Error('rotation failed'));
    mockRevokeProjectAccessToken.mockImplementationOnce(async () => {
      await db
        .update(platform_access_token_credentials)
        .set({
          credential_version: 2,
          provider_metadata: {
            providerCredentialId: '888',
            expiresOn: '2027-07-13',
            authorizedAccountId: '123',
          },
        })
        .where(
          and(
            eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
            eq(platform_access_token_credentials.provider_resource_id, '42')
          )
        );
    });
    mockCreateProjectAccessToken.mockClear();

    await expect(
      getOrCreateProjectAccessToken(integration, 42, { userId: user.id })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockRevokeProjectAccessToken).toHaveBeenCalledTimes(1);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-primary-token',
      '42',
      777,
      'https://gitlab.com',
      undefined
    );
    expect(mockCreateProjectAccessToken).not.toHaveBeenCalled();
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        and(
          eq(platform_access_token_credentials.platform_integration_id, connected.integration.id),
          eq(platform_access_token_credentials.provider_resource_id, '42')
        )
      );
    expect(credential.provider_metadata).toEqual(
      expect.objectContaining({ providerCredentialId: '888' })
    );
    expect(credential.credential_version).toBe(2);
  });

  it('revokes a legacy project token id when the connected account changes', async () => {
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
            '99': {
              token_id: 999,
              token: 'glpat-legacy',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'x',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, connected.integration.id));
    mockValidatePersonalAccessToken.mockResolvedValueOnce({
      ...validationResult,
      user: { ...validationResult.user, id: 456, username: 'other-user' },
    });

    const result = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-second-token',
      'https://gitlab.com',
      user.id
    );

    const [updated] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    expect(result.success).toBe(true);
    expect(mockRevokeProjectAccessToken).toHaveBeenCalledWith(
      'glpat-second-token',
      '99',
      999,
      'https://gitlab.com',
      expect.any(AbortSignal)
    );
    expect(updated.metadata).toEqual(expect.objectContaining({ project_tokens: {} }));
  });

  it('keeps a legacy project token entry when the account change cannot revoke it', async () => {
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
            '99': {
              token_id: 999,
              token: 'glpat-legacy',
              expires_at: '2027-07-13',
              created_at: '2026-07-13T00:00:00.000Z',
              name: 'x',
            },
          },
        },
      })
      .where(eq(platform_integrations.id, connected.integration.id));
    mockValidatePersonalAccessToken.mockResolvedValueOnce({
      ...validationResult,
      user: { ...validationResult.user, id: 456, username: 'other-user' },
    });
    mockRevokeProjectAccessToken.mockRejectedValueOnce(
      new GitLabProjectAccessTokenPermissionError(99, 403, 'x')
    );

    const result = await connectWithPAT(
      { type: 'user', id: user.id },
      'glpat-second-token',
      'https://gitlab.com',
      user.id
    );

    const [updated] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integration.id));
    expect(result.success).toBe(true);
    expect(updated.metadata).toEqual(
      expect.objectContaining({
        project_tokens: { '99': expect.objectContaining({ token_id: 999 }) },
      })
    );
  });
});
