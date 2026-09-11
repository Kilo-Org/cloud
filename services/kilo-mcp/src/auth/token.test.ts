import { describe, expect, it, vi } from 'vitest';
import { handleToken, ACCESS_TOKEN_TTL_SECONDS } from './token';
import { decodeJwt } from './jwt';
import { codeChallengeFromVerifier, generateCodeVerifier } from './pkce';
import type { McpAnalytics, OAuthSignInInput } from '../analytics';
import type {
  NewRefreshToken,
  NewOAuthCode,
  OAuthCodeRecord,
  OAuthStoreApi,
  RefreshTokenRecord,
  StoredClient,
} from '../store/oauth-store';

/**
 * In-memory OAuthStoreApi for these endpoint tests. Methods these tests never
 * reach throw, so a new handler dependency fails loudly instead of silently.
 */
function createFakeOAuthStore(): OAuthStoreApi & {
  clients: Map<string, StoredClient>;
  codes: Map<string, OAuthCodeRecord>;
  refreshTokens: Map<string, RefreshTokenRecord>;
  barrierRotations: (count?: number) => void;
  releaseRotations: () => void;
} {
  const clients = new Map<string, StoredClient>();
  const codes = new Map<string, OAuthCodeRecord>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  let rotateBarrier = Promise.resolve();
  let arriveAtBarrier: () => void = () => {};
  let releaseRotations: (() => void) | null = null;
  const unused = (): never => {
    throw new Error('not reachable from these tests');
  };
  const revokeGrant = async (
    grant: {
      clientId: string;
      kiloUserId: string;
      organizationId: string | null;
      resource: string;
    },
    nowIso: string
  ): Promise<number> => {
    let revoked = 0;
    for (const [hash, record] of refreshTokens) {
      if (
        record.clientId === grant.clientId &&
        record.kiloUserId === grant.kiloUserId &&
        record.resource === grant.resource &&
        (record.organizationId ?? null) === grant.organizationId &&
        record.revokedAt === null &&
        record.expiresAt > nowIso
      ) {
        refreshTokens.set(hash, { ...record, revokedAt: nowIso });
        revoked += 1;
      }
    }
    return revoked;
  };
  return {
    clients,
    codes,
    refreshTokens,
    barrierRotations: (count = 2) => {
      let remaining = count;
      rotateBarrier = new Promise(resolve => {
        releaseRotations = resolve;
      });
      arriveAtBarrier = () => {
        remaining -= 1;
        if (remaining <= 0) releaseRotations?.();
      };
    },
    releaseRotations: () => releaseRotations?.(),
    registerClient: unused,
    async getClient(clientId) {
      const client = clients.get(clientId);
      return client ? { ...client, redirectUris: [...client.redirectUris] } : null;
    },
    async createCode(input: NewOAuthCode) {
      codes.set(input.code, {
        ...input,
        status: 'pending',
        kiloUserId: null,
        organizationId: null,
        kiloToken: null,
      });
    },
    async getCode(code) {
      const record = codes.get(code);
      return record ? { ...record } : null;
    },
    async recordPairingApproval(deviceAuthCode, identity, nowIso) {
      for (const [code, record] of codes) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.kiloUserId === null &&
          record.expiresAt > nowIso
        ) {
          codes.set(code, {
            ...record,
            kiloUserId: identity.kiloUserId,
            kiloToken: identity.kiloToken,
          });
          return true;
        }
      }
      return false;
    },
    denyCode: unused,
    markCodeExpired: unused,
    createPendingAuthorization: unused,
    getPendingAuthorization: unused,
    denyPendingAuthorization: unused,
    expirePendingAuthorization: unused,
    approvePendingAuthorization: unused,
    completePendingAuthorization: unused,
    async approveCode(deviceAuthCode, identity, nowIso) {
      for (const [code, record] of codes) {
        if (
          record.deviceAuthCode === deviceAuthCode &&
          record.status === 'pending' &&
          record.expiresAt > nowIso
        ) {
          codes.set(code, {
            ...record,
            status: 'approved',
            kiloUserId: identity.kiloUserId,
            organizationId: identity.organizationId,
          });
          return true;
        }
      }
      return false;
    },
    async consumeCode(code, nowIso) {
      const record = codes.get(code);
      if (!record || record.status !== 'approved' || record.expiresAt <= nowIso) return null;
      const used: OAuthCodeRecord = { ...record, status: 'used' };
      codes.set(code, used);
      return { ...used };
    },
    async saveRefreshToken(input: NewRefreshToken) {
      refreshTokens.set(input.tokenHash, { ...input, revokedAt: null });
    },
    async getRefreshTokenByHash(tokenHash) {
      const record = refreshTokens.get(tokenHash);
      return record ? { ...record } : null;
    },
    async rotateRefreshToken(oldId, input, nowIso) {
      arriveAtBarrier();
      await rotateBarrier;
      const old = [...refreshTokens.values()].find(record => record.id === oldId);
      if (!old) return 'missing';
      if (old.revokedAt !== null) {
        await revokeGrant(
          {
            clientId: old.clientId,
            kiloUserId: old.kiloUserId,
            organizationId: old.organizationId,
            resource: old.resource,
          },
          nowIso
        );
        return 'replayed';
      }
      if (old.expiresAt <= nowIso) return 'missing';
      refreshTokens.set(old.tokenHash, { ...old, revokedAt: nowIso });
      refreshTokens.set(input.tokenHash, { ...input, revokedAt: null });
      return 'rotated';
    },
    revokeGrant,
    revokeJti: unused,
    async isJtiRevoked() {
      return false;
    },
    async getKiloToken(identity) {
      const live = [...refreshTokens.values()]
        .filter(
          record =>
            record.kiloUserId === identity.kiloUserId &&
            record.clientId === identity.clientId &&
            record.resource === identity.resource &&
            (record.organizationId ?? null) === identity.organizationId &&
            record.revokedAt === null &&
            record.kiloToken !== null
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return live[0]?.kiloToken ?? null;
    },
    purgeExpired: unused,
  };
}

