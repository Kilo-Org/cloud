/* eslint-disable drizzle/enforce-delete-with-where */
import { generateKeyPairSync } from 'node:crypto';
import { decryptKeyedEnvelope } from '@kilocode/encryption';
import { db } from '@/lib/drizzle';
import type { Owner } from '@/lib/integrations/core/types';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  platform_integrations,
  platform_oauth_credentials,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
  BitbucketIntegrationConnectionConflictError,
  BitbucketIntegrationRecoveryError,
  getBitbucketOAuthRecovery,
  buildBitbucketOAuthCredentialAad,
  storeBitbucketIntegration,
} from './credentials';

const testKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const mockBitbucketCredentialEncryptionConfig = {
  keyId: 'bitbucket-credential-key-v1',
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

function integrationInput(
  owner: Owner,
  authorizedByUserId: string,
  suffix = 'new'
): Parameters<typeof storeBitbucketIntegration>[0] {
  return {
    owner,
    authorizedByUserId,
    bitbucketUser: { uuid: `{bitbucket-user-${suffix}}`, nickname: `bucket-${suffix}` },
    tokens: {
      accessToken: `access-token-${suffix}`,
      refreshToken: `refresh-token-${suffix}`,
      tokenType: 'bearer',
      expiresIn: 3600,
      scopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
    },
    availableWorkspaces: [
      {
        uuid: `{workspace-${suffix}}`,
        slug: `workspace-${suffix}`,
        name: `Workspace ${suffix}`,
      },
    ],
  };
}

async function insertExistingBitbucketIntegration(kiloUserId: string) {
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_user_id: kiloUserId,
      created_by_user_id: kiloUserId,
      platform: 'bitbucket',
      integration_type: 'oauth',
      platform_installation_id: 'workspace-old',
      platform_account_id: 'workspace-old',
      platform_account_login: 'workspace-old',
      scopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      repository_access: 'all',
      integration_status: 'active',
      metadata: {
        state: 'active',
        workspace: { uuid: 'workspace-old', slug: 'workspace-old', name: 'Workspace Old' },
      },
    })
    .returning();
  if (!integration) throw new Error('Expected existing Bitbucket integration');

  const [credential] = await db
    .insert(platform_oauth_credentials)
    .values({
      platform_integration_id: integration.id,
      authorized_by_user_id: kiloUserId,
      provider_subject_id: 'bitbucket-user-old',
      provider_subject_login: 'bucket-old',
      access_token_encrypted: 'old-access-envelope',
      access_token_expires_at: '2030-01-01T00:00:00.000Z',
      refresh_token_encrypted: 'old-refresh-envelope',
    })
    .returning();
  if (!credential) throw new Error('Expected existing Bitbucket credential');

  return { integration, credential };
}

async function readStoredIntegration(integrationId: string) {
  const [integration] = await db
    .select()
    .from(platform_integrations)
    .where(eq(platform_integrations.id, integrationId));
  const [credential] = await db
    .select()
    .from(platform_oauth_credentials)
    .where(eq(platform_oauth_credentials.platform_integration_id, integrationId));
  return { integration, credential };
}

async function recoveryFixture() {
  const user = await insertTestUser();
  const owner = { type: 'user', id: user.id } as const;
  const { integration } = await insertExistingBitbucketIntegration(user.id);
  await db
    .update(platform_integrations)
    .set({
      repositories: [
        {
          id: '88888888-8888-4888-8888-888888888888',
          name: 'mobile',
          full_name: 'workspace-old/mobile',
          private: true,
        },
      ],
      repositories_synced_at: '2026-08-30T09:00:00.000Z',
    })
    .where(eq(platform_integrations.id, integration.id));
  const replacement = integrationInput(owner, user.id);
  replacement.bitbucketRecovery = await getBitbucketOAuthRecovery(owner, integration.id);
  replacement.tokens.scopes.push('pullrequest:write');
  replacement.availableWorkspaces = [
    { uuid: '{workspace-other}', slug: 'workspace-other', name: 'Other Workspace' },
    { uuid: '{WORKSPACE-OLD}', slug: 'workspace-old', name: 'Changed display name' },
  ];
  return {
    user,
    owner,
    replacement,
    before: await readStoredIntegration(integration.id),
    integrationId: integration.id,
  };
}

