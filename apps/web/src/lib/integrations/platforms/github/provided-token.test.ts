import { generateKeyPairSync } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users, user_github_app_tokens } from '@kilocode/db/schema';
import { createSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete-reasons';
import { insertTestUser as insertFixtureUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { lockGitHubIdentity, lockGitHubIdentityWrites } from '@kilocode/db/github-identity';
import { connectProvidedGitHubToken, ProvidedGitHubTokenInputSchema } from './provided-token';
import {
  getGitHubUserAuthorizationStatus,
  revokeStoredGitHubUserAuthorization,
} from './user-authorization';

const mockKeys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
let mockEncryptionConfigured = true;
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID: 'identity-test',
  get USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY() {
    return mockEncryptionConfigured ? Buffer.from(mockKeys.publicKey).toString('base64') : '';
  },
}));
jest.mock('./user-token-client', () => ({ evictGitHubUserAccessTokenCache: jest.fn() }));

const createdUsers: string[] = [];
async function insertTestUser() {
  const user = await insertFixtureUser();
  createdUsers.push(user.id);
  return user;
}
const sentinel = 'ghp_SENTINELSECRET123456789012345678901234';
const replacement = 'gho_REPLACEMENT12345678901234567890123456';
const absent = { authorizationId: null, credentialVersion: null };

async function current(userId: string) {
  const state = await getGitHubUserAuthorizationStatus(userId);
  return {
    authorizationId: state.authorizationId,
    credentialVersion: state.credentialVersion,
  };
}
async function rows(userId: string) {
  return db
    .select()
    .from(user_github_app_tokens)
    .where(eq(user_github_app_tokens.kilo_user_id, userId));
}