const SECRET = 'token-test-secret-32-bytes-here!!';
const ISSUER = 'https://kilo-mcp.test';
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT_ID = 'client-abc';
const REDIRECT = 'https://client.test/cb';
const NOW = new Date('2026-09-09T12:00:00.000Z');

const verifier = generateCodeVerifier();

function storeWithClient(): ReturnType<typeof createFakeOAuthStore> {
  const store = createFakeOAuthStore();
  store.clients.set(CLIENT_ID, {
    clientId: CLIENT_ID,
    redirectUris: [REDIRECT],
    clientName: 'Test Client',
    createdAt: NOW.toISOString(),
  });
  return store;
}

async function seedApprovedCode(
  store: OAuthStoreApi,
  overrides: {
    challenge?: string;
    expiresAt?: string;
    status?: 'pending' | 'approved' | 'used' | 'denied';
    /** Set to null to model a record whose pairing approval never landed. */
    kiloToken?: string | null;
  } = {}
): Promise<string> {
  const code = 'test-authorization-code-value-0000000000000000000000';
  await store.createCode({
    code,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT,
    codeChallenge: overrides.challenge ?? (await codeChallengeFromVerifier(verifier)),
    resource: RESOURCE,
    scope: 'mcp',
    state: null,
    deviceAuthCode: 'PAIR-1',
    createdAt: NOW.toISOString(),
    expiresAt: overrides.expiresAt ?? new Date(NOW.getTime() + 600_000).toISOString(),
  });
  // s6 order: the pairing approval (Kilo token) lands first, then the org
  // picker approves the code with the chosen organization.
  if (overrides.kiloToken !== null) {
    await store.recordPairingApproval(
      'PAIR-1',
      { kiloUserId: 'kilo-user-1', kiloToken: overrides.kiloToken ?? 'kilo-token-1' },
      NOW.toISOString()
    );
  }
  if ((overrides.status ?? 'approved') === 'approved') {
    await store.approveCode(
      'PAIR-1',
      { kiloUserId: 'kilo-user-1', organizationId: 'org-1' },
      NOW.toISOString()
    );
  } else if (overrides.status === 'used') {
    await store.approveCode(
      'PAIR-1',
      { kiloUserId: 'kilo-user-1', organizationId: 'org-1' },
      NOW.toISOString()
    );
    await store.consumeCode(code, NOW.toISOString());
  }
  return code;
}