describe('Bitbucket OAuth credential storage', () => {
  beforeEach(() => {
    mockBitbucketCredentialEncryptionConfig.keyId = 'bitbucket-credential-key-v1';
    mockBitbucketCredentialEncryptionConfig.publicKey = Buffer.from(testKeyPair.publicKey).toString(
      'base64'
    );
  });

  afterEach(async () => {
    await db.delete(platform_oauth_credentials);
    await db.delete(platform_integrations);
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it('automatically activates an integration with one available workspace', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user', id: user.id } as const;
    const accessToken = 'bitbucket-access-token-plaintext';
    const refreshToken = 'bitbucket-refresh-token-plaintext';

    const result = await storeBitbucketIntegration({
      ...integrationInput(owner, user.id),
      bitbucketUser: { uuid: '{BITBUCKET-USER-UUID}', nickname: 'octobucket' },
      tokens: {
        accessToken,
        refreshToken,
        tokenType: 'bearer',
        expiresIn: 3600,
        scopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
      },
      availableWorkspaces: [
        { uuid: '{WORKSPACE-UUID}', slug: 'kilo-workspace', name: 'Kilo Workspace' },
      ],
    });

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, result.integrationId));
    const [credential] = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.platform_integration_id, result.integrationId));
    if (!integration || !credential || !credential.access_token_expires_at) {
      throw new Error('Expected complete Bitbucket integration');
    }

    expect(result.status).toBe('connected');
    expect(integration).toEqual(
      expect.objectContaining({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        created_by_user_id: user.id,
        platform: 'bitbucket',
        platform_installation_id: 'workspace-uuid',
        platform_account_id: 'workspace-uuid',
        platform_account_login: 'kilo-workspace',
        integration_status: 'active',
        metadata: {
          state: 'active',
          workspace: { uuid: 'workspace-uuid', slug: 'kilo-workspace', name: 'Kilo Workspace' },
        },
      })
    );
    expect(credential).toEqual(
      expect.objectContaining({
        authorized_by_user_id: user.id,
        provider_subject_id: 'bitbucket-user-uuid',
        provider_subject_login: 'octobucket',
        credential_version: 1,
      })
    );
    expect(new Date(credential.access_token_expires_at).toISOString()).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
    expect(JSON.stringify({ integration, credential })).not.toContain(accessToken);
    expect(JSON.stringify({ integration, credential })).not.toContain(refreshToken);

    const accessAad = buildBitbucketOAuthCredentialAad({
      credentialId: credential.id,
      integrationId: integration.id,
      owner,
      authorizedByUserId: user.id,
      kind: 'access',
    });
    const privateKeys = {
      active: {
        keyId: mockBitbucketCredentialEncryptionConfig.keyId,
        privateKeyPem: testKeyPair.privateKey,
      },
    };
    expect(
      decryptKeyedEnvelope(
        credential.access_token_encrypted,
        BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        privateKeys,
        accessAad
      )
    ).toBe(accessToken);
    expect(() =>
      decryptKeyedEnvelope(
        credential.access_token_encrypted,
        BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
        privateKeys,
        buildBitbucketOAuthCredentialAad({
          credentialId: credential.id,
          integrationId: integration.id,
          owner: { type: 'org', id: crypto.randomUUID() },
          authorizedByUserId: user.id,
          kind: 'access',
        })
      )
    ).toThrow();
  });

  it('keeps multiple available workspaces pending for explicit selection', async () => {
    const user = await insertTestUser();
    const owner = { type: 'user', id: user.id } as const;
    const input = integrationInput(owner, user.id);
    input.availableWorkspaces.push({
      uuid: '{workspace-second}',
      slug: 'workspace-second',
      name: 'Workspace Second',
    });

    const result = await storeBitbucketIntegration(input);

    const [integration] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, result.integrationId));

    expect(result.status).toBe('workspace_selection_required');
    expect(integration).toEqual(
      expect.objectContaining({
        platform_installation_id: null,
        platform_account_id: null,
        platform_account_login: null,
        integration_status: 'pending',
        metadata: {
          state: 'workspace_selection_required',
          availableWorkspaces: [
            { uuid: 'workspace-new', slug: 'workspace-new', name: 'Workspace new' },
            {
              uuid: 'workspace-second',
              slug: 'workspace-second',
              name: 'Workspace Second',
            },
          ],
        },
      })
    );
  });

  it.each([
    ['missing', ''],
    ['invalid', Buffer.from('not-an-rsa-public-key').toString('base64')],
    ['decrypt-capable', Buffer.from(testKeyPair.privateKey).toString('base64')],
  ])('keeps the existing integration when encryption configuration is %s', async (_, publicKey) => {
    const user = await insertTestUser();
    const existing = await insertExistingBitbucketIntegration(user.id);
    mockBitbucketCredentialEncryptionConfig.publicKey = publicKey;

    await expect(
      storeBitbucketIntegration(integrationInput({ type: 'user', id: user.id }, user.id))
    ).rejects.toThrow();

    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_user_id, user.id))
    ).resolves.toEqual([existing.integration]);
    await expect(
      db
        .select()
        .from(platform_oauth_credentials)
        .where(eq(platform_oauth_credentials.authorized_by_user_id, user.id))
    ).resolves.toEqual([existing.credential]);
  });

  it("does not replace the caller's owned integration without disconnecting first", async () => {
    const user = await insertTestUser();
    const existing = await insertExistingBitbucketIntegration(user.id);

    await expect(
      storeBitbucketIntegration(integrationInput({ type: 'user', id: user.id }, user.id))
    ).rejects.toThrow(BitbucketIntegrationConnectionConflictError);

    const integrations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, user.id));
    const credentials = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.authorized_by_user_id, user.id));

    expect(integrations).toHaveLength(1);
    expect(credentials).toHaveLength(1);
    expect(integrations[0]?.id).toBe(existing.integration.id);
    expect(credentials[0]?.id).toBe(existing.credential.id);
  });

  it('preserves organization credentials when recovery authorization was revoked', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Revoked Callback Org', user.id, 0);
    const owner = { type: 'org', id: organization.id } as const;
    const original = integrationInput(owner, user.id, 'existing');
    const existing = await storeBitbucketIntegration(original);
    const replacement = {
      ...original,
      tokens: {
        ...original.tokens,
        accessToken: 'replacement-access',
        refreshToken: 'replacement-refresh',
        scopes: [...original.tokens.scopes, 'pullrequest:write'],
      },
      bitbucketRecovery: await getBitbucketOAuthRecovery(owner, existing.integrationId),
    };
    const before = await readStoredIntegration(existing.integrationId);

    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, organization.id),
          eq(organization_memberships.kilo_user_id, user.id)
        )
      );

    await expect(storeBitbucketIntegration(replacement)).rejects.toThrow('no longer authorized');
    expect(await readStoredIntegration(existing.integrationId)).toEqual(before);
  });

  it('rechecks current platform-admin access inside the storage transaction', async () => {
    const admin = await insertTestUser();
    const organizationOwner = await insertTestUser();
    const organization = await createTestOrganization(
      'Platform Admin Callback Org',
      organizationOwner.id,
      0
    );
    const owner = { type: 'org', id: organization.id } as const;
    await db.update(kilocode_users).set({ is_admin: true }).where(eq(kilocode_users.id, admin.id));

    const existing = await storeBitbucketIntegration(
      integrationInput(owner, admin.id, 'admin-existing')
    );
    await db.update(kilocode_users).set({ is_admin: false }).where(eq(kilocode_users.id, admin.id));

    await expect(
      storeBitbucketIntegration(integrationInput(owner, admin.id, 'admin-replacement'))
    ).rejects.toThrow('no longer authorized');
    await expect(
      db
        .select({ id: platform_integrations.id })
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organization.id))
    ).resolves.toEqual([{ id: existing.integrationId }]);
  });

  it('recovers write grants without changing integration identity, workspace, or cached repositories', async () => {
    const fixture = await recoveryFixture();
    const result = await storeBitbucketIntegration(fixture.replacement);
    const after = await readStoredIntegration(fixture.integrationId);
    expect(result).toEqual({ status: 'connected', integrationId: fixture.integrationId });
    expect(after.integration).toEqual({
      ...fixture.before.integration,
      scopes: fixture.replacement.tokens.scopes,
      updated_at: after.integration?.updated_at,
    });
    expect(after.credential).toMatchObject({
      id: fixture.before.credential?.id,
      platform_integration_id: fixture.integrationId,
      credential_version: 2,
      provider_subject_login: fixture.replacement.bitbucketUser.nickname,
    });
    if (!after.credential) throw new Error('Expected recovered credential');
    for (const kind of ['access', 'refresh'] as const) {
      expect(
        decryptKeyedEnvelope(
          after.credential[`${kind}_token_encrypted`] ?? '',
          BITBUCKET_OAUTH_CREDENTIAL_ENVELOPE_SCHEME,
          {
            active: {
              keyId: mockBitbucketCredentialEncryptionConfig.keyId,
              privateKeyPem: testKeyPair.privateKey,
            },
          },
          buildBitbucketOAuthCredentialAad({
            credentialId: after.credential.id,
            integrationId: fixture.integrationId,
            owner: fixture.owner,
            authorizedByUserId: fixture.user.id,
            kind,
          })
        )
      ).toBe(fixture.replacement.tokens[kind === 'access' ? 'accessToken' : 'refreshToken']);
    }
  });

  it('rolls back a credential update when the following integration write fails', async () => {
    const fixture = await recoveryFixture();
    const transaction = db.transaction.bind(db);
    const transactionSpy = jest.spyOn(db, 'transaction').mockImplementation(callback =>
      transaction(async tx => {
        const update = tx.update.bind(tx);
        const failIntegrationUpdate: typeof tx.update = table => {
          if (table === platform_integrations) throw new Error('forced integration write failure');
          return update(table);
        };
        jest.spyOn(tx, 'update').mockImplementation(failIntegrationUpdate);
        return callback(tx);
      })
    );
    try {
      await expect(storeBitbucketIntegration(fixture.replacement)).rejects.toThrow(
        'forced integration write failure'
      );
    } finally {
      transactionSpy.mockRestore();
    }
    expect(await readStoredIntegration(fixture.integrationId)).toEqual(fixture.before);
  });

  it.each(['workspace', 'credential revision', 'disconnection'])(
    'rejects recovery after a changed %s without modifying current rows',
    async change => {
      const fixture = await recoveryFixture();
      if (change === 'workspace') {
        await db
          .update(platform_integrations)
          .set({
            platform_account_id: 'changed-workspace',
            platform_installation_id: 'changed-workspace',
            platform_account_login: 'changed-workspace',
            metadata: {
              state: 'active',
              workspace: {
                uuid: 'changed-workspace',
                slug: 'changed-workspace',
                name: 'Changed Workspace',
              },
            },
          })
          .where(eq(platform_integrations.id, fixture.integrationId));
      } else if (change === 'credential revision') {
        await db
          .update(platform_oauth_credentials)
          .set({ credential_version: 2 })
          .where(eq(platform_oauth_credentials.platform_integration_id, fixture.integrationId));
      } else {
        await db
          .delete(platform_integrations)
          .where(eq(platform_integrations.id, fixture.integrationId));
      }
      const current = await readStoredIntegration(fixture.integrationId);
      await expect(storeBitbucketIntegration(fixture.replacement)).rejects.toThrow(
        BitbucketIntegrationRecoveryError
      );
      expect(await readStoredIntegration(fixture.integrationId)).toEqual(current);
    }
  );

  it.each(['workspace', 'write grants'])(
    'retains credentials and cache when recovery lacks %s',
    async missing => {
      const fixture = await recoveryFixture();
      if (missing === 'workspace') fixture.replacement.availableWorkspaces = [];
      else
        fixture.replacement.tokens.scopes = [
          'account',
          'repository:write',
          'pullrequest',
          'webhook',
        ];
      await expect(storeBitbucketIntegration(fixture.replacement)).rejects.toMatchObject({
        code: missing === 'workspace' ? 'workspace_unavailable' : 'missing_scopes',
      });
      expect(await readStoredIntegration(fixture.integrationId)).toEqual(fixture.before);
    }
  );

  it('rejects a recovery target from a different owner without changing either connection', async () => {
    const first = await recoveryFixture();
    const second = await recoveryFixture();
    await expect(getBitbucketOAuthRecovery(second.owner, first.integrationId)).rejects.toThrow(
      BitbucketIntegrationRecoveryError
    );
    await expect(
      storeBitbucketIntegration({
        ...second.replacement,
        bitbucketRecovery: first.replacement.bitbucketRecovery,
      })
    ).rejects.toThrow(BitbucketIntegrationRecoveryError);
    expect(await readStoredIntegration(first.integrationId)).toEqual(first.before);
    expect(await readStoredIntegration(second.integrationId)).toEqual(second.before);
  });

  it('rechecks a blocked personal authorizer inside recovery persistence', async () => {
    const fixture = await recoveryFixture();
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'blocked during OAuth recovery' })
      .where(eq(kilocode_users.id, fixture.user.id));
    await expect(storeBitbucketIntegration(fixture.replacement)).rejects.toThrow(
      'no longer authorized'
    );
    expect(await readStoredIntegration(fixture.integrationId)).toEqual(fixture.before);
  });

  it('allows only one commit for competing callbacks with the same signed recovery revision', async () => {
    const fixture = await recoveryFixture();
    const results = await Promise.allSettled([
      storeBitbucketIntegration(fixture.replacement),
      storeBitbucketIntegration(fixture.replacement),
    ]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    const after = await readStoredIntegration(fixture.integrationId);
    expect(after.credential?.credential_version).toBe(2);
    expect(after.integration?.metadata).toEqual(fixture.before.integration?.metadata);
    expect(after.integration?.repositories).toEqual(fixture.before.integration?.repositories);
    expect(after.integration?.repositories_synced_at).toEqual(
      fixture.before.integration?.repositories_synced_at
    );
  });

  it('allows one Bitbucket identity to authorize personal and organization integrations', async () => {
    const user = await insertTestUser();
    const firstOrganization = await createTestOrganization('First Org', user.id, 0);
    const secondOrganization = await createTestOrganization('Second Org', user.id, 0);
    const owners: Owner[] = [
      { type: 'user', id: user.id },
      { type: 'org', id: firstOrganization.id },
      { type: 'org', id: secondOrganization.id },
    ];

    for (const owner of owners) {
      await storeBitbucketIntegration(integrationInput(owner, user.id, 'shared-identity'));
    }

    const credentials = await db
      .select()
      .from(platform_oauth_credentials)
      .where(eq(platform_oauth_credentials.provider_subject_id, 'bitbucket-user-shared-identity'));
    const integrations = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform, 'bitbucket'));

    expect(credentials).toHaveLength(3);
    expect(integrations).toHaveLength(3);
    expect(new Set(credentials.map(credential => credential.platform_integration_id)).size).toBe(3);
  });
});
