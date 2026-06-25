import { generateKeyPairSync } from 'node:crypto';
import type * as DbClientModule from '@kilocode/db/client';
import { encryptKeyedEnvelope } from '@kilocode/encryption';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  row: undefined as Record<string, unknown> | undefined,
  rows: undefined as Array<Record<string, unknown> | undefined> | undefined,
  updates: [] as Array<Record<string, unknown>>,
  returnedCredential: undefined as Record<string, unknown> | undefined,
  locks: 0,
}));

vi.mock('@kilocode/db/client', async importOriginal => {
  const actual = await importOriginal<typeof DbClientModule>();
  return {
    ...actual,
    getWorkerDb: (connectionString: string) => {
      if (connectionString === 'postgres://query-builder') {
        return actual.getWorkerDb(connectionString);
      }
      const transactionDb = {
        execute: async () => {
          database.locks += 1;
        },
        select: () => ({
          from: () => ({
            where: () => ({}),
            leftJoin: () => ({
              innerJoin: () => ({
                where: () => ({
                  limit: async () => {
                    const row = database.rows ? database.rows.shift() : database.row;
                    return row ? [row] : [];
                  },
                }),
              }),
            }),
          }),
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => {
            database.updates.push(values);
            const result = {
              returning: async () => {
                if (!database.returnedCredential) return [];
                const row = database.row as { credential?: Record<string, unknown> } | undefined;
                if (row) row.credential = database.returnedCredential;
                return [database.returnedCredential];
              },
              then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
            };
            return { where: () => result };
          },
        }),
      };
      return {
        ...transactionDb,
        transaction: async (operation: (tx: typeof transactionDb) => Promise<unknown>) =>
          operation(transactionDb),
      };
    },
  };
});

import { getWorkerDb } from '@kilocode/db/client';
import {
  BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS,
  BitbucketAuthorizationService,
  buildBitbucketAuthorizationQuery,
} from './bitbucket-authorization-service.js';

const scheme = 'bitbucket-oauth-credential-rsa-aes-256-gcm';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

type TestOwner = { type: 'user' | 'org'; id: string };

function aad(kind: 'access' | 'refresh', owner: TestOwner = { type: 'user', id: 'user-1' }) {
  return JSON.stringify({
    scheme,
    version: 1,
    platform: 'bitbucket',
    credentialId: 'credential-1',
    integrationId: 'integration-1',
    owner,
    authorizedByUserId: 'user-1',
    kind,
  });
}

function credential(
  expiresInMs = 60 * 60 * 1000,
  owner: TestOwner = { type: 'user', id: 'user-1' }
) {
  const now = new Date().toISOString();
  return {
    id: 'credential-1',
    platform_integration_id: 'integration-1',
    platform: 'bitbucket',
    authorized_by_user_id: 'user-1',
    provider_subject_id: '123e4567-e89b-12d3-a456-426614174010',
    provider_subject_login: 'bucket-user',
    access_token_encrypted: encryptKeyedEnvelope(
      'access-token',
      scheme,
      { keyId: 'active', publicKeyPem },
      aad('access', owner)
    ),
    access_token_expires_at: new Date(Date.now() + expiresInMs).toISOString(),
    refresh_token_encrypted: encryptKeyedEnvelope(
      'refresh-token',
      scheme,
      { keyId: 'active', publicKeyPem },
      aad('refresh', owner)
    ),
    refresh_token_expires_at: null,
    credential_version: 1,
    revoked_at: null,
    revocation_reason: null,
    last_used_at: null,
    created_at: now,
    updated_at: now,
  };
}

function activeRow(expiresInMs?: number, owner: TestOwner = { type: 'user', id: 'user-1' }) {
  return {
    credential: credential(expiresInMs, owner),
    integrationId: 'integration-1',
    integrationStatus: 'active',
    installationId: '123e4567-e89b-12d3-a456-426614174020',
    accountId: '123e4567-e89b-12d3-a456-426614174020',
    accountLogin: 'acme',
    scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
    metadata: {
      state: 'active',
      workspace: {
        uuid: '123e4567-e89b-12d3-a456-426614174020',
        slug: 'acme',
        name: 'Acme',
      },
    },
  };
}

function service() {
  return new BitbucketAuthorizationService({
    HYPERDRIVE: { connectionString: 'postgres://test' },
    BITBUCKET_CLIENT_ID: 'client-id',
    BITBUCKET_CLIENT_SECRET: 'client-secret',
    BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID: 'active',
    BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY: Buffer.from(publicKeyPem).toString('base64'),
    BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PRIVATE_KEY: Buffer.from(privateKeyPem).toString('base64'),
  } as unknown as CloudflareEnv);
}

