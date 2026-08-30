import { generateKeyPairSync } from 'node:crypto';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  organization_memberships,
  platform_integrations,
  platform_oauth_credentials,
  type PlatformIntegration,
  type PlatformOAuthCredential,
} from '@kilocode/db/schema';
import {
  BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  BitbucketIntegrationAuthorizationError,
  BitbucketIntegrationConnectionConflictError,
  BitbucketIntegrationRecoveryError,
  buildBitbucketOAuthCredentialAad,
  getBitbucketOAuthRecovery,
  storeBitbucketIntegration,
  type StoreBitbucketIntegrationInput,
} from './credentials';

jest.mock('@/lib/drizzle', () => ({ db: { transaction: jest.fn(), select: jest.fn() } }));
jest.mock('@/lib/config.server', () => ({
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_KEY_ID() {
    return 'recovery-test-key';
  },
  get BITBUCKET_OAUTH_CREDENTIAL_ACTIVE_PUBLIC_KEY() {
    return mockPublicKey;
  },
}));

const keyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
let mockPublicKey = Buffer.from(keyPair.publicKey).toString('base64');
const dialect = new PgDialect();
const owner = { type: 'org', id: '77777777-7777-4777-8777-777777777777' } as const;
const actor = 'oauth/manager';
const recovery = {
  integrationId: '33333333-3333-4333-8333-333333333333',
  credentialId: '44444444-4444-4444-8444-444444444444',
  credentialVersion: 2,
  workspaceUuid: 'workspace-one',
  workspaceSlug: 'workspace-one',
};
const ownerLock = `bitbucket-oauth-owner:org:${owner.id}`;
const credentialLock = `bitbucket-oauth-credential:${recovery.credentialId}`;

type Stored = {
  integration: PlatformIntegration | undefined;
  credential: PlatformOAuthCredential | undefined;
};
let stored: Stored;
let authorizerExists: boolean;
let isAdmin: boolean;
let membershipExists: boolean;
let failUpdate: 'credential' | 'integration' | undefined;
let requiredLocks: string[];

function input(): StoreBitbucketIntegrationInput {
  return {
    owner,
    authorizedByUserId: actor,
    bitbucketRecovery: { ...recovery },
    bitbucketUser: { uuid: '{new-bot}', nickname: 'new-bot' },
    tokens: {
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      tokenType: 'bearer',
      expiresIn: 3600,
      scopes: ['account', 'pullrequest:write', 'webhook'],
    },
    availableWorkspaces: [
      { uuid: '{other-workspace}', slug: 'other-workspace', name: 'Other' },
      { uuid: '{WORKSPACE-ONE}', slug: 'workspace-one', name: 'Renamed provider label' },
    ],
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPublicKey = Buffer.from(keyPair.publicKey).toString('base64');
  authorizerExists = true;
  isAdmin = false;
  membershipExists = true;
  failUpdate = undefined;
  requiredLocks = [ownerLock, credentialLock];
  stored = {
    integration: {
      id: recovery.integrationId,
      owned_by_organization_id: owner.id,
      owned_by_user_id: null,
      platform: 'bitbucket',
      integration_type: 'oauth',
      integration_status: 'active',
      platform_installation_id: recovery.workspaceUuid,
      platform_account_id: recovery.workspaceUuid,
      platform_account_login: recovery.workspaceSlug,
      metadata: {
        state: 'active',
        workspace: {
          uuid: recovery.workspaceUuid,
          slug: recovery.workspaceSlug,
          name: 'Original workspace',
        },
      },
      scopes: ['account', 'pullrequest', 'repository:write', 'webhook'],
      repositories: [
        { id: 'repository-one', name: 'mobile', full_name: 'workspace-one/mobile', private: true },
      ],
      repositories_synced_at: '2026-08-30 09:00:00+00',
    } as PlatformIntegration,
    credential: {
      id: recovery.credentialId,
      platform_integration_id: recovery.integrationId,
      authorized_by_user_id: actor,
      provider_subject_id: 'old-bot',
      provider_subject_login: 'old-bot',
      access_token_encrypted: 'old-access-envelope',
      refresh_token_encrypted: 'old-refresh-envelope',
      credential_version: recovery.credentialVersion,
      revoked_at: null,
      revocation_reason: null,
    } as PlatformOAuthCredential,
  };

  jest.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          innerJoin: () => ({
            where: (condition: SQL) => ({
              limit: async () => {
                const query = dialect.sqlToQuery(condition);
                expect(query.sql).toContain('"owned_by_organization_id"');
                expect(query.params).toEqual(expect.arrayContaining([owner.id, 'bitbucket']));
                return stored.integration &&
                  stored.credential &&
                  query.params.includes(stored.integration.id)
                  ? [{ integration: stored.integration, credential: stored.credential }]
                  : [];
              },
            }),
          }),
        }),
      }) as never
  );

  // Stage writes separately so the test observes commit and rollback, not just calls.
  jest.mocked(db.transaction).mockImplementation(async callback => {
    const before = structuredClone(stored);
    const staged = structuredClone(stored);
    const locks = new Set<string>();
    const rowLocks = new Set<unknown>();
    const tx = {
      execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        expect(query.sql).toContain('pg_advisory_xact_lock');
        for (const value of query.params) if (typeof value === 'string') locks.add(value);
      },
      select: () => ({
        from: (table: unknown) => ({
          where: (condition: SQL) => ({
            for: async (lock: string) => {
              expect(lock).toBe('update');
              for (const key of requiredLocks) expect(locks.has(key)).toBe(true);
              rowLocks.add(table);
              const query = dialect.sqlToQuery(condition);
              if (table === kilocode_users) {
                expect(query.sql).toContain('"blocked_reason" is null');
                expect(query.params).toContain(actor);
                return authorizerExists ? [{ isAdmin }] : [];
              }
              if (table === organization_memberships) {
                expect(query.params).toEqual(
                  expect.arrayContaining([owner.id, actor, 'owner', 'billing_manager'])
                );
                return membershipExists ? [{ id: 'membership' }] : [];
              }
              if (table === platform_integrations) {
                expect(query.sql).toContain('"owned_by_organization_id"');
                expect(query.params).toEqual(expect.arrayContaining([owner.id, 'bitbucket']));
                return staged.integration ? [staged.integration] : [];
              }
              if (table === platform_oauth_credentials) {
                expect(query.params).toContain(recovery.integrationId);
                return staged.credential ? [staged.credential] : [];
              }
              throw new Error('Unexpected table');
            },
          }),
        }),
      }),
      update: (table: unknown) => ({
        set: (values: object) => ({
          where: (condition: SQL) => ({
            returning: async () => {
              expect(rowLocks.has(table)).toBe(true);
              expect(stored).toEqual(before);
              const query = dialect.sqlToQuery(condition);
              if (table === platform_oauth_credentials) {
                expect(query.params).toEqual(
                  expect.arrayContaining([
                    recovery.credentialId,
                    recovery.integrationId,
                    recovery.credentialVersion,
                  ])
                );
                if (failUpdate === 'credential') throw new Error('Credential write failed');
                staged.credential = { ...staged.credential, ...values } as PlatformOAuthCredential;
                return [{ id: staged.credential.id }];
              }
              if (table === platform_integrations) {
                expect(query.params).toContain(recovery.integrationId);
                if (failUpdate === 'integration') throw new Error('Integration write failed');
                staged.integration = { ...staged.integration, ...values } as PlatformIntegration;
                return [{ id: staged.integration.id }];
              }
              throw new Error('Unexpected update');
            },
          }),
        }),
      }),
    };
    const result = await callback(tx as never);
    stored = staged;
    return result;
  });
});

