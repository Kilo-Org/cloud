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
  // When set, successive `select().limit()` calls shift from this queue,
  // letting a test model a row that another request rotated between the
  // outer read and the post-lock re-read.
  selectSequence: undefined as Array<Record<string, unknown> | undefined> | undefined,
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
              if (database.selectSequence && database.selectSequence.length > 0) {
                return [database.selectSequence.shift()].filter(Boolean);
              }
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

  it('revokes the current generation when the refresh token is rejected during selection', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    database.rows = [row];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'bad_refresh_token' }))
    );

    const result = await makeService().selectUserAuthorization({
      userId: 'user_1',
      githubRepo: 'acme/repo',
    });

    expect(result).toEqual({ selected: false, reason: 'revoked' });
    expect(database.updates).toHaveLength(1);
    expect(database.updates[0]).toMatchObject({
      revoked_at: expect.any(String),
      revocation_reason: 'github_token_rejected',
    });
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

describe('GitHubUserAuthorizationService.getUserAccessToken', () => {
  beforeEach(() => {
    database.rows = [makeRow()];
    database.updates = [];
    database.updatedRow = undefined;
    database.deleted = false;
    database.deleteWinsRace = true;
    database.rowAfterDelete = undefined;
    database.lockExecutions = 0;
    database.selectSequence = undefined;
    vi.restoreAllMocks();
  });

  it('accepts a concurrent refresh winner instead of failing when the generation moved under the lock', async () => {
    // A rotate arrives with the stale pair (v1). Between the outer read and
    // acquiring the lock, another request already rotated the grant to v2
    // (healthy). The post-lock version mismatch must resolve to the current
    // healthy credential, not a 503.
    const rowV1 = makeRow();
    const rowV2 = { ...makeRow(), credential_version: 2 };
    // reads: outer getUserAccessToken read (v1), post-lock re-read (v2),
    // final reload (v2).
    database.selectSequence = [rowV1, rowV2, rowV2];
    vi.stubGlobal('fetch', vi.fn());

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'rotate',
      staleAuthorizationId: 'authorization_1',
      staleCredentialVersion: 1,
    });

    expect(result).toMatchObject({
      connected: true,
      token: 'access-token',
      authorizationId: 'authorization_1',
      credentialVersion: 2,
    });
    // No OAuth refresh happened (the winner already did it) and nothing was revoked.
    expect(fetch).not.toHaveBeenCalled();
    expect(database.updates).toHaveLength(0);
  });

  it('returns not_connected when no authorization row exists', async () => {
    database.rows = [];
    vi.stubGlobal('fetch', vi.fn());

    const result = await makeService().getUserAccessToken('user_1', { op: 'fetch' });

    expect(result).toEqual({ connected: false, reason: 'not_connected' });
    expect(fetch).not.toHaveBeenCalled();
    expect(database.updates).toHaveLength(0);
  });

  it('returns revoked when the existing row is already revoked', async () => {
    database.rows = [{ ...makeRow(), revoked_at: new Date().toISOString() }];
    vi.stubGlobal('fetch', vi.fn());

    const result = await makeService().getUserAccessToken('user_1', { op: 'fetch' });

    expect(result).toEqual({ connected: false, reason: 'revoked' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns the current credential for fetch without refreshing when outside the buffer', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await makeService().getUserAccessToken('user_1', { op: 'fetch' });

    expect(result).toMatchObject({
      connected: true,
      token: 'access-token',
      githubLogin: 'octocat',
      authorizationId: 'authorization_1',
      credentialVersion: 1,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(database.lockExecutions).toBe(0);
  });

  it('refreshes the credential when fetch finds the access token inside the expiry buffer', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    database.rows = [row];
    const refreshedRow = {
      ...makeRow(activePublicKey, 'active', {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
      }),
      credential_version: 2,
      access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    };
    database.updatedRow = refreshedRow;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          access_token: 'refreshed-access',
          expires_in: 3600,
          refresh_token: 'refreshed-refresh',
          refresh_token_expires_in: 7200,
        })
      )
    );

    const result = await makeService().getUserAccessToken('user_1', { op: 'fetch' });

    expect(result.connected).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({ method: 'POST' })
    );
    expect(database.lockExecutions).toBe(1);
  });

  it('strips multiple trailing slashes from the configured OAuth base URL', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    database.rows = [row];
    const refreshedRow = {
      ...makeRow(activePublicKey, 'active', {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
      }),
      credential_version: 2,
      access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    };
    database.updatedRow = refreshedRow;
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'refreshed-access',
        expires_in: 3600,
        refresh_token: 'refreshed-refresh',
        refresh_token_expires_in: 7200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeService({ GITHUB_OAUTH_BASE_URL: 'https://github.test///' }).getUserAccessToken(
      'user_1',
      { op: 'fetch' }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.test/login/oauth/access_token',
      expect.anything()
    );
  });

  it('honors the GITHUB_OAUTH_BASE_URL env seam for the refresh request', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    database.rows = [row];
    const refreshedRow = {
      ...makeRow(activePublicKey, 'active', {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
      }),
      credential_version: 2,
      access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    };
    database.updatedRow = refreshedRow;
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'refreshed-access',
        expires_in: 3600,
        refresh_token: 'refreshed-refresh',
        refresh_token_expires_in: 7200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await makeService({ GITHUB_OAUTH_BASE_URL: 'https://github.test/' }).getUserAccessToken(
      'user_1',
      { op: 'fetch' }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://github.test/login/oauth/access_token',
      expect.anything()
    );
  });

  it('refreshes with force when rotate matches the current authorization and version', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    database.rows = [row];
    const refreshedRow = {
      ...makeRow(activePublicKey, 'active', {
        access: 'refreshed-access',
        refresh: 'refreshed-refresh',
      }),
      credential_version: 2,
      access_token_expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 7200 * 1000).toISOString(),
    };
    database.updatedRow = refreshedRow;
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'refreshed-access',
        expires_in: 3600,
        refresh_token: 'refreshed-refresh',
        refresh_token_expires_in: 7200,
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'rotate',
      staleAuthorizationId: 'authorization_1',
      staleCredentialVersion: 1,
    });

    expect(result.connected).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(database.lockExecutions).toBe(1);
  });

  it('returns the current credential without refreshing when rotate carries a stale id', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'rotate',
      staleAuthorizationId: 'old_authorization',
      staleCredentialVersion: 1,
    });

    expect(result.connected).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.lockExecutions).toBe(0);
  });

  it('returns the current credential without refreshing when rotate carries a stale credential version', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'rotate',
      staleAuthorizationId: 'authorization_1',
      staleCredentialVersion: 99,
    });

    expect(result.connected).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not touch a fresh credential after a disconnect-then-reconnect rotates the id back to version 1', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const newRow = {
      ...makeRow(),
      id: 'authorization_2',
      credential_version: 1,
    };
    database.rows = [newRow];

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'rotate',
      staleAuthorizationId: 'authorization_1',
      staleCredentialVersion: 7,
    });

    expect(result).toMatchObject({
      connected: true,
      authorizationId: 'authorization_2',
      credentialVersion: 1,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(database.lockExecutions).toBe(0);
  });

  it('revokes the matching generation when reportRejected receives the current id and version', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'reportRejected',
      authorizationId: 'authorization_1',
      credentialVersion: 1,
    });

    expect(result).toEqual({ connected: false, reason: 'revoked' });
    expect(database.updates).toHaveLength(1);
    expect(database.updates[0]).toMatchObject({
      revocation_reason: 'github_token_rejected',
    });
    expect(typeof database.updates[0].revoked_at).toBe('string');
  });

  it('returns the current credential when reportRejected carries a stale id or version', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'reportRejected',
      authorizationId: 'old_authorization',
      credentialVersion: 1,
    });

    expect(result.connected).toBe(true);
    expect(database.updates).toHaveLength(0);
  });

  it('revokes on terminal_rejection when the refresh grant is rejected by GitHub', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    database.rows = [row];
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ error: 'bad_refresh_token' }))
    );

    const result = await makeService().getUserAccessToken('user_1', {
      op: 'rotate',
      staleAuthorizationId: 'authorization_1',
      staleCredentialVersion: 1,
    });

    expect(result).toEqual({ connected: false, reason: 'revoked' });
    expect(database.updates).toHaveLength(1);
    expect(database.updates[0]).toMatchObject({ revocation_reason: 'github_token_rejected' });
  });

  it('does not revoke when the refresh attempt fails transiently', async () => {
    const row = makeRow();
    row.access_token_expires_at = new Date(Date.now() - 1000).toISOString();
    database.rows = [row];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    await expect(makeService().getUserAccessToken('user_1', { op: 'fetch' })).rejects.toThrow(
      'temporarily_unavailable'
    );
    expect(database.updates).toHaveLength(0);
  });
});