describe('BitbucketAuthorizationService', () => {
  it('requires current membership for organization-scoped credentials', () => {
    const db = getWorkerDb('postgres://query-builder');
    const query = buildBitbucketAuthorizationQuery(db, {
      userId: 'member-1',
      orgId: '123e4567-e89b-12d3-a456-426614174030',
    }).toSQL();

    expect(query.sql).toContain('exists (select');
    expect(query.sql).toContain('"organization_memberships"');
    expect(query.sql).toContain('"kilocode_users"."is_admin"');
    expect(query.params).toContain('member-1');
    expect(query.params).toContain('123e4567-e89b-12d3-a456-426614174030');
  });

  beforeEach(() => {
    database.row = activeRow();
    database.rows = undefined;
    database.updates = [];
    database.returnedCredential = undefined;
    database.locks = 0;
    vi.restoreAllMocks();
  });

  it('returns a decrypted token only for an active selected workspace', async () => {
    await expect(service().getAuthorization({ userId: 'user-1' })).resolves.toMatchObject({
      status: 'available',
      token: 'access-token',
      integrationId: 'integration-1',
      workspace: { slug: 'acme' },
    });
  });

  it('requires stored OAuth credentials to include webhook scope', async () => {
    database.row = {
      ...activeRow(),
      scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write'],
    };

    await expect(service().getAuthorization({ userId: 'user-1' })).resolves.toEqual({
      status: 'reconnect_required',
    });
  });

  it('requires stored OAuth credentials to include pull request read scope', async () => {
    database.row = {
      ...activeRow(),
      scopes: ['account', 'email', 'repository', 'repository:write', 'webhook'],
    };

    await expect(service().getAuthorization({ userId: 'user-1' })).resolves.toEqual({
      status: 'reconnect_required',
    });
  });

  it('decrypts organization credentials only with organization-bound AAD', async () => {
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    database.row = activeRow(undefined, { type: 'org', id: orgId });

    await expect(service().getAuthorization({ userId: 'member-1', orgId })).resolves.toMatchObject({
      status: 'available',
      token: 'access-token',
    });
    await expect(service().getAuthorization({ userId: 'user-1' })).resolves.toEqual({
      status: 'reconnect_required',
    });
  });

  it('returns workspace selection state without decrypting credentials', async () => {
    database.row = {
      ...activeRow(),
      integrationStatus: 'pending',
      installationId: null,
      accountId: null,
      accountLogin: null,
      metadata: {
        state: 'workspace_selection_required',
        availableWorkspaces: [activeRow().metadata.workspace],
      },
    };

    await expect(service().getAuthorization({ userId: 'user-1' })).resolves.toEqual({
      status: 'workspace_selection_required',
    });
  });

  it('fails closed when organization access disappears before a credential refresh', async () => {
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    database.rows = [
      activeRow(BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS - 1, { type: 'org', id: orgId }),
      undefined,
    ];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      service().getAuthorization(
        { userId: 'member-1', orgId },
        BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS
      )
    ).resolves.toEqual({ status: 'not_connected' });
    expect(database.locks).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes under a lock and rotates both credential envelopes', async () => {
    database.row = activeRow(BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS - 1);
    const nextCredential = {
      ...credential(2 * 60 * 60 * 1000),
      credential_version: 2,
      access_token_encrypted: encryptKeyedEnvelope(
        'next-access-token',
        scheme,
        { keyId: 'active', publicKeyPem },
        aad('access')
      ),
      refresh_token_encrypted: encryptKeyedEnvelope(
        'next-refresh-token',
        scheme,
        { keyId: 'active', publicKeyPem },
        aad('refresh')
      ),
    };
    database.returnedCredential = nextCredential;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          access_token: 'next-access-token',
          refresh_token: 'next-refresh-token',
          token_type: 'bearer',
          expires_in: 7200,
          scope: 'account repository repository:write pullrequest webhook',
        })
      )
    );

    const result = await service().getAuthorization(
      { userId: 'user-1' },
      BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS
    );

    expect(result).toMatchObject({ status: 'available', token: 'next-access-token' });
    expect(database.locks).toBe(1);
    const rotation = database.updates.find(update => 'access_token_encrypted' in update);
    expect(JSON.parse(String(rotation?.access_token_encrypted))).toMatchObject({
      scheme,
      keyId: 'active',
    });
    expect(JSON.parse(String(rotation?.refresh_token_encrypted))).toMatchObject({
      scheme,
      keyId: 'active',
    });
    expect(fetch).toHaveBeenCalledWith(
      'https://bitbucket.org/site/oauth2/access_token',
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('normalizes Atlassian legacy scope aliases during credential refresh', async () => {
    database.row = activeRow(BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS - 1);
    database.returnedCredential = {
      ...credential(2 * 60 * 60 * 1000),
      credential_version: 2,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          access_token: 'next-access-token',
          refresh_token: 'next-refresh-token',
          token_type: 'bearer',
          expires_in: 7200,
          scope: [
            'read:pullrequest:bitbucket-legacy',
            'pullrequest',
            'offline_access',
            'write:repository:bitbucket-legacy',
            'read:account:bitbucket-legacy',
            'admin:webhook:bitbucket-legacy',
            'read:email:bitbucket-legacy',
            'read:repository:bitbucket-legacy',
            'snippet',
          ].join(' '),
        })
      )
    );

    await expect(
      service().getAuthorization({ userId: 'user-1' }, BITBUCKET_CLOUD_AGENT_MINIMUM_VALIDITY_MS)
    ).resolves.toMatchObject({ status: 'available' });

    expect(database.updates).toContainEqual(
      expect.objectContaining({
        scopes: ['account', 'email', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      })
    );
  });

  it('marks terminal invalid_grant refresh failures as reconnect required', async () => {
    database.row = activeRow(-1);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    );

    await expect(service().getAuthorization({ userId: 'user-1' })).resolves.toEqual({
      status: 'reconnect_required',
    });
    expect(database.updates).toContainEqual(
      expect.objectContaining({ revocation_reason: 'refresh_token_rejected' })
    );
  });
});
