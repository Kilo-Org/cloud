import { generateKeyPairSync } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptKeyedEnvelope } from '@kilocode/encryption';

const database = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  updatedRow: undefined as Record<string, unknown> | undefined,
  deleted: false,
  deleteWinsRace: true,
  rowAfterDelete: undefined as Record<string, unknown> | undefined,
  lockExecutions: 0,
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => {
    const transactionDb = {
      execute: async () => {
        database.lockExecutions += 1;
      },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              if (database.deleted && !database.deleteWinsRace) {
                return [database.rowAfterDelete].filter(Boolean);
              }
              return [database.rows[0]].filter(Boolean);
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          database.updates.push(values);
          return {
            where: () => ({
              returning: async () => {
                if (!database.updatedRow) return [];
                database.rows = [database.updatedRow];
                return [database.updatedRow];
              },
              then: undefined,
            }),
          };
        },
      }),
      delete: () => ({
        where: () => ({
          returning: async () => {
            database.deleted = true;
            return database.deleteWinsRace ? [{ id: 'authorization_1' }] : [];
          },
        }),
      }),
    };
    return {
      ...transactionDb,
      transaction: async (operation: (tx: typeof transactionDb) => Promise<unknown>) =>
        operation(transactionDb),
    };
  },
}));

import { GitHubUserAuthorizationService } from './github-user-authorization-service.js';

const scheme = 'github-user-token-rsa-aes-256-gcm';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const activePublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const activePrivateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const retiredPublicKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .publicKey.export({ type: 'spki', format: 'pem' })
  .toString();

function aad(kind: 'access' | 'refresh') {
  return `github-user-authorization:v1:user_1:standard:42:${kind}`;
}

function makeRow(
  publicKeyPem = activePublicKey,
  keyId = 'active',
  tokens: { access: string; refresh: string } = {
    access: 'access-token',
    refresh: 'refresh-token',
  }
) {
  return {
    id: 'authorization_1',
    kilo_user_id: 'user_1',
    github_app_type: 'standard',
    github_user_id: '42',
    github_login: 'octocat',
    access_token_encrypted: encryptKeyedEnvelope(
      tokens.access,
      scheme,
      { keyId, publicKeyPem },
      aad('access')
    ),
    access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    refresh_token_encrypted: encryptKeyedEnvelope(
      tokens.refresh,
      scheme,
      { keyId, publicKeyPem },
      aad('refresh')
    ),
    refresh_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    credential_version: 1,
    revoked_at: null,
    revocation_reason: null,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeService(extra: Record<string, unknown> = {}) {
  return new GitHubUserAuthorizationService({
    HYPERDRIVE: { connectionString: 'postgres://test' },
    USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID: 'active',
    USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY: Buffer.from(activePublicKey).toString('base64'),
    USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY: Buffer.from(activePrivateKey).toString('base64'),
    GITHUB_APP_CLIENT_ID: 'client-id',
    GITHUB_APP_CLIENT_SECRET: 'client-secret',
    ...extra,
  } as unknown as CloudflareEnv);
}

describe('GitHubUserAuthorizationService envelope selection', () => {
  beforeEach(() => {
    database.rows = [makeRow()];
    database.updates = [];
    database.updatedRow = undefined;
    database.deleted = false;
    database.deleteWinsRace = true;
    database.rowAfterDelete = undefined;
    database.lockExecutions = 0;
    vi.restoreAllMocks();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ permissions: { push: true } }))
    );
  });

  it('selects an active-key credential scoped to the authorization and field', async () => {
    const result = await makeService().selectUserAuthorization({
      userId: 'user_1',
      githubRepo: 'acme/repo',
    });

    expect(result).toMatchObject({ selected: true, token: 'access-token' });
  });

  it('rewrites refreshed credentials with the active envelope key', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    database.rows = [row];
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            access_token: 'next-access-token',
            expires_in: 3600,
            refresh_token: 'next-refresh-token',
            refresh_token_expires_in: 7200,
          })
        )
        .mockResolvedValueOnce(Response.json({ permissions: { push: true } }))
    );

    await makeService().selectUserAuthorization({ userId: 'user_1', githubRepo: 'acme/repo' });

    expect(JSON.parse(String(database.updates[0].access_token_encrypted))).toMatchObject({
      scheme,
      keyId: 'active',
    });
    expect(JSON.parse(String(database.updates[0].refresh_token_encrypted))).toMatchObject({
      scheme,
      keyId: 'active',
    });
    expect(database.lockExecutions).toBe(1);
  });

  it('classifies wrong-scope envelope material without exposing crypto details', async () => {
    const row = makeRow();
    row.access_token_encrypted = row.refresh_token_encrypted;
    database.rows = [row];

    await expect(
      makeService().selectUserAuthorization({ userId: 'user_1', githubRepo: 'acme/repo' })
    ).resolves.toEqual({ selected: false, reason: 'credential_unreadable' });
  });

  it('classifies an unknown envelope key id as unreadable', async () => {
    database.rows = [makeRow(retiredPublicKey, 'retired')];

    await expect(
      makeService().selectUserAuthorization({ userId: 'user_1', githubRepo: 'acme/repo' })
    ).resolves.toEqual({ selected: false, reason: 'credential_unreadable' });
  });

  it('classifies missing private-key configuration separately', async () => {
    await expect(
      makeService({ USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY: undefined }).selectUserAuthorization({
        userId: 'user_1',
        githubRepo: 'acme/repo',
      })
    ).resolves.toEqual({ selected: false, reason: 'credential_configuration_error' });
  });

  it('classifies a non-RSA private key as configuration error', async () => {
    const ecKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      type: 'pkcs8',
      format: 'pem',
    });

    await expect(
      makeService({
        USER_GITHUB_APP_TOKEN_ACTIVE_PRIVATE_KEY: Buffer.from(ecKey).toString('base64'),
      }).selectUserAuthorization({
        userId: 'user_1',
        githubRepo: 'acme/repo',
      })
    ).resolves.toEqual({ selected: false, reason: 'credential_configuration_error' });
  });
});

