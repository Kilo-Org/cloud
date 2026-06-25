import { generateKeyPairSync } from 'node:crypto';
import { getWorkerDb } from '@kilocode/db/client';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import {
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
  buildBitbucketWorkspaceAccessTokenAad,
  type BitbucketWorkspaceAccessTokenInvalidationReason,
} from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import { describe, expect, it } from 'vitest';
import {
  BitbucketWorkspaceAccessTokenAuthorizationService,
  buildBitbucketWorkspaceAccessTokenAuthorizationQuery,
  buildBitbucketWorkspaceAccessTokenCredentialGenerationQuery,
  buildBitbucketWorkspaceAccessTokenInvalidationQuery,
  buildBitbucketWorkspaceAccessTokenMarkUsedQuery,
  withBitbucketWorkspaceAccessTokenOrganizationLock,
  type BitbucketWorkspaceAccessTokenAuthorizationCandidate,
  type BitbucketWorkspaceAccessTokenAuthorizationFence,
  type BitbucketWorkspaceAccessTokenAuthorizationStore,
} from './bitbucket-workspace-access-token-authorization-service.js';

const organizationId = '123e4567-e89b-12d3-a456-426614174030';
const integrationId = '123e4567-e89b-12d3-a456-426614174031';
const credentialId = '123e4567-e89b-12d3-a456-426614174032';
const workspaceUuid = '123e4567-e89b-12d3-a456-426614174033';
const now = new Date('2026-06-24T10:00:00.000Z');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const mismatchedPublicKeyPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

function fence(candidate: BitbucketWorkspaceAccessTokenAuthorizationCandidate) {
  return {
    organizationId: candidate.organizationId,
    integrationId: candidate.integrationId,
    credentialId: candidate.credentialId,
    credentialVersion: candidate.credentialVersion,
  };
}

function candidate(
  overrides: Partial<BitbucketWorkspaceAccessTokenAuthorizationCandidate> = {}
): BitbucketWorkspaceAccessTokenAuthorizationCandidate {
  const credentialVersion = overrides.credentialVersion ?? 3;
  const tokenEncrypted = encryptKeyedEnvelope(
    'ATCT-runtime-token',
    BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
    { keyId: 'active', publicKeyPem },
    buildBitbucketWorkspaceAccessTokenAad({
      organizationId,
      integrationId,
      credentialId,
      credentialVersion,
    })
  );

  return {
    integrationId,
    credentialId,
    organizationId,
    ownedByUserId: null,
    platform: BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
    integrationType: BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
    integrationStatus: 'active',
    installationId: null,
    accountId: workspaceUuid,
    accountLogin: 'acme',
    authInvalidAt: null,
    credentialPlatform: BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM,
    credentialIntegrationType: BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE,
    tokenEncrypted,
    providerCredentialType: BITBUCKET_WORKSPACE_ACCESS_TOKEN_PROVIDER_CREDENTIAL_TYPE,
    providerScopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
    providerVerifiedAt: '2026-06-24T09:00:00.000Z',
    lastValidatedAt: '2026-06-24T09:00:00.000Z',
    credentialVersion,
    ...overrides,
  };
}

class StatefulAuthorizationStore implements BitbucketWorkspaceAccessTokenAuthorizationStore {
  loadCount = 0;
  used: Array<{ fence: BitbucketWorkspaceAccessTokenAuthorizationFence; at: string }> = [];
  invalidations: Array<{
    fence: BitbucketWorkspaceAccessTokenAuthorizationFence;
    reason: BitbucketWorkspaceAccessTokenInvalidationReason;
    at: string;
  }> = [];

  constructor(public current: BitbucketWorkspaceAccessTokenAuthorizationCandidate | null) {}

  async findAuthorization(): Promise<BitbucketWorkspaceAccessTokenAuthorizationCandidate | null> {
    this.loadCount += 1;
    return this.current;
  }

  async markUsed(
    authorizationFence: BitbucketWorkspaceAccessTokenAuthorizationFence,
    at: string
  ): Promise<boolean> {
    if (
      !this.current ||
      JSON.stringify(fence(this.current)) !== JSON.stringify(authorizationFence)
    ) {
      return false;
    }
    this.used.push({ fence: authorizationFence, at });
    return true;
  }

  async invalidate(
    authorizationFence: BitbucketWorkspaceAccessTokenAuthorizationFence,
    reason: BitbucketWorkspaceAccessTokenInvalidationReason,
    at: string
  ): Promise<boolean> {
    if (
      !this.current ||
      JSON.stringify(fence(this.current)) !== JSON.stringify(authorizationFence)
    ) {
      return false;
    }
    this.invalidations.push({ fence: authorizationFence, reason, at });
    return true;
  }
}

function service(store: StatefulAuthorizationStore, envOverrides: Record<string, unknown> = {}) {
  return new BitbucketWorkspaceAccessTokenAuthorizationService(
    {
      HYPERDRIVE: { connectionString: 'postgres://unused' },
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: 'active',
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(publicKeyPem).toString('base64'),
      BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: Buffer.from(privateKeyPem).toString('base64'),
      ...envOverrides,
    } as CloudflareEnv,
    { store, now: () => now }
  );
}