function tokenRequest(form: Record<string, string>): Request {
  return new Request(`${ISSUER}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

/**
 * Fake emitter cast to the production `McpAnalytics` interface: the tests
 * assert exactly what the worker hands it, so a new field cannot slip past.
 */
function fakeAnalytics(): { analytics: McpAnalytics; calls: OAuthSignInInput[] } {
  const calls: OAuthSignInInput[] = [];
  const analytics = {
    oauthSignIn: vi.fn((input: OAuthSignInInput) => {
      calls.push(input);
    }),
  } as unknown as McpAnalytics;
  return { analytics, calls };
}

const OAUTH_EVENT_FIELDS = ['clientId', 'identity', 'phase', 'reason'];
const IDENTITY_FIELDS = ['kiloUserId', 'organizationId'];

/**
 * The sign-in events must carry no token, authorization code, PKCE verifier,
 * or state: every recorded event exposes only the documented fields.
 */
function expectNoCredentialLeak(calls: OAuthSignInInput[]): void {
  for (const call of calls) {
    for (const key of Object.keys(call)) {
      expect(OAUTH_EVENT_FIELDS).toContain(key);
    }
    if (call.identity) {
      for (const key of Object.keys(call.identity)) {
        expect(IDENTITY_FIELDS).toContain(key);
      }
    }
  }
}

function handle(form: Record<string, string>, store: OAuthStoreApi, analytics?: McpAnalytics) {
  return handleToken(tokenRequest(form), {
    store,
    tokenSecret: SECRET,
    issuer: ISSUER,
    now: () => NOW,
    analytics,
  });
}

/** Shape of the /token JSON responses asserted below. */
type TokenBody = {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

describe('POST /token authorization_code (happy)', () => {
  it('exchanges the code and issues tokens bound to user + org + this MCP (requirement 18)', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: RESOURCE,
      },
      store
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const body = (await response.json()) as TokenBody;
    expect(body.token_type).toBe('Bearer');
    expect(body.scope).toBe('mcp');
    expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(typeof body.refresh_token).toBe('string');

    const decoded = decodeJwt(body.access_token!);
    expect(decoded).not.toBeNull();
    expect(decoded!.payload).toEqual({
      iss: ISSUER,
      sub: 'kilo-user-1',
      org: 'org-1',
      aud: RESOURCE,
      client_id: CLIENT_ID,
      exp: Math.floor(NOW.getTime() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
      jti: expect.any(String),
    });

    // The refresh token is stored only as a hash.
    expect(store.refreshTokens.has(body.refresh_token!)).toBe(false);
    const stored = [...store.refreshTokens.values()][0];
    expect(stored.kiloUserId).toBe('kilo-user-1');
    expect(stored.tokenHash).not.toBe(body.refresh_token);
    expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // s6: the grant carries the Kilo credential the worker forwards with.
    expect(stored.kiloToken).toBe('kilo-token-1');
  });

  it('a code whose pairing approval never landed is refused (no forwardable identity)', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store, { kiloToken: null });
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as TokenBody;
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/missing its Kilo session/);
    // The code stays exchangeable-pending: nothing was consumed or stored.
    expect(store.codes.get(code)!.status).toBe('approved');
    expect(store.refreshTokens.size).toBe(0);
  });

  it('marks the code used', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    expect(store.codes.get(code)!.status).toBe('used');
  });
});

describe('POST /token authorization_code (retryable unhappy)', () => {
  it('a used code gets invalid_grant telling the client to start a new authorization', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store, { status: 'used' });
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as TokenBody;
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/already been used/);
  });

  it('an expired code gets invalid_grant with a retry hint', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    // approveCode refuses expired codes, so model the reachable state
    // directly: approved while alive, then expired before redemption.
    store.codes.set(code, {
      ...store.codes.get(code)!,
      expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    });
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    const body = (await response.json()) as TokenBody;
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/expired/);
  });

  it('a not-yet-approved (pending) code gets invalid_grant to poll after approval', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store, { status: 'pending' });
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    const body = (await response.json()) as TokenBody;
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/not completed sign-in/);
  });
});

describe('POST /token authorization_code (non-retryable unhappy)', () => {
  it('a wrong PKCE verifier gets an explicit error and no token', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: generateCodeVerifier(),
      },
      store
    );
    const body = (await response.json()) as TokenBody;
    expect(response.status).toBe(400);
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/PKCE/);
    expect(store.codes.get(code)!.status).toBe('approved');
  });

  it('a wrong redirect_uri gets invalid_grant', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: 'https://client.test/other',
        code_verifier: verifier,
      },
      store
    );
    const body = (await response.json()) as TokenBody;
    expect(body.error).toBe('invalid_grant');
    expect(body.error_description).toMatch(/redirect_uri/);
  });

  it('a wrong resource indicator gets invalid_target', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
        resource: 'https://attacker.test/mcp',
      },
      store
    );
    const body = (await response.json()) as TokenBody;
    expect(body.error).toBe('invalid_target');
  });

  it('an unknown client_id gets invalid_client', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: 'ghost',
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_client');
  });

  it('a code issued to another client cannot be redeemed', async () => {
    const store = storeWithClient();
    store.clients.set('other', {
      clientId: 'other',
      redirectUris: [REDIRECT],
      clientName: 'Other',
      createdAt: NOW.toISOString(),
    });
    const code = await seedApprovedCode(store);
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: 'other',
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_grant');
  });

  it('a denied code gets invalid_grant', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    store.codes.set(code, { ...store.codes.get(code)!, status: 'denied' });
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_grant');
  });
});

describe('POST /token grant plumbing', () => {
  it('missing parameters get invalid_request', async () => {
    const store = storeWithClient();
    const response = await handle({ grant_type: 'authorization_code', code: 'x' }, store);
    expect(((await response.json()) as TokenBody).error).toBe('invalid_request');
  });

  it('an unsupported grant type gets unsupported_grant_type', async () => {
    const store = storeWithClient();
    const response = await handle({ grant_type: 'password', username: 'u' }, store);
    expect(((await response.json()) as TokenBody).error).toBe('unsupported_grant_type');
  });

  it('a non-form body gets invalid_request', async () => {
    const store = storeWithClient();
    const response = await handleToken(
      new Request(`${ISSUER}/token`, { method: 'POST', body: 'garbage not urlencoded' }),
      { store, tokenSecret: SECRET, issuer: ISSUER, now: () => NOW }
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_request');
  });
});

describe('POST /token refresh_token (rotation)', () => {
  async function seedRefresh(store: OAuthStoreApi): Promise<string> {
    const refreshToken = 'opaque-refresh-token-value-0000000000000000000000000000';
    await store.saveRefreshToken({
      id: 'rt-1',
      tokenHash: await sha256HexTest(refreshToken),
      clientId: CLIENT_ID,
      kiloUserId: 'kilo-user-1',
      organizationId: 'org-1',
      kiloToken: 'kilo-token-1',
      resource: RESOURCE,
      scope: 'mcp',
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600_000).toISOString(),
    });
    return refreshToken;
  }

  it('rotates the refresh token and mints a new bound access token', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    const response = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as TokenBody;
    expect(body.refresh_token).not.toBe(refreshToken);
    const decoded = decodeJwt(body.access_token!)!;
    expect(decoded.payload).toMatchObject({
      sub: 'kilo-user-1',
      org: 'org-1',
      aud: RESOURCE,
      client_id: CLIENT_ID,
    });

    // old token revoked, new one stored
    const oldHash = await sha256HexTest(refreshToken);
    expect([...store.refreshTokens.values()].find(r => r.tokenHash === oldHash)!.revokedAt).toBe(
      NOW.toISOString()
    );
    // s6: the forwarding credential survives rotation.
    const rotated = [...store.refreshTokens.values()].find(r => r.tokenHash !== oldHash)!;
    expect(rotated.kiloToken).toBe('kilo-token-1');
  });

  it('the old refresh token is rejected after rotation', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    const response = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as TokenBody).error).toBe('invalid_grant');
  });

  it('a replayed rotated-away token revokes the whole grant (RFC 9700 §2.2.2)', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    const first = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    const stolenToken = ((await first.json()) as TokenBody).refresh_token!;

    // The thief replays the rotated-away original: the grant's newest rotation
    // (held by the legitimate client) must be revoked along with it.
    const replay = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as TokenBody).error).toBe('invalid_grant');
    const stolenHash = await sha256HexTest(stolenToken);
    expect(
      [...store.refreshTokens.values()].find(record => record.tokenHash === stolenHash)!.revokedAt
    ).toBe(NOW.toISOString());

    // The stolen newest token no longer refreshes either.
    const thief = await handle(
      { grant_type: 'refresh_token', refresh_token: stolenToken, client_id: CLIENT_ID },
      store
    );
    expect(((await thief.json()) as TokenBody).error).toBe('invalid_grant');
  });

  it('a refresh that loses a concurrent rotation revokes the winner and its credential', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    store.barrierRotations(2);

    // Both exchanges read the same live row, then park just before rotating.
    const first = handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    const second = handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    const responses = await Promise.all([first, second]);
    const winner = responses.find(response => response.status === 200)!;
    const loser = responses.find(response => response.status === 400)!;
    expect(loser).toBeDefined();

    const replacement = ((await winner.json()) as TokenBody).refresh_token!;
    expect(((await loser.json()) as TokenBody).error).toBe('invalid_grant');

    // The losing exchange revoked the winner's replacement in the same call.
    const replacementHash = await sha256HexTest(replacement);
    expect(
      [...store.refreshTokens.values()].find(record => record.tokenHash === replacementHash)!
        .revokedAt
    ).toBe(NOW.toISOString());
    expect(
      await store.getKiloToken(
        {
          kiloUserId: 'kilo-user-1',
          clientId: CLIENT_ID,
          organizationId: 'org-1',
          resource: RESOURCE,
        },
        NOW.toISOString()
      )
    ).toBeNull();
  });

  it('a replayed rotated-away token leaves the user grants of other orgs live', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    // The user also granted this client a token scoped to another org.
    await store.saveRefreshToken({
      id: 'rt-sibling',
      tokenHash: await sha256HexTest('sibling-refresh-token-value'),
      clientId: CLIENT_ID,
      kiloUserId: 'kilo-user-1',
      organizationId: 'org-2',
      kiloToken: 'kilo-token-1',
      resource: RESOURCE,
      scope: 'mcp',
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600_000).toISOString(),
    });

    const replay = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    expect(((await replay.json()) as TokenBody).error).toBe('invalid_grant');
    const siblingHash = await sha256HexTest('sibling-refresh-token-value');
    expect(
      [...store.refreshTokens.values()].find(record => record.tokenHash === siblingHash)!.revokedAt
    ).toBeNull();
  });

  it('an unknown refresh token gets invalid_grant', async () => {
    const store = storeWithClient();
    const response = await handle(
      { grant_type: 'refresh_token', refresh_token: 'never-issued', client_id: CLIENT_ID },
      store
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_grant');
  });

  it('a refresh token presented by another registered client gets invalid_grant', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    store.clients.set('other-client', {
      clientId: 'other-client',
      redirectUris: [REDIRECT],
      clientName: 'Other',
      createdAt: NOW.toISOString(),
    });
    const response = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: 'other-client' },
      store
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_grant');
  });

  it('an expired refresh token gets invalid_grant', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    const hash = await sha256HexTest(refreshToken);
    store.refreshTokens.set(hash, {
      ...store.refreshTokens.get(hash)!,
      expiresAt: new Date(NOW.getTime() - 1).toISOString(),
    });
    const response = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_grant');
  });

  it('a wrong resource indicator during refresh gets invalid_target', async () => {
    const store = storeWithClient();
    const refreshToken = await seedRefresh(store);
    const response = await handle(
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        resource: 'https://other.test/mcp',
      },
      store
    );
    expect(((await response.json()) as TokenBody).error).toBe('invalid_target');
  });
});

describe('POST /token analytics (s3)', () => {
  it('emits succeeded bound to the kilo user and organization for a completed exchange', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    const { analytics, calls } = fakeAnalytics();
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store,
      analytics
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      {
        phase: 'succeeded',
        identity: { kiloUserId: 'kilo-user-1', organizationId: 'org-1' },
        clientId: CLIENT_ID,
      },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('emits failed/invalid_grant and leaves the error body readable for the client', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store, { status: 'used' });
    const { analytics, calls } = fakeAnalytics();
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store,
      analytics
    );
    expect(response.status).toBe(400);
    // The analytics read used a clone, so the client still gets the body.
    await expect(response.json()).resolves.toMatchObject({ error: 'invalid_grant' });
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: CLIENT_ID, reason: 'invalid_grant' },
    ]);
    expectNoCredentialLeak(calls);
  });

  it('emits failed/invalid_client for an unknown client', async () => {
    const store = storeWithClient();
    const code = await seedApprovedCode(store);
    const { analytics, calls } = fakeAnalytics();
    const response = await handle(
      {
        grant_type: 'authorization_code',
        code,
        client_id: 'ghost',
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      },
      store,
      analytics
    );
    expect(response.status).toBe(400);
    expect(calls).toEqual([
      { phase: 'failed', identity: null, clientId: 'ghost', reason: 'invalid_client' },
    ]);
  });

  it('emits nothing for refresh_token outcomes (success or failure)', async () => {
    const store = storeWithClient();
    const { analytics, calls } = fakeAnalytics();
    const refreshToken = 'opaque-refresh-token-value-0000000000000000000000000000';
    await store.saveRefreshToken({
      id: 'rt-analytics',
      tokenHash: await sha256HexTest(refreshToken),
      clientId: CLIENT_ID,
      kiloUserId: 'kilo-user-1',
      organizationId: 'org-1',
      kiloToken: 'kilo-token-1',
      resource: RESOURCE,
      scope: 'mcp',
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600_000).toISOString(),
    });
    const rotated = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store,
      analytics
    );
    expect(rotated.status).toBe(200);
    // Replaying the rotated-away token is an invalid_grant, not a sign-in.
    const replay = await handle(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID },
      store,
      analytics
    );
    expect(replay.status).toBe(400);
    expect(calls).toEqual([]);
  });
});

async function sha256HexTest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