describe('provided personal GitHub identity', () => {
  let request: jest.SpyInstance;
  beforeEach(() => {
    request = jest
      .spyOn(global, 'fetch')
      .mockImplementation(async () => Response.json({ id: 8080, login: 'token-user' }));
  });
  afterEach(async () => {
    mockEncryptionConfigured = true;
    jest.restoreAllMocks();
    const userIds = createdUsers.splice(0);
    if (userIds.length > 0)
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  });

  it.each([
    'ghs_installation',
    'ghu_appuser',
    'ghr_refresh',
    'managed:github',
    'ghp_a b',
    'ghp_a\n',
    'ghp_a\x00',
    'x'.repeat(10001),
  ])('rejects unsupported or malformed input without reflecting it', token => {
    const parsed = ProvidedGitHubTokenInputSchema.safeParse({ token, expected: absent });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.message).toContain('invalid_github_token_request');
    expect(request).not.toHaveBeenCalled();
  });

  it('authenticates only /user, encrypts the credential, and returns metadata with unknown expiry', async () => {
    const user = await insertTestUser();
    const result = await connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent });
    expect(result).toMatchObject({
      status: 'connected',
      credentialSource: 'provided_token',
      expiresAt: null,
    });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'https://api.github.com/user',
      expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) })
    );
    const [row] = await rows(user.id);
    expect(row.access_token_encrypted).not.toContain(sentinel);
    expect(JSON.parse(row.access_token_encrypted)).toMatchObject({
      scheme: 'github-user-token-rsa-aes-256-gcm',
    });
    expect(row.access_token_expires_at).toBeNull();
    expect(row.refresh_token_encrypted).toBeNull();
    expect(row.refresh_token_expires_at).toBeNull();
  });

  it('records reliable expiry metadata', async () => {
    const user = await insertTestUser();
    const expiresAt = new Date(Date.now() + 3600000).toISOString();
    request.mockResolvedValueOnce(
      Response.json(
        { id: 8081, login: 'expiry-user' },
        { headers: { 'GitHub-Authentication-Token-Expiration': expiresAt } }
      )
    );
    await expect(
      connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent })
    ).resolves.toMatchObject({ expiresAt });
  });

  it.each([401, 403, 404, 429, 500, 302])(
    'preserves a working credential after validation HTTP %s and omits provider secrets',
    async status => {
      const user = await insertTestUser();
      await connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent });
      const before = await rows(user.id);
      request.mockResolvedValueOnce(new Response(sentinel, { status }));
      await expect(
        connectProvidedGitHubToken(user.id, {
          token: replacement,
          expected: await current(user.id),
        })
      ).rejects.not.toThrow(sentinel);
      expect(await rows(user.id)).toEqual(before);
    }
  );

  it('rejects oversized and malformed provider responses without storing credentials', async () => {
    const user = await insertTestUser();
    for (const body of [
      sentinel,
      JSON.stringify({ id: 8080, login: 'x', padding: 'x'.repeat(65536) }),
    ]) {
      request.mockResolvedValueOnce(new Response(body));
      await expect(
        connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent })
      ).rejects.toThrow('temporarily_unavailable');
      expect(await rows(user.id)).toHaveLength(0);
    }
  });

  it('serializes competing initial connections and replacements', async () => {
    const user = await insertTestUser();
    const initial = await Promise.allSettled(
      [sentinel, replacement].map(token =>
        connectProvidedGitHubToken(user.id, { token, expected: absent })
      )
    );
    expect(initial.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const expected = await current(user.id);
    const replacements = await Promise.allSettled(
      [sentinel, replacement].map(token => connectProvidedGitHubToken(user.id, { token, expected }))
    );
    expect(replacements.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await rows(user.id))[0].credential_version).toBe(2);
  });

  it('keeps numeric GitHub account ownership exclusive across sources', async () => {
    const first = await insertTestUser();
    const second = await insertTestUser();
    await connectProvidedGitHubToken(first.id, { token: sentinel, expected: absent });
    await expect(
      connectProvidedGitHubToken(second.id, { token: replacement, expected: absent })
    ).resolves.toEqual({ status: 'already_connected_to_another_account' });
    request.mockResolvedValueOnce(Response.json({ id: 999, login: 'another' }));
    await expect(
      connectProvidedGitHubToken(first.id, {
        token: replacement,
        expected: await current(first.id),
      })
    ).resolves.toEqual({ status: 'disconnect_existing_identity_first' });
  });

  it('rejects persistence after token validation pauses across account deletion', async () => {
    const user = await insertTestUser();
    let resume: (response: Response) => void = () => {
      throw new Error('not paused');
    };
    request.mockReturnValueOnce(
      new Promise<Response>(resolve => {
        resume = resolve;
      })
    );
    const pending = connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent });
    await db
      .update(kilocode_users)
      .set({ blocked_reason: createSoftDeletedBlockedReason() })
      .where(eq(kilocode_users.id, user.id));
    resume(Response.json({ id: 8080, login: 'token-user' }));
    await expect(pending).rejects.toThrow('connection_conflict');
    expect(await rows(user.id)).toHaveLength(0);
  });

  it('never locks the Kilo user while an identity writer holds its lock across GitHub calls', async () => {
    const user = await insertTestUser();
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    let acquired: () => void = () => {};
    const locked = new Promise<void>(resolve => {
      acquired = resolve;
    });
    const writer = db.transaction(async tx => {
      await lockGitHubIdentity(tx, user.id, absent);
      acquired();
      await held;
    });
    await locked;
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await tx
          .update(kilocode_users)
          .set({ microdollars_used: 1 })
          .where(eq(kilocode_users.id, user.id));
      });
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
        await tx.select().from(kilocode_users).where(eq(kilocode_users.id, user.id)).for('update');
      });
      // Account cleanup takes the same identity lock and must still wait for the writer.
      await expect(
        db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '200ms'`);
          await lockGitHubIdentityWrites(tx, user.id);
        })
      ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '55P03' }) });
    } finally {
      release();
      await writer;
    }
  });

  it('ignores App revocation events for provided credentials', async () => {
    const user = await insertTestUser();
    await connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent });
    await expect(
      revokeStoredGitHubUserAuthorization('8080', 'standard', 'provider_revoked')
    ).resolves.toBeNull();
    expect((await getGitHubUserAuthorizationStatus(user.id)).connected).toBe(true);
  });

  it('enforces source and refresh constraints in PostgreSQL', async () => {
    const user = await insertTestUser();
    await connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent });
    for (const change of [
      { refresh_token_encrypted: 'impossible' },
      { credential_source: 'github_app' as const },
      { github_app_type: 'lite' as const },
    ]) {
      await expect(
        db
          .update(user_github_app_tokens)
          .set(change)
          .where(and(eq(user_github_app_tokens.kilo_user_id, user.id)))
      ).rejects.toThrow();
    }
  });
  it('omits the sentinel from logs and errors across encryption, conflict, and upstream failures', async () => {
    const logs = [
      jest.spyOn(console, 'error').mockImplementation(() => {}),
      jest.spyOn(console, 'warn').mockImplementation(() => {}),
      jest.spyOn(console, 'log').mockImplementation(() => {}),
    ];
    const user = await insertTestUser();
    await connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent });
    const before = await rows(user.id);
    const failures: unknown[] = [];
    const capture = async (operation: Promise<unknown>) => {
      try {
        await operation;
      } catch (error) {
        failures.push(error);
      }
    };
    await capture(connectProvidedGitHubToken(user.id, { token: sentinel, expected: absent }));
    request.mockRejectedValueOnce(new Error(sentinel));
    await capture(
      connectProvidedGitHubToken(user.id, { token: sentinel, expected: await current(user.id) })
    );
    mockEncryptionConfigured = false;
    await capture(
      connectProvidedGitHubToken(user.id, { token: sentinel, expected: await current(user.id) })
    );
    expect(failures).toHaveLength(3);
    expect(failures.map(error => String(error)).join(' ')).not.toContain(sentinel);
    expect(JSON.stringify(failures)).not.toContain(sentinel);
    expect(JSON.stringify(logs.map(log => log.mock.calls))).not.toContain(sentinel);
    expect(await rows(user.id)).toEqual(before);
  });
});