describe('Bitbucket OAuth recovery transaction', () => {
  it('derives recovery from the exact owned connection', async () => {
    await expect(getBitbucketOAuthRecovery(owner, recovery.integrationId)).resolves.toEqual(
      recovery
    );
    await expect(
      getBitbucketOAuthRecovery(owner, '55555555-5555-4555-8555-555555555555')
    ).rejects.toThrow(BitbucketIntegrationRecoveryError);
  });

  it('atomically replaces encrypted credentials while preserving the selected workspace and cache', async () => {
    const before = structuredClone(stored);
    const result = await storeBitbucketIntegration(input());
    expect(result).toEqual({ status: 'connected', integrationId: recovery.integrationId });
    expect(stored.integration).toMatchObject({
      id: recovery.integrationId,
      metadata: before.integration?.metadata,
      platform_account_id: recovery.workspaceUuid,
      platform_account_login: recovery.workspaceSlug,
      repositories: before.integration?.repositories,
      repositories_synced_at: before.integration?.repositories_synced_at,
      scopes: input().tokens.scopes,
    });
    expect(stored.credential).toMatchObject({
      id: recovery.credentialId,
      credential_version: recovery.credentialVersion + 1,
      provider_subject_id: 'new-bot',
      provider_subject_login: 'new-bot',
    });
    for (const kind of ['access', 'refresh'] as const) {
      const envelope = stored.credential?.[`${kind}_token_encrypted`];
      expect(
        decryptKeyedEnvelope(
          envelope ?? '',
          BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
          { active: { keyId: 'recovery-test-key', privateKeyPem: keyPair.privateKey } },
          buildBitbucketOAuthCredentialAad({
            credentialId: recovery.credentialId,
            integrationId: recovery.integrationId,
            owner,
            authorizedByUserId: actor,
            kind,
          })
        )
      ).toBe(`new-${kind}-token`);
    }
  });

  it.each(['credential', 'integration'] as const)(
    'rolls back both rows when the %s write fails',
    async table => {
      failUpdate = table;
      const before = structuredClone(stored);
      await expect(storeBitbucketIntegration(input())).rejects.toThrow('write failed');
      expect(stored).toEqual(before);
    }
  );

  it('rejects replay after a successful replacement without undoing that replacement', async () => {
    await storeBitbucketIntegration(input());
    const replaced = structuredClone(stored);
    await expect(storeBitbucketIntegration(input())).rejects.toThrow(
      BitbucketIntegrationRecoveryError
    );
    expect(stored).toEqual(replaced);
  });

  it.each([
    [
      'disconnected',
      (value: Stored) => {
        value.integration = undefined;
      },
    ],
    [
      'missing credential',
      (value: Stored) => {
        value.credential = undefined;
      },
    ],
    [
      'different integration',
      (value: Stored) => {
        if (value.integration) value.integration.id = '55555555-5555-4555-8555-555555555555';
      },
    ],
    [
      'different method',
      (value: Stored) => {
        if (value.integration) value.integration.integration_type = 'workspace_access_token';
      },
    ],
    [
      'inactive integration',
      (value: Stored) => {
        if (value.integration) value.integration.integration_status = 'suspended';
      },
    ],
    [
      'different workspace UUID',
      (value: Stored) => {
        if (value.integration) value.integration.platform_account_id = 'workspace-other';
      },
    ],
    [
      'different workspace slug',
      (value: Stored) => {
        if (value.integration) value.integration.platform_account_login = 'workspace-other';
      },
    ],
    [
      'changed metadata',
      (value: Stored) => {
        if (value.integration)
          value.integration.metadata = {
            state: 'workspace_selection_required',
            availableWorkspaces: [],
          };
      },
    ],
    [
      'different credential',
      (value: Stored) => {
        if (value.credential) value.credential.id = '66666666-6666-4666-8666-666666666666';
      },
    ],
    [
      'newer credential',
      (value: Stored) => {
        if (value.credential) value.credential.credential_version += 1;
      },
    ],
    [
      'revoked credential',
      (value: Stored) => {
        if (value.credential) value.credential.revoked_at = '2026-08-30 09:00:00+00';
      },
    ],
  ] as const)('retains all current data when recovery is stale: %s', async (_, change) => {
    change(stored);
    const before = structuredClone(stored);
    await expect(storeBitbucketIntegration(input())).rejects.toThrow(
      BitbucketIntegrationRecoveryError
    );
    expect(stored).toEqual(before);
  });

  it.each([
    { reason: 'no workspaces', availableWorkspaces: [] },
    {
      reason: 'different UUID',
      availableWorkspaces: [
        { uuid: '{workspace-other}', slug: 'workspace-one', name: 'Wrong UUID' },
      ],
    },
    {
      reason: 'different slug',
      availableWorkspaces: [
        { uuid: '{workspace-one}', slug: 'workspace-other', name: 'Wrong slug' },
      ],
    },
  ])(
    'does not select another workspace when recovery has $reason',
    async ({ availableWorkspaces }) => {
      const before = structuredClone(stored);
      await expect(
        storeBitbucketIntegration({ ...input(), availableWorkspaces })
      ).rejects.toMatchObject({ code: 'workspace_unavailable' });
      expect(stored).toEqual(before);
    }
  );

  it.each([
    { missing: 'write grants', scopes: ['account', 'repository:write', 'pullrequest', 'webhook'] },
    { missing: 'account grants', scopes: ['pullrequest:write', 'webhook'] },
    { missing: 'webhook grants', scopes: ['account', 'pullrequest:write'] },
  ])('retains read credentials when recovery lacks $missing', async ({ scopes }) => {
    const before = structuredClone(stored);
    const replacement = input();
    replacement.tokens.scopes = scopes;
    await expect(storeBitbucketIntegration(replacement)).rejects.toMatchObject({
      code: 'missing_scopes',
    });
    expect(stored).toEqual(before);
  });

  it.each(['authorizer', 'membership'] as const)(
    'rechecks current %s access inside the transaction',
    async missing => {
      authorizerExists = missing !== 'authorizer';
      membershipExists = missing !== 'membership';
      const before = structuredClone(stored);
      await expect(storeBitbucketIntegration(input())).rejects.toThrow(
        BitbucketIntegrationAuthorizationError
      );
      expect(stored).toEqual(before);
    }
  );

  it('permits a current platform admin without organization membership', async () => {
    isAdmin = true;
    membershipExists = false;
    await expect(storeBitbucketIntegration(input())).resolves.toEqual({
      status: 'connected',
      integrationId: recovery.integrationId,
    });
    expect(stored.credential?.credential_version).toBe(3);
  });

  it('rejects a personal owner mismatch before persisting credentials', async () => {
    const before = structuredClone(stored);
    await expect(
      storeBitbucketIntegration({ ...input(), owner: { type: 'user', id: 'oauth/someone-else' } })
    ).rejects.toThrow(BitbucketIntegrationAuthorizationError);
    expect(stored).toEqual(before);
  });

  it('retains the old connection when encryption is unavailable', async () => {
    mockPublicKey = '';
    const before = structuredClone(stored);
    await expect(storeBitbucketIntegration(input())).rejects.toThrow(
      'encryption is not configured'
    );
    expect(stored).toEqual(before);
  });

  it('keeps the legacy first-connect conflict instead of replacing an existing connection', async () => {
    requiredLocks = [ownerLock];
    const before = structuredClone(stored);
    await expect(
      storeBitbucketIntegration({ ...input(), bitbucketRecovery: undefined })
    ).rejects.toThrow(BitbucketIntegrationConnectionConflictError);
    expect(stored).toEqual(before);
  });
});