describe('GitHubUserAuthorizationService disconnect', () => {
  beforeEach(() => {
    database.rows = [makeRow()];
    database.updates = [];
    database.updatedRow = undefined;
    database.deleted = false;
    database.deleteWinsRace = true;
    database.rowAfterDelete = undefined;
    database.lockExecutions = 0;
    vi.restoreAllMocks();
  });

  it('is idempotent when the local authorization is absent', async () => {
    database.rows = [];
    vi.stubGlobal('fetch', vi.fn());

    await makeService().disconnectUserAuthorization('user_1');

    expect(fetch).not.toHaveBeenCalled();
    expect(database.deleted).toBe(false);
  });

  it('deletes an authorization already marked revoked without calling GitHub', async () => {
    database.rows = [{ ...makeRow(), revoked_at: new Date().toISOString() }];
    vi.stubGlobal('fetch', vi.fn());

    await makeService().disconnectUserAuthorization('user_1');

    expect(fetch).not.toHaveBeenCalled();
    expect(database.deleted).toBe(true);
  });

  it('treats remote 404 as revoked and deletes the current credential generation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));

    await makeService().disconnectUserAuthorization('user_1');

    expect(database.lockExecutions).toBe(1);
    expect(database.deleted).toBe(true);
  });

  it('identifies grant revocation requests with the GitHub user agent', async () => {
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', request);

    await makeService().disconnectUserAuthorization('user_1');

    expect(request).toHaveBeenCalledWith(
      'https://api.github.com/applications/client-id/grant',
      expect.objectContaining({
        headers: expect.objectContaining({ 'User-Agent': 'Kilo-Git-Token-Service' }),
      })
    );
  });

  it('deletes an authorization after its access and refresh tokens expire', async () => {
    database.rows = [
      {
        ...makeRow(),
        access_token_expires_at: new Date(Date.now() - 2000).toISOString(),
        refresh_token_expires_at: new Date(Date.now() - 1000).toISOString(),
      },
    ];
    vi.stubGlobal('fetch', vi.fn());

    await makeService().disconnectUserAuthorization('user_1');

    expect(fetch).not.toHaveBeenCalled();
    expect(database.deleted).toBe(true);
  });

  it('deletes an expired authorization when GitHub rejects its refresh token', async () => {
    database.rows = [
      { ...makeRow(), access_token_expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'bad_refresh_token' }))
    );

    await makeService().disconnectUserAuthorization('user_1');

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(database.deleted).toBe(true);
  });

  it('persists refreshed credentials before revoking an expired grant', async () => {
    database.rows = [
      { ...makeRow(), access_token_expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    database.updatedRow = {
      ...makeRow(activePublicKey, 'active', {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
      }),
      credential_version: 2,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'refreshed-access',
          expires_in: 3600,
          refresh_token: 'refreshed-refresh',
          refresh_token_expires_in: 7200,
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', request);

    await makeService().disconnectUserAuthorization('user_1');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ body: JSON.stringify({ access_token: 'refreshed-access' }) })
    );
    expect(database.lockExecutions).toBe(2);
    expect(JSON.parse(String(database.updates[0].access_token_encrypted))).toMatchObject({
      scheme,
      keyId: 'active',
    });
    expect(JSON.parse(String(database.updates[0].refresh_token_encrypted))).toMatchObject({
      scheme,
      keyId: 'active',
    });
    expect(database.deleted).toBe(true);
  });

  it('retains the refreshed credential generation when subsequent revocation fails', async () => {
    database.rows = [
      { ...makeRow(), access_token_expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    database.updatedRow = {
      ...makeRow(activePublicKey, 'active', {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
      }),
      credential_version: 2,
    };
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            access_token: 'refreshed-access',
            expires_in: 3600,
            refresh_token: 'refreshed-refresh',
            refresh_token_expires_in: 7200,
          })
        )
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
    );

    await expect(makeService().disconnectUserAuthorization('user_1')).rejects.toThrow(
      'GitHub authorization revocation failed'
    );
    expect(database.updates).toHaveLength(1);
    expect(database.rows[0]?.credential_version).toBe(2);
    expect(database.lockExecutions).toBe(2);
    expect(database.deleted).toBe(false);
  });

  it('retains the row when refresh for an expired credential fails', async () => {
    database.rows = [
      { ...makeRow(), access_token_expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(makeService().disconnectUserAuthorization('user_1')).rejects.toThrow(
      'could not be revoked'
    );
    expect(database.deleted).toBe(false);
  });

  it('retains an unexpired authorization after its refresh token expires', async () => {
    database.rows = [
      { ...makeRow(), refresh_token_expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 422 }));
    vi.stubGlobal('fetch', request);

    await expect(makeService().disconnectUserAuthorization('user_1')).rejects.toThrow(
      'could not be revoked'
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(database.deleted).toBe(false);
  });

  it('retains the row when rejected revocation is followed by transient refresh failure', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', request);

    await expect(makeService().disconnectUserAuthorization('user_1')).rejects.toThrow(
      'could not be revoked'
    );
    expect(request).toHaveBeenCalledTimes(2);
    expect(database.deleted).toBe(false);
  });

  it('does not revoke after reconnect wins the refresh persistence race', async () => {
    database.rows = [
      { ...makeRow(), access_token_expires_at: new Date(Date.now() - 1000).toISOString() },
    ];
    const request = vi.fn().mockResolvedValueOnce(
      Response.json({
        access_token: 'refreshed-access',
        expires_in: 3600,
        refresh_token: 'refreshed-refresh',
        refresh_token_expires_in: 7200,
      })
    );
    vi.stubGlobal('fetch', request);

    await expect(makeService().disconnectUserAuthorization('user_1')).rejects.toThrow(
      'changed during disconnect'
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(database.deleted).toBe(false);
  });

  it('returns successfully when another delete removes the already revoked row', async () => {
    database.deleteWinsRace = false;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(makeService().disconnectUserAuthorization('user_1')).resolves.toBeUndefined();
  });

  it('retains the row when the conditional delete loses a reconnect race', async () => {
    database.deleteWinsRace = false;
    database.rowAfterDelete = { ...makeRow(), credential_version: 2 };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })));

    await expect(makeService().disconnectUserAuthorization('user_1')).rejects.toThrow(
      'changed during disconnect'
    );
  });

  it('retains the row when remote revocation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(makeService().disconnectUserAuthorization('user_1')).rejects.toThrow(
      'GitHub authorization revocation failed'
    );
    expect(database.deleted).toBe(false);
  });
});
