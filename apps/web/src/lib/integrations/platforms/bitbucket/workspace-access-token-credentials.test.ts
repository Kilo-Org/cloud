/* eslint-disable drizzle/enforce-delete-with-where */
import { generateKeyPairSync } from 'node:crypto';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import {
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
  buildBitbucketWorkspaceAccessTokenAad,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { db } from '@/lib/drizzle';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kilocode_users,
  organization_audit_logs,
  organization_memberships,
  organizations,
  platform_access_token_credentials,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import type * as OrganizationAuditLogsModule from '@/lib/organizations/organization-audit-logs';

import {
  connectBitbucketWorkspaceAccessToken,
  disconnectBitbucketWorkspaceAccessToken,
  rotateBitbucketWorkspaceAccessToken,
} from './workspace-access-token-credentials';
import {
  getBitbucketWorkspaceAccessTokenStatus,
  readCachedBitbucketWorkspaceAccessTokenRepositories,
} from './workspace-access-token-repository-cache';

jest.mock('@/lib/organizations/organization-audit-logs', () => {
  const actual = jest.requireActual<typeof OrganizationAuditLogsModule>(
    '@/lib/organizations/organization-audit-logs'
  );
  return { ...actual, createAuditLog: jest.fn(actual.createAuditLog) };
});

const actualCreateAuditLog = jest.requireActual<typeof OrganizationAuditLogsModule>(
  '@/lib/organizations/organization-audit-logs'
).createAuditLog;
const mockCreateAuditLog = jest.mocked(createAuditLog);

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const mockBitbucketCredentialEncryptionConfig = {
  keyId: 'bitbucket-workspace-token-key-v1',
  publicKey: Buffer.from(testKeyPair.publicKey).toString('base64'),
};

jest.mock('@/lib/config.server', () => ({
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID() {
    return mockBitbucketCredentialEncryptionConfig.keyId;
  },
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY() {
    return mockBitbucketCredentialEncryptionConfig.publicKey;
  },
}));

const ACCESS_TOKEN = 'ATCT-connect-workspace-secret';
const WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';
const REPOSITORY_UUID = '22222222-2222-4222-8222-222222222222';

function authenticatedJson(
  body: unknown,
  scopeHeader = 'account repository repository:write pullrequest webhook'
): Response {
  return Response.json(body, {
    headers: {
      'X-Credential-Type': 'workspace_access_token',
      'X-OAuth-Scopes': scopeHeader,
    },
  });
}

function credentialPrivateKeys() {
  return {
    active: {
      keyId: mockBitbucketCredentialEncryptionConfig.keyId,
      privateKeyPem: testKeyPair.privateKey,
    },
  };
}

function mockSuccessfulProviderValidation(
  options: {
    displayName?: string;
    repositoryUuid?: string;
    repositoryName?: string;
    repositorySlug?: string;
    scopeHeader?: string;
    emptyRepositories?: boolean;
    beforeRepositoriesResponse?: () => Promise<void>;
  } = {}
): jest.SpiedFunction<typeof fetch> {
  const repositoryUuid = options.repositoryUuid ?? REPOSITORY_UUID;
  const repositoryName = options.repositoryName ?? 'API';
  const repositorySlug = options.repositorySlug ?? 'api';
  return jest
    .spyOn(global, 'fetch')
    .mockResolvedValueOnce(
      authenticatedJson(
        {
          pagelen: 2,
          values: [{ workspace: { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme' } }],
        },
        options.scopeHeader
      )
    )
    .mockResolvedValueOnce(
      authenticatedJson(
        {
          uuid: `{${WORKSPACE_UUID}}`,
          slug: 'acme',
          name: options.displayName ?? 'Acme Workspace',
        },
        options.scopeHeader
      )
    )
    .mockResolvedValueOnce(authenticatedJson({ pagelen: 1, values: [] }, options.scopeHeader))
    .mockImplementationOnce(async () => {
      await options.beforeRepositoriesResponse?.();
      return authenticatedJson(
        {
          pagelen: 50,
          values: options.emptyRepositories
            ? []
            : [
                {
                  uuid: `{${repositoryUuid}}`,
                  name: repositoryName,
                  slug: repositorySlug,
                  full_name: `acme/${repositorySlug}`,
                  is_private: true,
                  workspace: { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme' },
                  mainbranch: { name: 'main' },
                },
              ],
        },
        options.scopeHeader
      );
    });
}

describe('Bitbucket Workspace Access Token credentials', () => {
  beforeEach(() => {
    mockCreateAuditLog.mockImplementation(actualCreateAuditLog);
    mockBitbucketCredentialEncryptionConfig.keyId = 'bitbucket-workspace-token-key-v1';
    mockBitbucketCredentialEncryptionConfig.publicKey = Buffer.from(testKeyPair.publicKey).toString(
      'base64'
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(organization_audit_logs);
    await db.delete(platform_access_token_credentials);
    await db.delete(platform_integrations);
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it('atomically connects an organization workspace with encrypted credentials, initialized cache, and audit', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Acme Organization', actor.id, 0);
    mockSuccessfulProviderValidation();

    const result = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, result.integrationId));
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, result.integrationId));
    const [audit] = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
    if (!integration || !credential || !audit) {
      throw new Error('Expected the complete Bitbucket organization integration');
    }

    expect(result).toEqual({
      integrationId: integration.id,
      workspace: {
        uuid: WORKSPACE_UUID,
        slug: 'acme',
        displayName: 'Acme Workspace',
      },
      credentialVersion: 1,
      repositoryCount: 1,
      validatedAt: expect.any(String),
      unexpectedScopes: [],
    });
    expect(integration).toEqual(
      expect.objectContaining({
        owned_by_organization_id: organization.id,
        owned_by_user_id: null,
        created_by_user_id: actor.id,
        platform: 'bitbucket',
        integration_type: 'workspace_access_token',
        platform_account_id: WORKSPACE_UUID,
        platform_account_login: 'acme',
        platform_installation_id: null,
        permissions: null,
        scopes: null,
        repository_access: 'all',
        repositories: [
          {
            id: REPOSITORY_UUID,
            name: 'API',
            full_name: 'acme/api',
            private: true,
            default_branch: 'main',
          },
        ],
        integration_status: 'active',
        auth_invalid_at: null,
        auth_invalid_reason: null,
        metadata: { displayName: 'Acme Workspace' },
      })
    );
    expect(new Date(integration.repositories_synced_at ?? '').toISOString()).toBe(
      result.validatedAt
    );
    expect(credential).toEqual(
      expect.objectContaining({
        platform_integration_id: integration.id,
        owned_by_organization_id: null,
        platform: null,
        integration_type: null,
        expires_at: null,
        provider_credential_type: 'workspace_access_token',
        provider_scopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
        credential_version: 1,
      })
    );
    expect(new Date(credential.provider_verified_at).toISOString()).toBe(result.validatedAt);
    expect(new Date(credential.last_validated_at).toISOString()).toBe(result.validatedAt);

    const aad = buildBitbucketWorkspaceAccessTokenAad({
      credentialId: credential.id,
      integrationId: integration.id,
      organizationId: organization.id,
      credentialVersion: 1,
    });
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        {
          active: {
            keyId: mockBitbucketCredentialEncryptionConfig.keyId,
            privateKeyPem: testKeyPair.privateKey,
          },
        },
        aad
      )
    ).toBe(ACCESS_TOKEN);

    expect(audit).toEqual(
      expect.objectContaining({
        action: 'organization.settings.change',
        actor_id: actor.id,
        actor_email: actor.google_user_email,
        actor_name: actor.google_user_name,
        organization_id: organization.id,
      })
    );
    expect(audit.message).toContain('connected');
    expect(audit.message).toContain(integration.id);
    expect(audit.message).toContain(WORKSPACE_UUID);
    expect(audit.message).toContain('acme');

    const persistedAndReturned = JSON.stringify({ result, integration, credential, audit });
    expect(persistedAndReturned).not.toContain(ACCESS_TOKEN);
    expect(integration.metadata).toEqual({ displayName: 'Acme Workspace' });
  });

  it('connects tokens with additional permissions and reports them for warning', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Broad Scope Organization', actor.id, 0);
    mockSuccessfulProviderValidation({
      scopeHeader:
        'account repository repository:write pullrequest webhook pipeline:write repository:admin',
    });

    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });

    expect(connected.unexpectedScopes).toEqual(['pipeline:write', 'repository:admin']);
    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'connected',
      unexpectedScopes: ['pipeline:write', 'repository:admin'],
    });
  });

  it('connects an empty workspace with an initialized available cache', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Empty Workspace Organization', actor.id, 0);
    mockSuccessfulProviderValidation({ emptyRepositories: true });

    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });

    expect(connected.repositoryCount).toBe(0);
    await expect(getBitbucketWorkspaceAccessTokenStatus(organization.id)).resolves.toMatchObject({
      status: 'connected',
      repositoryCache: {
        status: 'available',
        repositories: [],
        syncedAt: expect.any(String),
      },
    });
    await expect(
      readCachedBitbucketWorkspaceAccessTokenRepositories({ organizationId: organization.id })
    ).resolves.toMatchObject({
      status: 'available',
      repositories: [],
      syncedAt: expect.any(String),
    });

    const [integration] = await db
      .select({
        repositories: platform_integrations.repositories,
        syncedAt: platform_integrations.repositories_synced_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    expect(integration?.repositories).toEqual([]);
    expect(integration?.syncedAt).not.toBeNull();
  });

  it('uses one canonical organization UUID for connect, rotation, AAD, persistence, and disconnect', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Canonical Organization', actor.id, 0);
    const uppercaseOrganizationId = organization.id.toUpperCase();
    mockSuccessfulProviderValidation();

    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: uppercaseOrganizationId,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });
    const [connectedCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );
    if (!connectedCredential) throw new Error('Expected connected credential');

    expect(connectedCredential.owned_by_organization_id).toBeNull();
    expect(
      decryptKeyedEnvelope(
        connectedCredential.token_encrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        credentialPrivateKeys(),
        buildBitbucketWorkspaceAccessTokenAad({
          credentialId: connectedCredential.id,
          integrationId: connected.integrationId,
          organizationId: organization.id,
          credentialVersion: 1,
        })
      )
    ).toBe(ACCESS_TOKEN);

    const replacementToken = 'ATCT-canonical-rotation-secret';
    mockSuccessfulProviderValidation();
    const rotated = await rotateBitbucketWorkspaceAccessToken({
      organizationId: uppercaseOrganizationId,
      actorUserId: actor.id,
      integrationId: connected.integrationId,
      accessToken: replacementToken,
    });
    const [rotatedCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );
    if (!rotatedCredential) throw new Error('Expected rotated credential');

    expect(
      decryptKeyedEnvelope(
        rotatedCredential.token_encrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        credentialPrivateKeys(),
        buildBitbucketWorkspaceAccessTokenAad({
          credentialId: rotatedCredential.id,
          integrationId: connected.integrationId,
          organizationId: organization.id,
          credentialVersion: rotated.credentialVersion,
        })
      )
    ).toBe(replacementToken);

    await expect(
      disconnectBitbucketWorkspaceAccessToken({
        organizationId: uppercaseOrganizationId,
        actorUserId: actor.id,
        integrationId: connected.integrationId,
      })
    ).resolves.toEqual({ integrationId: connected.integrationId });
    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organization.id))
    ).resolves.toEqual([]);
  });

  it('does not let a stale initial connect overwrite a newer Workspace Access Token integration', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization(
      'Concurrent Connect Organization',
      actor.id,
      0
    );
    const winnerToken = 'ATCT-newer-connect-secret';
    const winnerRepositoryUuid = '33333333-3333-4333-8333-333333333333';
    let winner: Awaited<ReturnType<typeof connectBitbucketWorkspaceAccessToken>> | undefined;
    mockSuccessfulProviderValidation({
      displayName: 'Stale Workspace',
      beforeRepositoriesResponse: async () => {
        mockSuccessfulProviderValidation({
          displayName: 'Current Workspace',
          repositoryUuid: winnerRepositoryUuid,
          repositoryName: 'Web',
          repositorySlug: 'web',
        });
        winner = await connectBitbucketWorkspaceAccessToken({
          organizationId: organization.id,
          actorUserId: actor.id,
          accessToken: winnerToken,
        });
      },
    });

    await expect(
      connectBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        accessToken: 'ATCT-stale-connect-secret',
      })
    ).rejects.toMatchObject({ code: 'credential_conflict' });
    if (!winner) throw new Error('Expected the newer connection to win');

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(eq(platform_access_token_credentials.platform_integration_id, winner.integrationId));
    const audits = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
    if (!integration || !credential) throw new Error('Expected the winning connection');

    expect(integration).toEqual(
      expect.objectContaining({
        id: winner.integrationId,
        metadata: { displayName: 'Current Workspace' },
        repositories: [
          {
            id: winnerRepositoryUuid,
            name: 'Web',
            full_name: 'acme/web',
            private: true,
            default_branch: 'main',
          },
        ],
      })
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).toContain(winner.integrationId);
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        credentialPrivateKeys(),
        buildBitbucketWorkspaceAccessTokenAad({
          credentialId: credential.id,
          integrationId: winner.integrationId,
          organizationId: organization.id,
          credentialVersion: 1,
        })
      )
    ).toBe(winnerToken);
  });

  it('requires disconnect before replacing an existing OAuth integration', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Dormant OAuth Organization', actor.id, 0);
    const [oauthIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        owned_by_user_id: null,
        created_by_user_id: actor.id,
        platform: 'bitbucket',
        integration_type: 'oauth',
        platform_account_id: WORKSPACE_UUID,
        platform_account_login: 'old-oauth-workspace',
        repository_access: 'all',
        integration_status: 'inactive',
        metadata: {},
      })
      .returning();
    if (!oauthIntegration) throw new Error('Expected dormant OAuth integration');
    mockSuccessfulProviderValidation();

    await expect(
      connectBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'credential_conflict' });

    await expect(
      db
        .select({ id: platform_integrations.id, type: platform_integrations.integration_type })
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organization.id))
    ).resolves.toEqual([{ id: oauthIntegration.id, type: 'oauth' }]);
  });

  it('rotates the fenced credential generation and atomically replaces cache and invalidation state', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Rotation Organization', actor.id, 0);
    mockSuccessfulProviderValidation();
    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });
    const [oldCredential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );
    if (!oldCredential) throw new Error('Expected initial credential');
    await db
      .update(platform_integrations)
      .set({
        auth_invalid_at: '2026-06-01T00:00:00.000Z',
        auth_invalid_reason: 'provider_rejected',
      })
      .where(eq(platform_integrations.id, connected.integrationId));

    const replacementToken = 'ATCT-rotated-workspace-secret';
    const replacementRepositoryUuid = '33333333-3333-4333-8333-333333333333';
    mockSuccessfulProviderValidation({
      displayName: 'Acme Workspace Renamed',
      repositoryUuid: replacementRepositoryUuid,
      repositoryName: 'Web',
      repositorySlug: 'web',
      scopeHeader: 'pullrequest repository:write account webhook',
    });
    const rotated = await rotateBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      integrationId: connected.integrationId,
      accessToken: replacementToken,
    });

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );
    const audits = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
    if (!integration || !credential) throw new Error('Expected rotated integration');

    expect(rotated).toEqual({
      integrationId: connected.integrationId,
      workspace: {
        uuid: WORKSPACE_UUID,
        slug: 'acme',
        displayName: 'Acme Workspace Renamed',
      },
      credentialVersion: 2,
      repositoryCount: 1,
      validatedAt: expect.any(String),
      unexpectedScopes: [],
    });
    expect(credential.id).toBe(oldCredential.id);
    expect(credential.credential_version).toBe(2);
    expect(credential.token_encrypted).not.toBe(oldCredential.token_encrypted);
    expect(credential.provider_scopes).toEqual([
      'account',
      'pullrequest',
      'repository:write',
      'webhook',
    ]);
    expect(credential.expires_at).toBeNull();
    expect(new Date(credential.provider_verified_at).toISOString()).toBe(rotated.validatedAt);
    expect(new Date(credential.last_validated_at).toISOString()).toBe(rotated.validatedAt);
    expect(integration).toEqual(
      expect.objectContaining({
        auth_invalid_at: null,
        auth_invalid_reason: null,
        metadata: { displayName: 'Acme Workspace Renamed' },
        repositories: [
          {
            id: replacementRepositoryUuid,
            name: 'Web',
            full_name: 'acme/web',
            private: true,
            default_branch: 'main',
          },
        ],
      })
    );
    expect(new Date(integration.repositories_synced_at ?? '').toISOString()).toBe(
      rotated.validatedAt
    );

    const privateKeys = {
      active: {
        keyId: mockBitbucketCredentialEncryptionConfig.keyId,
        privateKeyPem: testKeyPair.privateKey,
      },
    };
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        privateKeys,
        buildBitbucketWorkspaceAccessTokenAad({
          credentialId: credential.id,
          integrationId: integration.id,
          organizationId: organization.id,
          credentialVersion: 2,
        })
      )
    ).toBe(replacementToken);
    expect(() =>
      decryptKeyedEnvelope(
        credential.token_encrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        privateKeys,
        buildBitbucketWorkspaceAccessTokenAad({
          credentialId: credential.id,
          integrationId: integration.id,
          organizationId: organization.id,
          credentialVersion: 1,
        })
      )
    ).toThrow();

    expect(audits).toHaveLength(2);
    expect(audits.map(audit => audit.message)).toEqual([
      expect.stringContaining('connected'),
      expect.stringContaining('rotated'),
    ]);
    expect(JSON.stringify({ rotated, integration, credential, audits })).not.toContain(
      replacementToken
    );
  });

  it('rolls back credential, cache, invalidation, and audit when rotation audit writing fails', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Audit Rollback Organization', actor.id, 0);
    mockSuccessfulProviderValidation();
    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });
    await db
      .update(platform_integrations)
      .set({
        auth_invalid_at: '2026-06-01T00:00:00.000Z',
        auth_invalid_reason: 'provider_rejected',
      })
      .where(eq(platform_integrations.id, connected.integrationId));
    const [integrationBefore] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [credentialBefore] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );
    if (!integrationBefore || !credentialBefore) throw new Error('Expected connected integration');

    mockSuccessfulProviderValidation({
      displayName: 'Must Roll Back',
      repositoryUuid: '88888888-8888-4888-8888-888888888888',
      repositoryName: 'Rollback',
      repositorySlug: 'rollback',
    });
    mockCreateAuditLog.mockRejectedValueOnce(new Error('audit write failed'));

    await expect(
      rotateBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        integrationId: connected.integrationId,
        accessToken: 'ATCT-audit-rollback-secret',
      })
    ).rejects.toThrow('audit write failed');

    const [integrationAfter] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [credentialAfter] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );
    const audits = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));

    expect(credentialAfter).toEqual(credentialBefore);
    expect(integrationAfter).toEqual(integrationBefore);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.message).toContain('connected');
  });

  it('preserves the winning rotation when the credential generation changes during validation', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization(
      'Concurrent Rotation Organization',
      actor.id,
      0
    );
    mockSuccessfulProviderValidation();
    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });
    const winnerToken = 'ATCT-winning-rotation-secret';
    const winnerRepositoryUuid = '44444444-4444-4444-8444-444444444444';
    let winner: Awaited<ReturnType<typeof rotateBitbucketWorkspaceAccessToken>> | undefined;
    mockSuccessfulProviderValidation({
      displayName: 'Stale Rotation Workspace',
      beforeRepositoriesResponse: async () => {
        mockSuccessfulProviderValidation({
          displayName: 'Winning Rotation Workspace',
          repositoryUuid: winnerRepositoryUuid,
          repositoryName: 'Worker',
          repositorySlug: 'worker',
        });
        winner = await rotateBitbucketWorkspaceAccessToken({
          organizationId: organization.id,
          actorUserId: actor.id,
          integrationId: connected.integrationId,
          accessToken: winnerToken,
        });
      },
    });

    await expect(
      rotateBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        integrationId: connected.integrationId,
        accessToken: 'ATCT-stale-rotation-secret',
      })
    ).rejects.toMatchObject({ code: 'credential_conflict' });
    if (!winner) throw new Error('Expected the newer rotation to win');

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [credential] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );
    const audits = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
    if (!integration || !credential) throw new Error('Expected the winning rotation');

    expect(credential.credential_version).toBe(winner.credentialVersion);
    expect(integration).toEqual(
      expect.objectContaining({
        metadata: { displayName: 'Winning Rotation Workspace' },
        repositories: [
          {
            id: winnerRepositoryUuid,
            name: 'Worker',
            full_name: 'acme/worker',
            private: true,
            default_branch: 'main',
          },
        ],
      })
    );
    expect(audits).toHaveLength(2);
    expect(audits.map(audit => audit.message)).toEqual([
      expect.stringContaining('connected'),
      expect.stringContaining('rotated'),
    ]);
    expect(
      decryptKeyedEnvelope(
        credential.token_encrypted,
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        credentialPrivateKeys(),
        buildBitbucketWorkspaceAccessTokenAad({
          credentialId: credential.id,
          integrationId: connected.integrationId,
          organizationId: organization.id,
          credentialVersion: winner.credentialVersion,
        })
      )
    ).toBe(winnerToken);
  });

  it('preserves the current credential and cache when replacement validation fails', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization(
      'Validation Failure Organization',
      actor.id,
      0
    );
    mockSuccessfulProviderValidation();
    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });
    const [integrationBefore] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [credentialBefore] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );

    const rejectedToken = 'ATCT-rejected-rotation-secret';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(
      Response.json(
        {
          pagelen: 2,
          values: [{ workspace: { uuid: `{${WORKSPACE_UUID}}`, slug: 'acme' } }],
        },
        {
          headers: {
            'X-Credential-Type': 'oauth2',
            'X-OAuth-Scopes': 'account repository repository:write pullrequest webhook',
          },
        }
      )
    );

    await expect(
      rotateBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        integrationId: connected.integrationId,
        accessToken: rejectedToken,
      })
    ).rejects.toMatchObject({ code: 'credential_type_invalid' });

    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, connected.integrationId))
    ).resolves.toEqual([integrationBefore]);
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
        )
    ).resolves.toEqual([credentialBefore]);
    await expect(
      db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organization.id))
    ).resolves.toHaveLength(1);
  });

  it('preserves the current integration when replacement encryption fails', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization(
      'Encryption Failure Organization',
      actor.id,
      0
    );
    mockSuccessfulProviderValidation();
    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });
    const integrationsBefore = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organization.id));
    const credentialsBefore = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );

    mockSuccessfulProviderValidation({ displayName: 'Replacement Workspace' });
    mockBitbucketCredentialEncryptionConfig.publicKey =
      Buffer.from('not-an-rsa-public-key').toString('base64');
    await expect(
      connectBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        accessToken: 'ATCT-unencrypted-replacement-secret',
      })
    ).rejects.toMatchObject({ code: 'encryption_failed' });

    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organization.id))
    ).resolves.toEqual(integrationsBefore);
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
        )
    ).resolves.toEqual(credentialsBefore);
    expect(integrationsBefore).toEqual([expect.objectContaining({ id: connected.integrationId })]);
    await expect(
      db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organization.id))
    ).resolves.toHaveLength(1);
  });

  it('atomically audits disconnect and cascades the organization credential', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Disconnect Organization', actor.id, 0);
    mockSuccessfulProviderValidation();
    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });

    await expect(
      disconnectBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        integrationId: connected.integrationId,
      })
    ).resolves.toEqual({ integrationId: connected.integrationId });

    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, connected.integrationId))
    ).resolves.toEqual([]);
    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
        )
    ).resolves.toEqual([]);
    const audits = await db
      .select()
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organization.id));
    expect(audits).toHaveLength(2);
    expect(audits[1]).toEqual(
      expect.objectContaining({
        action: 'organization.settings.change',
        actor_id: actor.id,
        message: expect.stringContaining('disconnected'),
      })
    );
    expect(audits[1]?.message).toContain(connected.integrationId);
    expect(audits[1]?.message).toContain(WORKSPACE_UUID);
    expect(JSON.stringify(audits)).not.toContain(ACCESS_TOKEN);
  });

  it('revalidates the current organization role inside the locked mutation transaction', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization(
      'Role Revalidation Organization',
      actor.id,
      0
    );
    mockSuccessfulProviderValidation();
    const connected = await connectBitbucketWorkspaceAccessToken({
      organizationId: organization.id,
      actorUserId: actor.id,
      accessToken: ACCESS_TOKEN,
    });
    const [credentialBefore] = await db
      .select()
      .from(platform_access_token_credentials)
      .where(
        eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
      );

    mockSuccessfulProviderValidation({
      beforeRepositoriesResponse: async () => {
        await db
          .delete(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, organization.id),
              eq(organization_memberships.kilo_user_id, actor.id)
            )
          );
      },
    });
    await expect(
      rotateBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        integrationId: connected.integrationId,
        accessToken: 'ATCT-role-revalidation-secret',
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });

    await expect(
      db
        .select()
        .from(platform_access_token_credentials)
        .where(
          eq(platform_access_token_credentials.platform_integration_id, connected.integrationId)
        )
    ).resolves.toEqual([credentialBefore]);
    await expect(
      db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organization.id))
    ).resolves.toHaveLength(1);
  });

  it.each(['billing_manager', 'platform_admin'] as const)(
    'allows a current unblocked %s to connect and records that actor',
    async actorKind => {
      const organizationOwner = await insertTestUser();
      const actor = await insertTestUser();
      const organization = await createTestOrganization(
        `${actorKind} Organization`,
        organizationOwner.id,
        0
      );
      if (actorKind === 'billing_manager') {
        await db.insert(organization_memberships).values({
          organization_id: organization.id,
          kilo_user_id: actor.id,
          role: 'billing_manager',
        });
      } else {
        await db
          .update(kilocode_users)
          .set({ is_admin: true })
          .where(eq(kilocode_users.id, actor.id));
      }
      mockSuccessfulProviderValidation();

      const connected = await connectBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        accessToken: ACCESS_TOKEN,
      });

      const [audit] = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organization.id));
      expect(connected.workspace.uuid).toBe(WORKSPACE_UUID);
      expect(audit).toEqual(expect.objectContaining({ actor_id: actor.id }));
    }
  );

  it('rejects an invalid organization ID before authority or provider access', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(
      connectBitbucketWorkspaceAccessToken({
        organizationId: 'not-an-organization-uuid',
        actorUserId: 'unresolved-actor',
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'invalid_organization_id' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a blocked organization owner before sending the credential to Bitbucket', async () => {
    const actor = await insertTestUser();
    const organization = await createTestOrganization('Blocked Owner Organization', actor.id, 0);
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'policy_violation' })
      .where(eq(kilocode_users.id, actor.id));
    const fetchMock = jest.spyOn(global, 'fetch');

    await expect(
      connectBitbucketWorkspaceAccessToken({
        organizationId: organization.id,
        actorUserId: actor.id,
        accessToken: ACCESS_TOKEN,
      })
    ).rejects.toMatchObject({ code: 'unauthorized' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organization.id))
    ).resolves.toEqual([]);
  });
});