describe('BitbucketWorkspaceAccessTokenAuthorizationService', () => {
  it('queries an exact organization credential for a current member or platform admin', () => {
    const query = buildBitbucketWorkspaceAccessTokenAuthorizationQuery(
      getWorkerDb('postgres://query-builder'),
      { userId: 'member-1', organizationId }
    ).toSQL();

    expect(query.sql).toContain('inner join "platform_access_token_credentials"');
    expect(query.sql).not.toContain('"platform_access_token_credentials"."expires_at"');
    expect(query.sql).toContain('inner join "kilocode_users"');
    expect(query.sql).toContain('exists (select');
    expect(query.sql).toContain('"organization_memberships"');
    expect(query.sql).toContain('"kilocode_users"."blocked_reason" is null');
    expect(query.sql).toContain('"kilocode_users"."is_admin" =');
    expect(query.sql).toContain('"platform_integrations"."owned_by_user_id" is null');
    expect(query.params).toContain('member-1');
    expect(query.params).toContain(organizationId);
    expect(query.params).toContain(BITBUCKET_WORKSPACE_ACCESS_TOKEN_PLATFORM);
    expect(query.params).toContain(BITBUCKET_WORKSPACE_ACCESS_TOKEN_INTEGRATION_TYPE);
  });

  it('uses exact credential generation fences', () => {
    const db = getWorkerDb('postgres://query-builder');
    const authorizationFence = fence(candidate());

    const generationQuery = buildBitbucketWorkspaceAccessTokenCredentialGenerationQuery(
      db,
      authorizationFence
    ).toSQL();
    expect(generationQuery.sql).toContain('from "platform_access_token_credentials"');
    expect(generationQuery.sql).toContain('"owned_by_organization_id" =');
    expect(generationQuery.sql).toContain('"platform_integration_id" =');
    expect(generationQuery.sql).toContain('"credential_version" =');
    expect(generationQuery.params).toEqual(
      expect.arrayContaining([organizationId, integrationId, credentialId, 3])
    );

    const invalidationQuery = buildBitbucketWorkspaceAccessTokenInvalidationQuery(
      db,
      authorizationFence,
      'provider_rejected',
      now.toISOString()
    ).toSQL();
    expect(invalidationQuery.sql).not.toContain('exists (select');
    expect(invalidationQuery.sql).toContain('update "platform_integrations"');
    expect(invalidationQuery.sql).toContain('"owned_by_organization_id" =');
    expect(invalidationQuery.params).toEqual(
      expect.arrayContaining([organizationId, integrationId, 'provider_rejected'])
    );
  });

  it('acquires the organization transaction lock before the fresh generation recheck', async () => {
    const events: string[] = [];
    const database = {
      transaction: async (
        operation: (tx: { execute: () => Promise<void> }) => Promise<boolean>
      ) => {
        events.push('transaction');
        return operation({
          execute: async () => {
            events.push('lock');
          },
        });
      },
    };

    await expect(
      withBitbucketWorkspaceAccessTokenOrganizationLock(
        database as never,
        organizationId,
        async () => {
          events.push('fresh-generation-recheck');
          return true;
        }
      )
    ).resolves.toBe(true);
    expect(events).toEqual(['transaction', 'lock', 'fresh-generation-recheck']);
  });

  it('makes exact-generation last-used writes monotonic', () => {
    const query = buildBitbucketWorkspaceAccessTokenMarkUsedQuery(
      getWorkerDb('postgres://query-builder'),
      fence(candidate()),
      now.toISOString()
    ).toSQL();

    expect(query.sql).toContain('update "platform_access_token_credentials"');
    expect(query.sql).toContain('"owned_by_organization_id" =');
    expect(query.sql).toContain('"platform_integration_id" =');
    expect(query.sql).toContain('"credential_version" =');
    expect(query.sql).toContain('"last_used_at" is null');
    expect(query.sql).toContain('"last_used_at" <');
    expect(query.params).toEqual(
      expect.arrayContaining([organizationId, integrationId, credentialId, 3, now.toISOString()])
    );
  });

  it.each([undefined, '', 'not-an-organization-id'])(
    'requires a valid organization %j before credential lookup',
    async orgId => {
      const store = new StatefulAuthorizationStore(candidate());

      await expect(service(store).getAuthorization({ userId: 'member-1', orgId })).resolves.toEqual(
        {
          status: 'invalid_request',
        }
      );
      expect(store.loadCount).toBe(0);
    }
  );

  it('decrypts a verified organization Workspace Access Token and fences last use', async () => {
    const storedCandidate = candidate();
    const store = new StatefulAuthorizationStore(storedCandidate);

    await expect(
      service(store).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({
      status: 'available',
      token: 'ATCT-runtime-token',
      organizationId,
      integrationId,
      credentialId,
      credentialVersion: 3,
      workspace: { uuid: workspaceUuid, slug: 'acme' },
    });
    expect(store.used).toEqual([{ fence: fence(storedCandidate), at: now.toISOString() }]);
    expect(store.invalidations).toEqual([]);
  });

  it('treats missing and failed key resolution as temporary without invalidation', async () => {
    const storedCandidate = candidate();
    const missingKeyStore = new StatefulAuthorizationStore(storedCandidate);
    await expect(
      service(missingKeyStore, {
        BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: undefined,
      }).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });

    const missingPublicKeyStore = new StatefulAuthorizationStore(storedCandidate);
    await expect(
      service(missingPublicKeyStore, {
        BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: undefined,
      }).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });

    const failedKeyStore = new StatefulAuthorizationStore(storedCandidate);
    await expect(
      service(failedKeyStore, {
        BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: {
          get: async () => {
            throw new Error('secret store unavailable');
          },
        },
      }).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });

    expect(missingKeyStore.invalidations).toEqual([]);
    expect(missingPublicKeyStore.invalidations).toEqual([]);
    expect(failedKeyStore.invalidations).toEqual([]);
  });

  it.each([
    ['mismatched', Buffer.from(mismatchedPublicKeyPem).toString('base64')],
    ['malformed', Buffer.from('not-a-public-key').toString('base64')],
  ])('treats a %s configured RSA public key as temporary without invalidation', async (_, key) => {
    const store = new StatefulAuthorizationStore(candidate());

    await expect(
      service(store, {
        BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: key,
      }).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(store.used).toEqual([]);
    expect(store.invalidations).toEqual([]);
  });

  it('treats an unavailable envelope key generation as temporary', async () => {
    const retiredEnvelope = encryptKeyedEnvelope(
      'ATCT-runtime-token',
      BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
      { keyId: 'retired', publicKeyPem },
      buildBitbucketWorkspaceAccessTokenAad({
        organizationId,
        integrationId,
        credentialId,
        credentialVersion: 3,
      })
    );
    const store = new StatefulAuthorizationStore(candidate({ tokenEncrypted: retiredEnvelope }));

    await expect(
      service(store).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(store.invalidations).toEqual([]);
  });

  it.each([
    ['malformed envelope', 'not-json'],
    [
      'authenticated decryption failure',
      encryptKeyedEnvelope(
        'ATCT-runtime-token',
        BITBUCKET_WORKSPACE_ACCESS_TOKEN_ENVELOPE_SCHEME,
        { keyId: 'active', publicKeyPem },
        buildBitbucketWorkspaceAccessTokenAad({
          organizationId,
          integrationId,
          credentialId,
          credentialVersion: 2,
        })
      ),
    ],
  ])('generation-fences encryption_unreadable for %s', async (_case, tokenEncrypted) => {
    const unreadableCandidate = candidate({ tokenEncrypted });
    const store = new StatefulAuthorizationStore(unreadableCandidate);

    await expect(
      service(store).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({ status: 'reconnect_required' });
    expect(store.used).toEqual([]);
    expect(store.invalidations).toEqual([
      {
        fence: fence(unreadableCandidate),
        reason: 'encryption_unreadable',
        at: now.toISOString(),
      },
    ]);
  });

  it.each([
    { providerCredentialType: 'oauth2' },
    { providerScopes: ['account', 'repository'] },
    { providerScopes: ['account', 'repository', 'repository:write'] },
    { providerScopes: ['repository:write', 'account'] },
    { providerVerifiedAt: 'not-a-timestamp' },
    { authInvalidAt: '2026-06-24T09:30:00.000Z' },
    { integrationStatus: 'suspended' },
    { ownedByUserId: 'user-1' },
  ])('fails closed for an unverified or inactive candidate %#', async overrides => {
    const store = new StatefulAuthorizationStore(candidate(overrides));

    await expect(
      service(store).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({ status: 'reconnect_required' });
    expect(store.used).toEqual([]);
    expect(store.invalidations).toEqual([]);
  });

  it('allows an in-flight resolution to finish when a fenced last-use update loses rotation', async () => {
    const original = candidate();
    const store = new StatefulAuthorizationStore(original);
    store.markUsed = async authorizationFence => {
      store.current = candidate({ credentialVersion: original.credentialVersion + 1 });
      return JSON.stringify(authorizationFence) === JSON.stringify(fence(store.current));
    };

    await expect(
      service(store).getAuthorization({ userId: 'member-1', orgId: organizationId })
    ).resolves.toEqual({
      status: 'available',
      token: 'ATCT-runtime-token',
      organizationId,
      integrationId,
      credentialId,
      credentialVersion: original.credentialVersion,
      workspace: { uuid: workspaceUuid, slug: 'acme' },
    });
  });

  it('does not let a stale generation invalidate a rotated credential', async () => {
    const original = candidate();
    const store = new StatefulAuthorizationStore(original);
    const authorization = await service(store).getAuthorization({
      userId: 'member-1',
      orgId: organizationId,
    });
    if (authorization.status !== 'available') throw new Error('Expected authorization');

    store.current = candidate({ credentialVersion: original.credentialVersion + 1 });
    await service(store).invalidateAuthorization(authorization, 'provider_rejected');

    expect(store.invalidations).toEqual([]);
  });
});
